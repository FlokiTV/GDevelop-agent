// @flow
import optionalRequire from '../Utils/OptionalRequire';
import {
  createNewResource,
  allResourceKindsAndMetadata,
  type ResourceManagementProps,
} from '../ResourcesList/ResourceSource';
import {
  applyResourceDefaults,
  copyAllToProjectFolder,
  getResourceFilePathStatus,
  isURL,
  renameResourcesInProject,
} from '../ResourcesList/ResourceUtils';

const gd: libGDevelop = global.gd;
const fs = optionalRequire('fs');
const path = optionalRequire('path');

export const DEFAULT_MAX_LOCAL_RESOURCE_FILE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_TEXT_RESOURCE_BYTES = 4 * 1024 * 1024;
export const AGENT_RESOURCE_PROVENANCE_METADATA_KEY =
  'agentIntegrationProvenance';

type AssetToolsOptions = {|
  project: gdProject,
  resourceManagementProps: ResourceManagementProps,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  maxLocalFileBytes?: number,
|};

type LocalFileDetails = {|
  isLocalFile: boolean,
  fullPath: string | null,
  exists: boolean | null,
  insideProjectFolder: boolean | null,
|};

const getProjectFolder = (project: gdProject): string | null => {
  if (!path) return null;
  const projectFile = project.getProjectFile();
  return projectFile ? path.dirname(projectFile) : null;
};

const isPathInside = (parentPath: string, candidatePath: string): boolean => {
  if (!path) return false;
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

const resolveExistingPath = (filePath: string): string => {
  if (!fs) return filePath;
  try {
    return fs.realpathSync(filePath);
  } catch (error) {
    return filePath;
  }
};

const getLocalFileDetails = (
  project: gdProject,
  resource: gdResource
): LocalFileDetails => {
  if (!path || !resource.useFile()) {
    return {
      isLocalFile: false,
      fullPath: null,
      exists: null,
      insideProjectFolder: null,
    };
  }

  const file = resource.getFile();
  if (!file || isURL(file)) {
    return {
      isLocalFile: false,
      fullPath: null,
      exists: null,
      insideProjectFolder: null,
    };
  }

  const projectFolder = getProjectFolder(project);
  if (!projectFolder && !path.isAbsolute(file)) {
    return {
      isLocalFile: true,
      fullPath: null,
      exists: null,
      insideProjectFolder: null,
    };
  }

  const fullPath = path.resolve(projectFolder || '', file);
  const exists = fs ? fs.existsSync(fullPath) : null;
  let insideProjectFolder = null;
  if (projectFolder) {
    insideProjectFolder = isPathInside(
      resolveExistingPath(projectFolder),
      resolveExistingPath(fullPath)
    );
  }

  return {
    isLocalFile: true,
    fullPath,
    exists,
    insideProjectFolder,
  };
};

export const inferResourceKind = (filePath: string): string | null => {
  if (!path) return null;
  const extension = path
    .extname(filePath)
    .replace(/^\./, '')
    .toLowerCase();
  if (!extension) return null;

  const matches = allResourceKindsAndMetadata.filter(metadata =>
    metadata.fileExtensions.includes(extension)
  );
  if (matches.length === 1) return matches[0].kind;
  // JSON can represent several specialized resources. Default to generic JSON
  // unless the caller explicitly asks for another kind.
  if (extension === 'json') return 'json';
  return matches.length ? matches[0].kind : null;
};

const getUsedResourceNames = (project: gdProject): Set<string> => {
  const resourcesManager = project.getResourcesManager();
  const resourcesInUse = new gd.ResourcesInUseHelper(resourcesManager);
  gd.ResourceExposer.exposeWholeProjectResources(project, resourcesInUse);
  const names = new Set(
    resourcesInUse
      .getAllResources()
      .toJSArray()
      .filter(
        resourceName =>
          typeof resourceName === 'string' && resourceName.trim().length > 0
      )
  );
  resourcesInUse.delete();
  return names;
};

const getObjectNamesUsingResource = (
  project: gdProject,
  resourceName: string
): Array<string> => {
  const resourcesManager = project.getResourcesManager();
  const objectsCollector = new gd.ObjectsUsingResourceCollector(
    resourcesManager,
    resourceName
  );
  gd.ProjectBrowserHelper.exposeProjectObjects(project, objectsCollector);
  const names = objectsCollector.getObjectNames().toJSArray();
  objectsCollector.delete();
  return names;
};

const getStoredAgentProvenance = (resource: gdResource): ?any => {
  const metadata = resource.getMetadata();
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object'
      ? parsed[AGENT_RESOURCE_PROVENANCE_METADATA_KEY] || null
      : null;
  } catch (error) {
    return null;
  }
};

