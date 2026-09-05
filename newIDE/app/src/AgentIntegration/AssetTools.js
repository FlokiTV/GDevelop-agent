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

type AssetToolsOptions = {|
  project: gdProject,
  resourceManagementProps: ResourceManagementProps,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
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
}: {|
  project: gdProject,
  sourcePath: string,
  copyToProject: boolean,
|}) => {
  if (!fs || !path) throw new Error('local_filesystem_unavailable');
  const resolvedSourcePath = path.resolve(sourcePath);
  if (
    !fs.existsSync(resolvedSourcePath) ||
    !fs.statSync(resolvedSourcePath).isFile()
  ) {
    throw new Error('resource_file_not_found');
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

export const createAssetTools = ({
  project,
  resourceManagementProps,
  triggerUnsavedChanges,
  forceUpdate,
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
      newResource.setFile(preparedFile.storedFilePath);
      newResource.setUserAdded(true);
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
    });

    resource.setFile(preparedFile.storedFilePath);
    resource.setUserAdded(true);
    if (request.preserveOrigin !== true) resource.setOrigin('', '');
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
    importLocalResource,
    replaceLocalResource,
    renameResource,
    removeResource,
  };
};
