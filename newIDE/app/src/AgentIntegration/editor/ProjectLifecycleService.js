// @flow
import { AgentError } from '../core/AgentError';
import LocalFileStorageProvider from '../../ProjectsStorage/LocalFileStorageProvider';

type Options = {|
  project: ?gdProject,
  fileIdentifier: ?string,
  hasUnsavedChanges: boolean,
  createProjectForAgent: (options: any) => Promise<any>,
  openFromFileMetadataWithStorageProvider: (
    fileMetadataAndStorageProviderName: any,
    options?: any
  ) => Promise<void>,
  closeProject: () => Promise<void>,
  saveProject: (options?: any) => Promise<any>,
  saveProjectAsWithStorageProvider: (options?: any) => Promise<any>,
  pathModule: ?{| resolve: (path: string) => string |},
|};

export const createProjectLifecycleService = ({
  project,
  fileIdentifier,
  hasUnsavedChanges,
  createProjectForAgent,
  openFromFileMetadataWithStorageProvider,
  closeProject,
  saveProject,
  saveProjectAsWithStorageProvider,
  pathModule,
}: Options) => ({
  create: async ({ name, templateSlug }: any) => {
    if (project) throw new AgentError({ code: 'project_already_open' });
    if (!name || typeof name !== 'string') {
      throw new AgentError({ code: 'missing_project_name' });
    }
    const { createdProject, exampleSlug } = await createProjectForAgent({
      name,
      exampleSlug: typeof templateSlug === 'string' ? templateSlug : null,
    });
    if (!createdProject) {
      throw new AgentError({ code: 'project_creation_failed' });
    }
    return {
      created: true,
      projectName: createdProject.getName(),
      projectUuid: createdProject.getProjectUuid(),
      templateSlug: exampleSlug,
      needsSaveAs: true,
    };
  },

  open: async ({ filePath, discardUnsavedChanges = false }: any) => {
    if (!filePath || typeof filePath !== 'string') {
      throw new AgentError({ code: 'missing_project_file_path' });
    }
    if (hasUnsavedChanges && !discardUnsavedChanges) {
      throw new AgentError({
        code: 'unsaved_changes_require_explicit_discard',
        message:
          'The current project has unsaved changes. Explicitly allow discard before opening another project.',
      });
    }
    await openFromFileMetadataWithStorageProvider(
      {
        storageProviderName: LocalFileStorageProvider.internalName,
        fileMetadata: { fileIdentifier: filePath },
      },
      { ignoreUnsavedChanges: !!discardUnsavedChanges }
    );
    return { opened: true, filePath };
  },

  close: async ({ discardUnsavedChanges = false }: any = {}) => {
    if (!project) return { closed: false, reason: 'no_project_open' };
    if (hasUnsavedChanges && !discardUnsavedChanges) {
      throw new AgentError({
        code: 'unsaved_changes_require_explicit_discard',
        message:
          'The current project has unsaved changes. Explicitly allow discard before closing it.',
      });
    }
    await closeProject();
    return { closed: true };
  },

  save: async () => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    const savedFileMetadata = await saveProject({ skipNewVersionWarning: true });
    if (!savedFileMetadata) {
      throw new AgentError({ code: 'project_save_failed' });
    }
    return {
      saved: true,
      fileIdentifier:
        savedFileMetadata.fileIdentifier || fileIdentifier || null,
    };
  },

  saveAs: async ({ filePath, name }: any) => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    if (!pathModule) {
      throw new AgentError({ code: 'local_filesystem_unavailable' });
    }
    if (!filePath || typeof filePath !== 'string') {
      throw new AgentError({ code: 'missing_project_file_path' });
    }
    const resolvedFilePath = pathModule.resolve(filePath);
    const savedFileMetadata = await saveProjectAsWithStorageProvider({
      requestedStorageProvider: LocalFileStorageProvider,
      forcedSavedAsLocation: {
        name: typeof name === 'string' && name ? name : project.getName(),
        fileIdentifier: resolvedFilePath,
      },
    });
    if (!savedFileMetadata) {
      throw new AgentError({ code: 'project_save_as_failed' });
    }
    return { saved: true, fileMetadata: savedFileMetadata };
  },
});
