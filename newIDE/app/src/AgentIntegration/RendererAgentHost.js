// @flow
import { AgentHost } from './core/AgentHost';
import { createCoreCommandDescriptors } from './core/CoreCommands';
import { createDiagnosticsCommandDescriptors } from './editor/DiagnosticsCommands';
import { createEditorFunctionCommandDescriptors } from './editor/EditorFunctionCommands';
import { createEventCommandDescriptors } from './editor/EventCommands';
import { createExportCommandDescriptors } from './editor/ExportCommands';
import { createProjectLifecycleCommandDescriptors } from './editor/ProjectLifecycleCommands';
import { createResourceCommandDescriptors } from './editor/ResourceCommands';
import { createValidationCommandDescriptors } from './editor/ValidationCommands';
import { createSafetyCommandDescriptors } from './safety/SafetyCommands';

type Options = {|
  environment: any,
  assetTools: any,
  diagnosticsTools: any,
  editorFunctionService: {| run: (options: any) => Promise<any> |},
  eventTools: any,
  exportService: any,
  projectLifecycleService: any,
  safetyService: any,
  validationService: any,
|};

export const createRendererAgentHost = ({
  environment,
  assetTools,
  diagnosticsTools,
  editorFunctionService,
  eventTools,
  exportService,
  projectLifecycleService,
  safetyService,
  validationService,
}: Options): AgentHost =>
  new AgentHost({
    environment,
    descriptors: [
      ...createCoreCommandDescriptors(),
      ...createProjectLifecycleCommandDescriptors({ projectLifecycleService }),
      ...createSafetyCommandDescriptors({ safetyService }),
      ...createEventCommandDescriptors({ eventTools }),
      ...createResourceCommandDescriptors({ assetTools }),
      ...createDiagnosticsCommandDescriptors({ diagnosticsTools }),
      ...createValidationCommandDescriptors({ validationService }),
      ...createExportCommandDescriptors({ exportService }),
      ...createEditorFunctionCommandDescriptors({ editorFunctionService }),
    ],
  });
