// @flow
import optionalRequire from '../Utils/OptionalRequire';
import { AgentError } from './core/AgentError';
import {
  decodeVisualResourceBase64,
  inspectVisualResourceBuffer,
  VISUAL_RESOURCE_KINDS,
} from './editor/VisualResourceMetadata';
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

const getTypedObjectResourcePaths = (
  project: gdProject,
  object: gdObject,
  resourceName: string
): Array<any> => {
  const objectType = object.getType();
  const configuration = object.getConfiguration();
  const paths = [];

  if (objectType === 'Sprite') {
    const spriteConfiguration = gd.asSpriteConfiguration(configuration);
    const animations = spriteConfiguration.getAnimations();
    for (
      let animationIndex = 0;
      animationIndex < animations.getAnimationsCount();
      animationIndex++
    ) {
      const animation = animations.getAnimation(animationIndex);
      for (
        let directionIndex = 0;
        directionIndex < animation.getDirectionsCount();
        directionIndex++
      ) {
        const direction = animation.getDirection(directionIndex);
        for (
          let spriteIndex = 0;
          spriteIndex < direction.getSpritesCount();
          spriteIndex++
        ) {
          const sprite = direction.getSprite(spriteIndex);
          if (sprite.getImageName() !== resourceName) continue;
          paths.push({
            property: 'image',
            path: `animations[${animationIndex}].directions[${directionIndex}].sprites[${spriteIndex}].image`,
            animationIndex,
            animationName: animation.getName() || null,
            directionIndex,
            spriteIndex,
          });
        }
      }
    }
  } else if (objectType === 'TiledSpriteObject::TiledSprite') {
    const tiled = gd.asTiledSpriteConfiguration(configuration);
    if (tiled.getTexture() === resourceName) {
      paths.push({
        property: 'texture',
        path: 'texture',
        structuralConstraint: 'tiled-texture',
      });
    }
  } else if (objectType === 'PanelSpriteObject::PanelSprite') {
    const panel = gd.asPanelSpriteConfiguration(configuration);
    if (panel.getTexture() === resourceName) {
      paths.push({
        property: 'texture',
        path: 'texture',
        structuralConstraint: 'nine-patch-texture',
        ninePatch: {
          leftMargin: panel.getLeftMargin(),
          topMargin: panel.getTopMargin(),
          rightMargin: panel.getRightMargin(),
          bottomMargin: panel.getBottomMargin(),
          tiled: panel.isTiled(),
        },
      });
    }
  } else if (objectType === 'TextObject::Text') {
    const text = gd.asTextObjectConfiguration(configuration);
    if (text.getFontName() === resourceName) {
      paths.push({ property: 'font', path: 'fontName' });
    }
  }

  return paths;
};

const objectUsesResource = (
  project: gdProject,
  object: gdObject,
  resourceName: string
): boolean => {
  const helper = new gd.ResourcesInUseHelper(project.getResourcesManager());
  try {
    object.getConfiguration().exposeResources(helper);
    return helper
      .getAllResources()
      .toJSArray()
      .includes(resourceName);
  } finally {
    helper.delete();
  }
};

const collectObjectResourceUsages = (
  project: gdProject,
  objects: gdObjectsContainer,
  resourceName: string,
  scope: string,
  sceneName: ?string
): Array<any> => {
  const usages = [];
  for (let index = 0; index < objects.getObjectsCount(); index++) {
    const object = objects.getObjectAt(index);
    if (!objectUsesResource(project, object, resourceName)) continue;
    const objectType = object.getType();
    const typedPaths = getTypedObjectResourcePaths(
      project,
      object,
      resourceName
    );
    usages.push({
      scope,
      sceneName,
      objectName: object.getName(),
      objectType,
      customObject: project.hasEventsBasedObject(objectType),
      paths:
        typedPaths.length > 0
          ? typedPaths
          : [
              {
                property: null,
                path: null,
                discoverability: 'object-resource-exposer-only',
              },
            ],
      authoritativePropertyTool: 'objects.properties.describe',
    });
  }
  return usages;
};