const applyRequestProvenance = (
  resource: gdResource,
  request: any
): boolean => {
  if (request && request.origin && typeof request.origin === 'object') {
    const originName =
      typeof request.origin.name === 'string' ? request.origin.name : '';
    const originIdentifier =
      typeof request.origin.identifier === 'string'
        ? request.origin.identifier
        : '';
    resource.setOrigin(originName, originIdentifier);
  }
  if (
    !request ||
    !request.provenance ||
    typeof request.provenance !== 'object'
  ) {
    return false;
  }

  const existingMetadata = resource.getMetadata();
  let parsed = {};
  if (existingMetadata) {
    try {
      parsed = JSON.parse(existingMetadata);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return false;
      }
    } catch (error) {
      // Preserve opaque/non-JSON metadata rather than destroying it merely to
      // persist agent provenance. The operation still returns provenance.
      return false;
    }
  }
  resource.setMetadata(
    JSON.stringify({
      ...parsed,
      [AGENT_RESOURCE_PROVENANCE_METADATA_KEY]: request.provenance,
    })
  );
  return true;
};

const getResourceInfo = (
  project: gdProject,
  resourceName: string,
  usedResourceNames?: Set<string>
) => {
  const resourcesManager = project.getResourcesManager();
  if (!resourcesManager.hasResource(resourceName)) {
    throw new Error(`resource_not_found:${resourceName}`);
  }

  const resource = resourcesManager.getResource(resourceName);
  const localFile = getLocalFileDetails(project, resource);
  const sharedResourceNames = resource.useFile()
    ? resourcesManager
        .getResourceNamesWithFile(resource.getFile())
        .toJSArray()
        .filter(name => name !== resourceName)
    : [];
  const usedNames = usedResourceNames || getUsedResourceNames(project);

  return {
    name: resourceName,
    kind: resource.getKind(),
    file: resource.useFile() ? resource.getFile() : null,
    useFile: resource.useFile(),
    userAdded: resource.isUserAdded(),
    metadata: resource.getMetadata() || null,
    provenance: getStoredAgentProvenance(resource),
    originName: resource.getOriginName() || null,
    originIdentifier: resource.getOriginIdentifier() || null,
    fileStatus:
      resource.useFile() && project.getProjectFile()
        ? localFile.isLocalFile && localFile.exists === false
          ? 'error'
          : localFile.isLocalFile && localFile.insideProjectFolder === false
          ? 'warning'
          : localFile.isLocalFile &&
            localFile.exists === true &&
            localFile.insideProjectFolder === true
          ? ''
          : getResourceFilePathStatus(project, resourceName)
        : '',
    isLocalFile: localFile.isLocalFile,
    localFilePath: localFile.fullPath,
    fileExists: localFile.exists,
    insideProjectFolder: localFile.insideProjectFolder,
    sharedResourceNames,
    usedInProject: usedNames.has(resourceName),
    orphaned: !usedNames.has(resourceName),
  };
};

const prepareLocalFile = async ({
  project,
  sourcePath,
  copyToProject,
  maxLocalFileBytes,
}: {|
  project: gdProject,
  sourcePath: string,
  copyToProject: boolean,
  maxLocalFileBytes: number,
|}) => {
  if (!fs || !path) throw new Error('local_filesystem_unavailable');
  if (sourcePath.includes('\u0000')) {
    throw new Error('invalid_resource_file_path');
  }
  const resolvedSourcePath = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSourcePath)) {
    throw new Error('resource_file_not_found');
  }
  const sourceStat = fs.statSync(resolvedSourcePath);
  if (!sourceStat.isFile()) {
    throw new Error('resource_file_not_found');
  }
  if (sourceStat.size > maxLocalFileBytes) {
    throw new Error(
      `resource_file_too_large:${sourceStat.size}:${maxLocalFileBytes}`
    );
  }

  const projectFolder = getProjectFolder(project);
  let finalPath = resolvedSourcePath;
  if (projectFolder && copyToProject) {
    const copied = await copyAllToProjectFolder(
      project,
      [resolvedSourcePath],
      new Map()
    );
    if (copied.length) finalPath = copied[0];
  }

  return {
    sourcePath: resolvedSourcePath,
    finalPath,
    storedFilePath: projectFolder
      ? path.relative(projectFolder, finalPath).replace(/\\/g, '/')
      : finalPath,
  };
};