const getDetailedResourceUsages = (
  project: gdProject,
  resourceName: string,
  usedResourceNames?: Set<string>
): any => {
  const usedNames = usedResourceNames || getUsedResourceNames(project);
  const objectUsages = [
    ...collectObjectResourceUsages(
      project,
      project.getObjects(),
      resourceName,
      'global-object',
      null
    ),
  ];
  for (let index = 0; index < project.getLayoutsCount(); index++) {
    const layout = project.getLayoutAt(index);
    objectUsages.push(
      ...collectObjectResourceUsages(
        project,
        layout.getObjects(),
        resourceName,
        'scene-object',
        layout.getName()
      )
    );
  }

  const aggregateUsed = usedNames.has(resourceName);
  return {
    usedInProject: aggregateUsed,
    objectUsages,
    nonObjectReferences: aggregateUsed
      ? {
          detailed: false,
          note:
            'Native project-wide resource exposure confirms aggregate usage. Object-definition usages are detailed above; event/effect/project-setting references remain aggregate when the binding does not expose their exact path.',
        }
      : null,
    coverage: {
      objectDefinitions: 'detailed',
      spriteAnimationFrames: 'detailed',
      textFonts: 'detailed',
      tiledAndNinePatchTextures: 'detailed',
      eventsEffectsAndProjectSettings: 'aggregate-only',
    },
  };
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
  const projectFolder = getProjectFolder(project);
  const projectRelativePath =
    path &&
    projectFolder &&
    localFile.fullPath &&
    localFile.insideProjectFolder === true
      ? path.relative(projectFolder, localFile.fullPath).replace(/\\/g, '/')
      : null;

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
    projectRelativePath,
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
    storedFilePath: path.relative(projectFolder, fullPath).replace(/\\/g, '/'),
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

const MIME_TO_VISUAL_EXTENSION = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
});