const ensurePhysicalDeleteIsSafe = (
  project: gdProject,
  resourceName: string,
  resource: gdResource
) => {
  if (!fs || !path) throw new Error('local_filesystem_unavailable');
  if (!resource.useFile()) throw new Error('resource_has_no_file');
  if (isURL(resource.getFile())) throw new Error('resource_file_is_remote');

  const localFile = getLocalFileDetails(project, resource);
  if (!localFile.fullPath) throw new Error('resource_file_path_unresolved');
  if (!localFile.insideProjectFolder) {
    throw new Error('resource_file_outside_project_folder');
  }

  const usedResourceNames = getUsedResourceNames(project);
  const resourceFile = resource.getFile();
  if (resourceFile !== resourceName && usedResourceNames.has(resourceFile)) {
    throw new Error(`resource_file_referenced_directly:${resourceFile}`);
  }

  const resourcesManager = project.getResourcesManager();
  const sharedResourceNames = resourcesManager
    .getResourceNamesWithFile(resource.getFile())
    .toJSArray()
    .filter(name => name !== resourceName);
  if (sharedResourceNames.length) {
    throw new Error(`resource_file_shared_by:${sharedResourceNames.join(',')}`);
  }

  return localFile;
};

const TEXT_COMPATIBLE_RESOURCE_KINDS = new Set([
  'json',
  'javascript',
  'tilemap',
  'tileset',
  'bitmapFont',
  'atlas',
  'spine',
]);

const getUtf8ByteLength = (value: string): number =>
  unescape(encodeURIComponent(value)).length;

const assertTextResourceKind = (kind: string) => {
  if (!TEXT_COMPATIBLE_RESOURCE_KINDS.has(kind)) {
    throw new Error(`unsupported_text_resource_kind:${kind}`);
  }
};

const resolveProjectTextPath = (
  project: gdProject,
  relativePath: string
): {| fullPath: string, storedFilePath: string |} => {
  if (!fs || !path) throw new Error('local_filesystem_unavailable');
  const projectFolder = getProjectFolder(project);
  if (!projectFolder) throw new Error('project_must_be_saved_locally');
  if (
    !relativePath ||
    typeof relativePath !== 'string' ||
    relativePath.includes('\u0000') ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('invalid_project_resource_relative_path');
  }

  const normalized = path.normalize(relativePath.replace(/\\/g, '/'));
  if (
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized === '.' ||
    path.isAbsolute(normalized)
  ) {
    throw new Error('resource_file_outside_project_folder');
  }

  const fullPath = path.resolve(projectFolder, normalized);
  if (!isPathInside(path.resolve(projectFolder), fullPath)) {
    throw new Error('resource_file_outside_project_folder');
  }

  let current = path.resolve(projectFolder);
  const relativeSegments = path
    .relative(projectFolder, fullPath)
    .split(path.sep)
    .filter(Boolean);
  relativeSegments.forEach(segment => {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('resource_text_path_contains_symlink');
    }
  });

  return {
    fullPath,
    storedFilePath: path
      .relative(projectFolder, fullPath)
      .replace(/\\/g, '/'),
  };
};

const generateExportedFilename = (
  filename: string,
  usedFilenames: Set<string>
): string => {
  if (!path) return filename;
  const extension = path.extname(filename);
  const baseName = filename.slice(
    0,
    extension ? filename.length - extension.length : filename.length
  );
  if (!usedFilenames.has(filename)) return filename;
  let index = 2;
  let candidate = `${baseName}${index}${extension}`;
  while (usedFilenames.has(candidate)) {
    index += 1;
    candidate = `${baseName}${index}${extension}`;
  }
  return candidate;
};

const getResourcePackagingEntries = (project: gdProject): Array<any> => {
  const resourcesManager = project.getResourcesManager();
  const resourceNames = resourcesManager.getAllResourceNames().toJSArray();
  const projectFolder = getProjectFolder(project);
  const usedFilenames: Set<string> = new Set();
  const exportedBySource: Map<string, string> = new Map();

  return resourceNames.map(resourceName => {
    const resource = resourcesManager.getResource(resourceName);
    const info = getResourceInfo(project, resourceName);
    if (!resource.useFile()) {
      return {
        ...info,
        packagingStatus: 'not-file-backed',
        willPackage: false,
        exportedFilename: null,
        runtimeResolution: null,
      };
    }

    const file = resource.getFile();
    if (isURL(file)) {
      return {
        ...info,
        packagingStatus: 'remote-resource',
        willPackage: false,
        exportedFilename: null,
        runtimeResolution: null,
      };
    }

    if (!path || !projectFolder) {
      return {
        ...info,
        packagingStatus: 'project-path-unresolved',
        willPackage: false,
        exportedFilename: null,
        runtimeResolution: null,
      };
    }

    const fullPath = path.resolve(projectFolder, file);
    const sourceKey =
      process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
    let exportedFilename = exportedBySource.get(sourceKey) || null;
    if (!exportedFilename) {
      const basename = path.basename(fullPath);
      exportedFilename = generateExportedFilename(basename, usedFilenames);
      usedFilenames.add(exportedFilename);
      exportedBySource.set(sourceKey, exportedFilename);
    }

    const exists = fs ? fs.existsSync(fullPath) : null;
    const willPackage = exists === true;
    return {
      ...info,
      packagingStatus: willPackage ? 'will-package' : 'missing-source',
      willPackage,
      exportedFilename,
      runtimeResolution: {
        strategy: 'registered-resource-name-to-game-root-file',
        resourceName,
        loaderReference: resourceName,
        exportedFile: exportedFilename,
        preview: exportedFilename,
        web: exportedFilename,
        desktop: exportedFilename,
        mobile: exportedFilename,
        note:
          'GDevelop runtime resource managers resolve the registered resource name to this exported game-root-relative file.',
      },
      packagingSemantics: {
        registered: true,
        userAdded: resource.isUserAdded(),
        usedInProject: info.usedInProject,
        orphaned: info.orphaned,
        note:
          'Registered file-backed resources are exported even when orphaned. usedInProject tracks object/event/effect references; userAdded tracks user intent, not usage.',
      },
    };
  });
};