const sanitizeVisualFileName = (value: string): string => {
  const raw = path ? path.basename(value) : value;
  const sanitized = raw
    .replace(/[\\/:*?"<>|]/g, '-')
    .split('')
    .map(character => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('')
    .replace(/^\.+/, '')
    .trim();
  return sanitized || 'visual-resource';
};

const getDefaultVisualRelativePath = ({
  resourceName,
  mimeType,
}: any): string => {
  if (!path) throw new AgentError({ code: 'local_filesystem_unavailable' });
  let fileName = sanitizeVisualFileName(resourceName);
  if (!path.extname(fileName)) {
    const extension = MIME_TO_VISUAL_EXTENSION[mimeType];
    if (!extension) {
      throw new AgentError({
        code: 'unsupported_visual_resource_content',
        details: { mimeType },
      });
    }
    fileName += extension;
  }
  return `assets/${fileName}`;
};

const replaceBinaryFileAtomically = ({
  fullPath,
  bytes,
  requireAbsent = false,
}: any): any => {
  if (!fs || !path) {
    throw new AgentError({ code: 'local_filesystem_unavailable' });
  }
  const directory = path.dirname(fullPath);
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isFile()) {
    throw new AgentError({ code: 'visual_resource_target_not_file' });
  }
  if (requireAbsent && fs.existsSync(fullPath)) {
    throw new AgentError({
      code: 'visual_resource_target_exists',
      details: { fullPath },
    });
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
    fs.writeFileSync(tempPath, bytes, { flag: 'wx' });
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

const requireVisualResource = (
  project: gdProject,
  resourceName: string
): gdResource => {
  const resourcesManager = project.getResourcesManager();
  if (!resourcesManager.hasResource(resourceName)) {
    throw new AgentError({
      code: 'resource_not_found',
      details: { resourceName },
    });
  }
  const resource = resourcesManager.getResource(resourceName);
  if (!VISUAL_RESOURCE_KINDS.includes(resource.getKind())) {
    throw new AgentError({
      code: 'unsupported_visual_resource_kind',
      details: {
        resourceName,
        kind: resource.getKind(),
        supportedKinds: VISUAL_RESOURCE_KINDS,
      },
    });
  }
  return resource;
};

const inspectLocalVisualBytes = ({
  project,
  resourceName,
  resource,
  maxLocalFileBytes,
}: any): any => {
  const localFile = getLocalFileDetails(project, resource);
  if (!localFile.isLocalFile || !localFile.fullPath) {
    return {
      available: false,
      reason: 'resource_file_not_local',
      metadata: null,
    };
  }
  if (localFile.exists !== true) {
    return {
      available: false,
      reason: 'resource_file_not_found',
      metadata: null,
    };
  }
  if (!fs) {
    return {
      available: false,
      reason: 'local_filesystem_unavailable',
      metadata: null,
    };
  }
  const stat = fs.statSync(localFile.fullPath);
  if (stat.size > maxLocalFileBytes) {
    throw new AgentError({
      code: 'resource_file_too_large',
      details: { byteSize: stat.size, maxBytes: maxLocalFileBytes },
    });
  }
  const bytes = fs.readFileSync(localFile.fullPath);
  const metadata = inspectVisualResourceBuffer({
    buffer: bytes,
    fileName: resource.getFile() || resourceName,
    requestedKind: resource.getKind(),
  });
  return { available: true, reason: null, metadata };
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
      usages: getDetailedResourceUsages(project, resourceName),
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
          'resources.text.* and resources.visual.import/replace perform their own atomic file/resource mutation rollback on operation failure. safety.transactions snapshots project data only and does not restore physical file bytes after a later rollback.',
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

  const inspectVisualResource = (request: any) => {
    if (
      !request ||
      typeof request.resourceName !== 'string' ||
      !request.resourceName
    ) {
      throw new AgentError({ code: 'missing_resource_name' });
    }
    const resource = requireVisualResource(project, request.resourceName);
    const resourceInfo = getResourceInfo(project, request.resourceName);
    const usages = getDetailedResourceUsages(project, request.resourceName);
    const physical = inspectLocalVisualBytes({
      project,
      resourceName: request.resourceName,
      resource,
      maxLocalFileBytes,
    });
    const packaging = inspectResourcePackaging({
      resourceName: request.resourceName,
    }).resources[0];
    const structuralConstraints = usages.objectUsages.flatMap(usage =>
      usage.paths
        .filter(pathEntry => pathEntry.structuralConstraint)
        .map(pathEntry => ({
          sceneName: usage.sceneName,
          objectName: usage.objectName,
          objectType: usage.objectType,
          ...pathEntry,
        }))
    );
    const metadata = physical.metadata;

    return {
      resource: resourceInfo,
      physical: {
        available: physical.available,
        reason: physical.reason,
        projectRelativePath: resourceInfo.projectRelativePath,
        mimeType: metadata ? metadata.mimeType : null,
        byteSize: metadata ? metadata.byteSize : null,
        sha256: metadata ? metadata.sha256 : null,
      },
      image: metadata ? metadata.image : null,
      font:
        resource.getKind() === 'font'
          ? {
              ...(metadata && metadata.font ? metadata.font : {}),
              registeredAsProjectFont: true,
              usableByTextObjects:
                resourceInfo.fileExists === true ||
                resourceInfo.isLocalFile === false,
              // Native resource exposure is authoritative for font usage even
              // when the object is extension-defined (for example BBText).
              // Built-in Text gets an exact typed path above; extension/custom
              // objects keep the object-level usage and direct callers to
              // objects.properties.describe for the exact resource property.
              textObjectUsages: usages.objectUsages,
            }
          : null,
      usages,
      structuralConstraints,
      packaging,
      authoritativePropertyTool: 'objects.properties.describe',
    };
  };

  const importVisualResource = (request: any) => {
    if (
      !request ||
      typeof request.resourceName !== 'string' ||
      !request.resourceName
    ) {
      throw new AgentError({ code: 'missing_resource_name' });
    }
    const resourcesManager = project.getResourcesManager();
    if (resourcesManager.hasResource(request.resourceName)) {
      throw new AgentError({
        code: 'resource_already_exists',
        details: { resourceName: request.resourceName },
      });
    }
    const decoded = decodeVisualResourceBase64(request.contentBase64);
    if (decoded.buffer.length > maxLocalFileBytes) {
      throw new AgentError({
        code: 'resource_file_too_large',
        details: {
          byteSize: decoded.buffer.length,
          maxBytes: maxLocalFileBytes,
        },
      });
    }
    const metadata = inspectVisualResourceBuffer({
      buffer: decoded.buffer,
      fileName: request.relativePath || request.resourceName,
      requestedKind: request.kind,
      declaredMime: decoded.declaredMime,
    });
    const relativePath =
      typeof request.relativePath === 'string' && request.relativePath
        ? request.relativePath
        : getDefaultVisualRelativePath({
            resourceName: request.resourceName,
            mimeType: metadata.mimeType,
          });
    const target = resolveProjectTextPath(project, relativePath);
    const fileMutation = replaceBinaryFileAtomically({
      fullPath: target.fullPath,
      bytes: decoded.buffer,
      requireAbsent: true,
    });
    const resource = createNewResource(metadata.kind);
    if (!resource) {
      fileMutation.rollback();
      throw new AgentError({
        code: 'unsupported_visual_resource_kind',
        details: { kind: metadata.kind },
      });
    }
    let registered = false;
    try {
      resource.setName(request.resourceName);
      resource.setFile(target.storedFilePath);
      resource.setUserAdded(true);
      applyResourceDefaults(project, resource);
      if (!resourcesManager.addResource(resource)) {
        throw new AgentError({
          code: 'resource_registration_failed',
          details: { resourceName: request.resourceName },
        });
      }
      registered = true;
      notifyChanged('added');
      fileMutation.commit();
    } catch (error) {
      if (registered) resourcesManager.removeResource(request.resourceName);
      fileMutation.rollback();
      throw error;
    } finally {
      resource.delete();
    }

    return {
      imported: true,
      operationAtomic: true,
      resource: getResourceInfo(project, request.resourceName),
      visual: inspectVisualResource({ resourceName: request.resourceName }),
    };
  };

  const replaceVisualResource = (request: any) => {
    if (
      !request ||
      typeof request.resourceName !== 'string' ||
      !request.resourceName
    ) {
      throw new AgentError({ code: 'missing_resource_name' });
    }
    const resource = requireVisualResource(project, request.resourceName);
    const decoded = decodeVisualResourceBase64(request.contentBase64);
    if (decoded.buffer.length > maxLocalFileBytes) {
      throw new AgentError({
        code: 'resource_file_too_large',
        details: {
          byteSize: decoded.buffer.length,
          maxBytes: maxLocalFileBytes,
        },
      });
    }
    const metadata = inspectVisualResourceBuffer({
      buffer: decoded.buffer,
      fileName:
        request.relativePath || resource.getFile() || request.resourceName,
      requestedKind: resource.getKind(),
      declaredMime: decoded.declaredMime,
    });
    const oldInfo = getResourceInfo(project, request.resourceName);
    const relativePath =
      typeof request.relativePath === 'string' && request.relativePath
        ? request.relativePath
        : oldInfo.projectRelativePath ||
          getDefaultVisualRelativePath({
            resourceName: request.resourceName,
            mimeType: metadata.mimeType,
          });
    const target = resolveProjectTextPath(project, relativePath);
    const resourcesManager = project.getResourcesManager();
    const targetKey =
      process.platform === 'win32'
        ? target.fullPath.toLowerCase()
        : target.fullPath;
    const targetSharedNames = resourcesManager
      .getAllResourceNames()
      .toJSArray()
      .filter(name => name !== request.resourceName)
      .filter(name => {
        const candidate = getLocalFileDetails(
          project,
          resourcesManager.getResource(name)
        );
        if (!candidate.fullPath) return false;
        const candidateKey =
          process.platform === 'win32'
            ? candidate.fullPath.toLowerCase()
            : candidate.fullPath;
        return candidateKey === targetKey;
      });
    if (targetSharedNames.length) {
      throw new AgentError({
        code: 'resource_file_shared_by',
        details: { resourceNames: targetSharedNames },
      });
    }

    const oldState = {
      file: resource.getFile(),
      userAdded: resource.isUserAdded(),
      metadata: resource.getMetadata(),
      originName: resource.getOriginName(),
      originIdentifier: resource.getOriginIdentifier(),
    };
    const fileMutation = replaceBinaryFileAtomically({
      fullPath: target.fullPath,
      bytes: decoded.buffer,
    });
    try {
      resource.setFile(target.storedFilePath);
      resource.setUserAdded(true);
      applyResourceDefaults(project, resource);
      notifyChanged('usage');
      fileMutation.commit();
    } catch (error) {
      resource.setFile(oldState.file);
      resource.setUserAdded(oldState.userAdded);
      resource.setMetadata(oldState.metadata);
      resource.setOrigin(oldState.originName, oldState.originIdentifier);
      fileMutation.rollback();
      throw error;
    }

    return {
      replaced: true,
      operationAtomic: true,
      referencesPreserved: true,
      oldFile: oldState.file,
      previousFileRetained:
        !!oldState.file && oldState.file !== target.storedFilePath,
      resource: getResourceInfo(project, request.resourceName),
      visual: inspectVisualResource({ resourceName: request.resourceName }),
    };
  };

  const relocateVisualResource = (request: any) => {
    if (
      !request ||
      typeof request.resourceName !== 'string' ||
      !request.resourceName
    ) {
      throw new AgentError({ code: 'missing_resource_name' });
    }
    const resource = requireVisualResource(project, request.resourceName);
    const resourcesManager = project.getResourcesManager();
    const newResourceName =
      typeof request.newResourceName === 'string' && request.newResourceName
        ? request.newResourceName
        : request.resourceName;
    const wantsNameChange = newResourceName !== request.resourceName;
    const wantsPathChange =
      typeof request.newRelativePath === 'string' && !!request.newRelativePath;
    if (!wantsNameChange && !wantsPathChange) {
      throw new AgentError({ code: 'missing_visual_resource_relocation' });
    }
    if (wantsNameChange && resourcesManager.hasResource(newResourceName)) {
      throw new AgentError({
        code: 'resource_already_exists',
        details: { resourceName: newResourceName },
      });
    }

    const oldInfo = getResourceInfo(project, request.resourceName);
    const usagesBefore = getDetailedResourceUsages(
      project,
      request.resourceName
    );
    let sourceFullPath = null;
    let target = null;
    if (wantsPathChange) {
      if (
        !oldInfo.localFilePath ||
        oldInfo.insideProjectFolder !== true ||
        oldInfo.fileExists !== true
      ) {
        throw new AgentError({
          code: 'resource_file_path_unresolved',
          details: { resourceName: request.resourceName },
        });
      }
      if (oldInfo.sharedResourceNames.length) {
        throw new AgentError({
          code: 'resource_file_shared_by',
          details: { resourceNames: oldInfo.sharedResourceNames },
        });
      }
      target = resolveProjectTextPath(project, request.newRelativePath);
      sourceFullPath = oldInfo.localFilePath;
      const samePath =
        process.platform === 'win32'
          ? sourceFullPath.toLowerCase() === target.fullPath.toLowerCase()
          : sourceFullPath === target.fullPath;
      if (!samePath && fs && fs.existsSync(target.fullPath)) {
        throw new AgentError({
          code: 'visual_resource_target_exists',
          details: { relativePath: request.newRelativePath },
        });
      }
    }

    const dryRun = request.dryRun !== false;
    if (dryRun) {
      return {
        dryRun: true,
        resourceName: request.resourceName,
        newResourceName,
        oldRelativePath: oldInfo.projectRelativePath,
        newRelativePath: target
          ? target.storedFilePath
          : oldInfo.projectRelativePath,
        referencesToRename: wantsNameChange ? usagesBefore : null,
      };
    }

    const oldFile = resource.getFile();
    let fileMoved = false;
    let resourceRenamed = false;
    try {
      if (target && sourceFullPath) {
        const samePath =
          process.platform === 'win32'
            ? sourceFullPath.toLowerCase() === target.fullPath.toLowerCase()
            : sourceFullPath === target.fullPath;
        if (!samePath) {
          if (!fs || !path) {
            throw new AgentError({ code: 'local_filesystem_unavailable' });
          }
          fs.mkdirSync(path.dirname(target.fullPath), { recursive: true });
          fs.renameSync(sourceFullPath, target.fullPath);
          fileMoved = true;
        }
        resource.setFile(target.storedFilePath);
      }
      if (wantsNameChange) {
        resourcesManager.renameResource(request.resourceName, newResourceName);
        resourceRenamed = true;
        renameResourcesInProject(project, {
          [request.resourceName]: newResourceName,
        });
      }
      notifyChanged('usage');
    } catch (error) {
      try {
        if (resourceRenamed) {
          resourcesManager.renameResource(
            newResourceName,
            request.resourceName
          );
          renameResourcesInProject(project, {
            [newResourceName]: request.resourceName,
          });
        }
        const restoredResource = resourcesManager.getResource(
          request.resourceName
        );
        restoredResource.setFile(oldFile);
        if (fileMoved && target && sourceFullPath && fs) {
          fs.renameSync(target.fullPath, sourceFullPath);
        }
      } catch (_) {}
      throw error;
    }

    return {
      relocated: true,
      referencesPreserved: true,
      oldResourceName: request.resourceName,
      oldRelativePath: oldInfo.projectRelativePath,
      resource: getResourceInfo(project, newResourceName),
      visual: inspectVisualResource({ resourceName: newResourceName }),
    };
  };

  const deleteVisualResource = (request: any) => {
    if (
      !request ||
      typeof request.resourceName !== 'string' ||
      !request.resourceName
    ) {
      throw new AgentError({ code: 'missing_resource_name' });
    }
    requireVisualResource(project, request.resourceName);
    const resourceInfo = getResourceInfo(project, request.resourceName);
    const usages = getDetailedResourceUsages(project, request.resourceName);
    const dryRun = request.dryRun !== false;
    const blocked = usages.usedInProject;
    let fileDeletion = null;
    if (!blocked && request.deleteFile === true) {
      const resource = project
        .getResourcesManager()
        .getResource(request.resourceName);
      const localFile = ensurePhysicalDeleteIsSafe(
        project,
        request.resourceName,
        resource
      );
      fileDeletion = {
        safe: true,
        fullPath: localFile.fullPath,
        exists: localFile.exists,
      };
    }

    if (dryRun) {
      return {
        dryRun: true,
        blocked,
        blockReason: blocked ? 'resource_in_use' : null,
        wouldRemoveResource: !blocked,
        wouldDeleteFile: !blocked && request.deleteFile === true,
        resource: resourceInfo,
        usages,
        fileDeletion,
      };
    }
    if (blocked) {
      throw new AgentError({
        code: 'resource_in_use',
        details: {
          resourceName: request.resourceName,
          usages,
        },
        hint:
          'Remove or repoint all reported references, then retry a dry-run before deletion.',
      });
    }
    const result = removeResource({
      resourceName: request.resourceName,
      deleteFile: request.deleteFile === true,
    });
    return {
      dryRun: false,
      blocked: false,
      usages,
      ...result,
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
        `resource_text_file_too_large:${
          stat.size
        }:${DEFAULT_MAX_TEXT_RESOURCE_BYTES}`
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
      if (!request.relativePath || typeof request.relativePath !== 'string') {
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
      throw new Error(`resource_file_shared_by:${sharedTargetNames.join(',')}`);
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
    inspectVisualResource,
    importVisualResource,
    replaceVisualResource,
    relocateVisualResource,
    deleteVisualResource,
    readTextResource,
    writeTextResource,
    importLocalResource,
    importStoreResource,
    replaceLocalResource,
    renameResource,
    removeResource,
  };
};