const replaceUtf8FileAtomically = ({
  fullPath,
  content,
}: {|
  fullPath: string,
  content: string,
|}): {|
  commit: () => void,
  rollback: () => void,
  existed: boolean,
|} => {
  if (!fs || !path) throw new Error('local_filesystem_unavailable');
  const directory = path.dirname(fullPath);
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isFile()) {
    throw new Error('resource_text_target_not_file');
  }

  const nonce = `${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const tempPath = path.join(
    directory,
    `.${path.basename(fullPath)}.agent-write-${nonce}.tmp`
  );
  const backupPath = path.join(
    directory,
    `.${path.basename(fullPath)}.agent-backup-${nonce}.tmp`
  );
  const existed = fs.existsSync(fullPath);
  let backupCreated = false;
  let targetReplaced = false;

  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    if (existed) {
      fs.renameSync(fullPath, backupPath);
      backupCreated = true;
    }
    fs.renameSync(tempPath, fullPath);
    targetReplaced = true;
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      if (targetReplaced && fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      if (backupCreated && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, fullPath);
      }
    } catch (_) {}
    throw error;
  }

  let completed = false;
  return {
    existed,
    commit: () => {
      if (completed) return;
      completed = true;
      if (backupCreated && fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    },
    rollback: () => {
      if (completed) return;
      completed = true;
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        if (backupCreated && fs.existsSync(backupPath)) {
          fs.renameSync(backupPath, fullPath);
        }
      } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      }
    },
  };
};

export const createAssetTools = ({
  project,
  resourceManagementProps,
  triggerUnsavedChanges,
  forceUpdate,
  maxLocalFileBytes = DEFAULT_MAX_LOCAL_RESOURCE_FILE_BYTES,
}: AssetToolsOptions) => {
  const notifyChanged = (kind: 'added' | 'usage') => {
    if (kind === 'added') resourceManagementProps.onNewResourcesAdded();
    else resourceManagementProps.onResourceUsageChanged();
    triggerUnsavedChanges();
    forceUpdate();
  };

  const listResources = () => {
    const resourcesManager = project.getResourcesManager();
    const usedResourceNames = getUsedResourceNames(project);
    const allResourceNames = resourcesManager.getAllResourceNames().toJSArray();
    const resources = allResourceNames.map(resourceName =>
      getResourceInfo(project, resourceName, usedResourceNames)
    );
    const unregisteredReferences = Array.from(usedResourceNames)
      .filter(resourceName => !resourcesManager.hasResource(resourceName))
      .sort();

    return {
      resources,
      unregisteredReferences,
      summary: {
        total: resources.length,
        used: resources.filter(resource => resource.usedInProject).length,
        orphaned: resources.filter(resource => resource.orphaned).length,
        missingFiles: resources.filter(
          resource => resource.fileStatus === 'error'
        ).length,
        outsideProjectFiles: resources.filter(
          resource => resource.fileStatus === 'warning'
        ).length,
        unregisteredReferences: unregisteredReferences.length,
      },
    };
  };

  const inspectResource = (resourceName: string) => {
    const info = getResourceInfo(project, resourceName);
    return {
      ...info,
      objectNamesUsingResource: getObjectNamesUsingResource(
        project,
        resourceName
      ),
    };
  };

  const inspectResourcePackaging = (request: any = {}) => {
    const entries = getResourcePackagingEntries(project);
    const selected =
      request.resourceName && typeof request.resourceName === 'string'
        ? entries.filter(entry => entry.name === request.resourceName)
        : entries;
    if (request.resourceName && selected.length === 0) {
      throw new Error(`resource_not_found:${request.resourceName}`);
    }

    return {
      exportStrategy: {
        resourceSelection: 'all-registered-file-backed-resources',
        directoryStructure: 'flattened',
        collisionPolicy: 'basename-then-numeric-suffix-starting-at-2',
        updatesExportedProjectOnly: true,
        portableRuntimeResolution:
          'Runtime APIs should use the registered resource name. Export rewrites its backing file to a game-root-relative filename shared by preview, web, desktop and mobile outputs.',
      },
      transactionSemantics: {
        projectCheckpointRestoresFileBytes: false,
        writeOperationAtomic: true,
        note:
          'resources.text.write rolls back its own file/resource mutation on operation failure. safety.transactions snapshots project data only and does not restore physical file bytes after a later rollback.',
      },
      resources: selected,
      summary: {
        total: selected.length,
        willPackage: selected.filter(entry => entry.willPackage).length,
        missingSource: selected.filter(
          entry => entry.packagingStatus === 'missing-source'
        ).length,
        orphanedButPackaged: selected.filter(
          entry => entry.orphaned && entry.willPackage
        ).length,
      },
    };
  };

  const readTextResource = (request: any) => {
    if (!fs || !path) throw new Error('local_filesystem_unavailable');
    if (
      !request ||
      !request.resourceName ||
      typeof request.resourceName !== 'string'
    ) {
      throw new Error('missing_resource_name');
    }

    const resourcesManager = project.getResourcesManager();
    if (!resourcesManager.hasResource(request.resourceName)) {
      throw new Error(`resource_not_found:${request.resourceName}`);
    }
    const resource = resourcesManager.getResource(request.resourceName);
    assertTextResourceKind(resource.getKind());
    const localFile = getLocalFileDetails(project, resource);
    if (!localFile.isLocalFile || !localFile.fullPath) {
      throw new Error('resource_file_path_unresolved');
    }
    if (localFile.insideProjectFolder !== true) {
      throw new Error('resource_file_outside_project_folder');
    }
    if (localFile.exists !== true) {
      throw new Error('resource_file_not_found');
    }

    const stat = fs.statSync(localFile.fullPath);
    if (stat.size > DEFAULT_MAX_TEXT_RESOURCE_BYTES) {
      throw new Error(
        `resource_text_file_too_large:${stat.size}:${DEFAULT_MAX_TEXT_RESOURCE_BYTES}`
      );
    }
    const content = fs.readFileSync(localFile.fullPath, 'utf8');
    const shouldParseJson =
      request.parseJson === true || resource.getKind() === 'json';
    let json = null;
    let jsonValid = null;
    let jsonError = null;
    if (shouldParseJson) {
      try {
        json = JSON.parse(content);
        jsonValid = true;
      } catch (error) {
        jsonValid = false;
        jsonError = String((error && error.message) || error);
      }
    }

    return {
      resource: getResourceInfo(project, request.resourceName),
      content,
      byteLength: getUtf8ByteLength(content),
      encoding: 'utf8',
      json,
      jsonValid,
      jsonError,
    };
  };

  const writeTextResource = (request: any) => {
    if (!fs || !path) throw new Error('local_filesystem_unavailable');
    if (
      !request ||
      !request.resourceName ||
      typeof request.resourceName !== 'string'
    ) {
      throw new Error('missing_resource_name');
    }
    if (typeof request.content !== 'string') {
      throw new Error('missing_resource_text_content');
    }

    const format =
      request.format === 'json' || request.format === 'text'
        ? request.format
        : request.resourceName.toLowerCase().endsWith('.json')
        ? 'json'
        : 'text';
    if (
      request.format !== undefined &&
      request.format !== 'json' &&
      request.format !== 'text'
    ) {
      throw new Error('unsupported_resource_text_format');
    }

    const byteLength = getUtf8ByteLength(request.content);
    if (byteLength > DEFAULT_MAX_TEXT_RESOURCE_BYTES) {
      throw new Error(
        `resource_text_file_too_large:${byteLength}:${DEFAULT_MAX_TEXT_RESOURCE_BYTES}`
      );
    }

    let parsedJson = null;
    if (format === 'json') {
      try {
        parsedJson = JSON.parse(request.content);
      } catch (error) {
        const invalidJsonError: any = new Error('invalid_resource_json');
        invalidJsonError.code = 'invalid_resource_json';
        invalidJsonError.details = {
          message: String((error && error.message) || error),
        };
        throw invalidJsonError;
      }
    }

    const resourcesManager = project.getResourcesManager();
    const exists = resourcesManager.hasResource(request.resourceName);
    if (request.createOnly === true && exists) {
      throw new Error(`resource_already_exists:${request.resourceName}`);
    }
    if (request.updateOnly === true && !exists) {
      throw new Error(`resource_not_found:${request.resourceName}`);
    }
    const existingResource = exists
      ? resourcesManager.getResource(request.resourceName)
      : null;
    const requestedKind =
      typeof request.resourceKind === 'string' && request.resourceKind
        ? request.resourceKind
        : null;
    const kind = existingResource
      ? existingResource.getKind()
      : requestedKind || (format === 'json' ? 'json' : null);
    if (!kind) throw new Error('text_resource_kind_required');
    assertTextResourceKind(kind);
    if (
      existingResource &&
      requestedKind &&
      requestedKind !== existingResource.getKind()
    ) {
      throw new Error(
        `resource_kind_mismatch:${existingResource.getKind()}:${requestedKind}`
      );
    }

    let target;
    if (request.relativePath !== undefined) {
      if (
        !request.relativePath ||
        typeof request.relativePath !== 'string'
      ) {
        throw new Error('invalid_project_resource_relative_path');
      }
      target = resolveProjectTextPath(project, request.relativePath);
    } else if (existingResource) {
      const localFile = getLocalFileDetails(project, existingResource);
      if (
        !localFile.isLocalFile ||
        !localFile.fullPath ||
        localFile.insideProjectFolder !== true
      ) {
        throw new Error('resource_file_outside_project_folder');
      }
      const projectFolder = getProjectFolder(project);
      if (!projectFolder) throw new Error('project_must_be_saved_locally');
      target = resolveProjectTextPath(
        project,
        path.relative(projectFolder, localFile.fullPath)
      );
    } else {
      target = resolveProjectTextPath(project, request.resourceName);
    }

    const targetKey =
      process.platform === 'win32'
        ? target.fullPath.toLowerCase()
        : target.fullPath;
    const sharedTargetNames = resourcesManager
      .getAllResourceNames()
      .toJSArray()
      .filter(name => name !== request.resourceName)
      .filter(name => {
        const candidate = resourcesManager.getResource(name);
        const details = getLocalFileDetails(project, candidate);
        if (!details.fullPath) return false;
        const candidateKey =
          process.platform === 'win32'
            ? details.fullPath.toLowerCase()
            : details.fullPath;
        return candidateKey === targetKey;
      });
    if (sharedTargetNames.length) {
      throw new Error(
        `resource_file_shared_by:${sharedTargetNames.join(',')}`
      );
    }

    let resourceForCreate = null;
    if (!existingResource) {
      resourceForCreate = createNewResource(kind);
      if (!resourceForCreate) {
        throw new Error(`unsupported_resource_kind:${kind}`);
      }
    }

    const oldResourceState = existingResource
      ? {
          file: existingResource.useFile() ? existingResource.getFile() : null,
          userAdded: existingResource.isUserAdded(),
          metadata: existingResource.getMetadata(),
          originName: existingResource.getOriginName(),
          originIdentifier: existingResource.getOriginIdentifier(),
        }
      : null;
    const fileMutation = replaceUtf8FileAtomically({
      fullPath: target.fullPath,
      content: request.content,
    });
    let resourceAdded = false;

    try {
      if (existingResource) {
        existingResource.setFile(target.storedFilePath);
        existingResource.setUserAdded(true);
      } else if (resourceForCreate) {
        resourceForCreate.setName(request.resourceName);
        resourceForCreate.setFile(target.storedFilePath);
        resourceForCreate.setUserAdded(true);
        applyResourceDefaults(project, resourceForCreate);
        if (!resourcesManager.addResource(resourceForCreate)) {
          throw new Error(
            `resource_registration_failed:${request.resourceName}`
          );
        }
        resourceAdded = true;
      }

      notifyChanged(existingResource ? 'usage' : 'added');
      fileMutation.commit();
    } catch (error) {
      if (resourceAdded) {
        resourcesManager.removeResource(request.resourceName);
      } else if (existingResource && oldResourceState) {
        if (oldResourceState.file !== null) {
          existingResource.setFile(oldResourceState.file);
        }
        existingResource.setUserAdded(oldResourceState.userAdded);
        existingResource.setMetadata(oldResourceState.metadata);
        existingResource.setOrigin(
          oldResourceState.originName,
          oldResourceState.originIdentifier
        );
      }
      fileMutation.rollback();
      throw error;
    } finally {
      if (resourceForCreate) resourceForCreate.delete();
    }

    return {
      written: true,
      created: !exists,
      updated: exists,
      format,
      jsonValidated: format === 'json',
      jsonType:
        format === 'json'
          ? Array.isArray(parsedJson)
            ? 'array'
            : parsedJson === null
            ? 'null'
            : typeof parsedJson
          : null,
      byteLength,
      encoding: 'utf8',
      operationAtomic: true,
      resource: getResourceInfo(project, request.resourceName),
      packaging: inspectResourcePackaging({
        resourceName: request.resourceName,
      }).resources[0],
    };
  };

  const importLocalResource = async (request: any) => {
    if (!request.filePath || typeof request.filePath !== 'string') {
      throw new Error('missing_resource_file_path');
    }

    const sourcePath = request.filePath;
    const kind =
      (typeof request.kind === 'string' && request.kind) ||
      inferResourceKind(sourcePath);
    if (!kind) throw new Error('unable_to_infer_resource_kind');

    const preparedFile = await prepareLocalFile({
      project,
      sourcePath,
      copyToProject: request.copyToProject !== false,
      maxLocalFileBytes,
    });
    const resourcesManager = project.getResourcesManager();
    const resourceName =
      (typeof request.resourceName === 'string' && request.resourceName) ||
      (path ? path.basename(preparedFile.storedFilePath) : null);
    if (!resourceName) throw new Error('missing_resource_name');

    if (resourcesManager.hasResource(resourceName)) {
      if (!request.overwrite) {
        throw new Error(`resource_already_exists:${resourceName}`);
      }
      const existingResource = resourcesManager.getResource(resourceName);
      if (existingResource.getKind() !== kind) {
        throw new Error(
          `resource_kind_mismatch:${existingResource.getKind()}:${kind}`
        );
      }
      existingResource.setFile(preparedFile.storedFilePath);
      existingResource.setUserAdded(true);
      if (request.preserveOrigin !== true) existingResource.setOrigin('', '');
      const provenancePersisted = applyRequestProvenance(
        existingResource,
        request
      );
      applyResourceDefaults(project, existingResource);
      notifyChanged('usage');
      return {
        imported: true,
        overwritten: true,
        ...(request.provenance ? { provenancePersisted } : {}),
        resource: getResourceInfo(project, resourceName),
      };
    }

    const newResource = createNewResource(kind);
    if (!newResource) throw new Error(`unsupported_resource_kind:${kind}`);
    let provenancePersisted = false;
    try {
      newResource.setName(resourceName);
      newResource.setFile(preparedFile.storedFilePath);
      newResource.setUserAdded(true);
      provenancePersisted = applyRequestProvenance(newResource, request);
      applyResourceDefaults(project, newResource);
      resourcesManager.addResource(newResource);
    } finally {
      newResource.delete();
    }
    notifyChanged('added');
    return {
      imported: true,
      overwritten: false,
      ...(request.provenance ? { provenancePersisted } : {}),
      resource: getResourceInfo(project, resourceName),
    };
  };

  const importStoreResource = (request: any) => {
    const storeResource = request && request.resource;
    if (
      !storeResource ||
      typeof storeResource.url !== 'string' ||
      !storeResource.url ||
      typeof storeResource.type !== 'string' ||
      !storeResource.type
    ) {
      throw new Error('invalid_store_resource');
    }
    if (!isURL(storeResource.url)) {
      throw new Error('invalid_store_resource_url');
    }

    const kind = storeResource.type;
    const resourcesManager = project.getResourcesManager();
    let defaultResourceName = null;
    if (path) {
      try {
        defaultResourceName = path.basename(
          new URL(storeResource.url).pathname
        );
      } catch (error) {
        defaultResourceName = path.basename(storeResource.url);
      }
    }
    const resourceName =
      (typeof request.resourceName === 'string' &&
        request.resourceName.trim()) ||
      defaultResourceName ||
      (typeof storeResource.name === 'string' && storeResource.name.trim()) ||
      null;
    if (!resourceName) throw new Error('missing_resource_name');

    if (resourcesManager.hasResource(resourceName)) {
      if (!request.overwrite) {
        throw new Error(`resource_already_exists:${resourceName}`);
      }
      const existingResource = resourcesManager.getResource(resourceName);
      if (existingResource.getKind() !== kind) {
        throw new Error(
          `resource_kind_mismatch:${existingResource.getKind()}:${kind}`
        );
      }
      existingResource.setFile(storeResource.url);
      existingResource.setUserAdded(true);
      existingResource.setOrigin('gdevelop-asset-store', storeResource.url);
      applyResourceDefaults(project, existingResource);
      notifyChanged('usage');
      return {
        imported: true,
        overwritten: true,
        resource: getResourceInfo(project, resourceName),
      };
    }

    const newResource = createNewResource(kind);
    if (!newResource) throw new Error(`unsupported_resource_kind:${kind}`);
    try {
      newResource.setName(resourceName);
      newResource.setFile(storeResource.url);
      newResource.setUserAdded(true);
      newResource.setOrigin('gdevelop-asset-store', storeResource.url);
      applyResourceDefaults(project, newResource);
      resourcesManager.addResource(newResource);
    } finally {
      newResource.delete();
    }
    notifyChanged('added');
    return {
      imported: true,
      overwritten: false,
      resource: getResourceInfo(project, resourceName),
    };
  };

  const replaceLocalResource = async (request: any) => {
    if (!request.resourceName || typeof request.resourceName !== 'string') {
      throw new Error('missing_resource_name');
    }
    if (!request.filePath || typeof request.filePath !== 'string') {
      throw new Error('missing_resource_file_path');
    }

    const resourcesManager = project.getResourcesManager();
    if (!resourcesManager.hasResource(request.resourceName)) {
      throw new Error(`resource_not_found:${request.resourceName}`);
    }
    const resource = resourcesManager.getResource(request.resourceName);
    const inferredKind =
      (typeof request.kind === 'string' && request.kind) ||
      inferResourceKind(request.filePath);
    if (inferredKind && inferredKind !== resource.getKind()) {
      throw new Error(
        `resource_kind_mismatch:${resource.getKind()}:${inferredKind}`
      );
    }

    const oldFile = resource.useFile() ? resource.getFile() : null;
    const oldLocalFile =
      request.deletePreviousFile && oldFile
        ? ensurePhysicalDeleteIsSafe(project, request.resourceName, resource)
        : null;
    const preparedFile = await prepareLocalFile({
      project,
      sourcePath: request.filePath,
      copyToProject: request.copyToProject !== false,
      maxLocalFileBytes,
    });

    resource.setFile(preparedFile.storedFilePath);
    resource.setUserAdded(true);
    if (request.preserveOrigin !== true) resource.setOrigin('', '');
    const provenancePersisted = applyRequestProvenance(resource, request);
    applyResourceDefaults(project, resource);

    let previousFileDeleted = false;
    if (
      oldLocalFile &&
      oldLocalFile.fullPath &&
      oldFile !== preparedFile.storedFilePath &&
      oldLocalFile.exists &&
      fs
    ) {
      fs.unlinkSync(oldLocalFile.fullPath);
      previousFileDeleted = true;
    }

    notifyChanged('usage');
    return {
      replaced: true,
      oldFile,
      previousFileDeleted,
      ...(request.provenance ? { provenancePersisted } : {}),
      resource: getResourceInfo(project, request.resourceName),
    };
  };

  const renameResource = (request: any) => {
    if (!request.resourceName || typeof request.resourceName !== 'string') {
      throw new Error('missing_resource_name');
    }
    if (
      !request.newResourceName ||
      typeof request.newResourceName !== 'string'
    ) {
      throw new Error('missing_new_resource_name');
    }

    const resourcesManager = project.getResourcesManager();
    if (!resourcesManager.hasResource(request.resourceName)) {
      throw new Error(`resource_not_found:${request.resourceName}`);
    }
    if (resourcesManager.hasResource(request.newResourceName)) {
      throw new Error(`resource_already_exists:${request.newResourceName}`);
    }

    resourcesManager.renameResource(
      request.resourceName,
      request.newResourceName
    );
    renameResourcesInProject(project, {
      [request.resourceName]: request.newResourceName,
    });
    notifyChanged('usage');
    return {
      renamed: true,
      oldResourceName: request.resourceName,
      resource: getResourceInfo(project, request.newResourceName),
    };
  };

  const removeResource = (request: any) => {
    if (!request.resourceName || typeof request.resourceName !== 'string') {
      throw new Error('missing_resource_name');
    }

    const resourcesManager = project.getResourcesManager();
    if (!resourcesManager.hasResource(request.resourceName)) {
      throw new Error(`resource_not_found:${request.resourceName}`);
    }

    const usedResourceNames = getUsedResourceNames(project);
    if (usedResourceNames.has(request.resourceName)) {
      const objectNames = getObjectNamesUsingResource(
        project,
        request.resourceName
      );
      throw new Error(
        `resource_in_use:${request.resourceName}${
          objectNames.length ? `:objects=${objectNames.join(',')}` : ''
        }`
      );
    }

    const resource = resourcesManager.getResource(request.resourceName);
    const resourceInfo = getResourceInfo(
      project,
      request.resourceName,
      usedResourceNames
    );
    const localFile = request.deleteFile
      ? ensurePhysicalDeleteIsSafe(project, request.resourceName, resource)
      : null;

    resourcesManager.removeResource(request.resourceName);

    let fileDeleted = false;
    if (localFile && localFile.fullPath && localFile.exists && fs) {
      fs.unlinkSync(localFile.fullPath);
      fileDeleted = true;
    }

    notifyChanged('usage');
    return {
      removed: true,
      fileDeleted,
      removedResource: resourceInfo,
    };
  };

  return {
    listResources,
    inspectResource,
    inspectResourcePackaging,
    readTextResource,
    writeTextResource,
    importLocalResource,
    importStoreResource,
    replaceLocalResource,
    renameResource,
    removeResource,
  };
};
