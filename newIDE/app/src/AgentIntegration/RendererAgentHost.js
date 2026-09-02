// @flow
import { AgentHost } from './core/AgentHost';
import { createCoreCommandDescriptors } from './core/CoreCommands';
import { createDiagnosticsCommandDescriptors } from './editor/DiagnosticsCommands';
import { createEditorFunctionCommandDescriptors } from './editor/EditorFunctionCommands';
import { createEditorVisualCommandDescriptors } from './editor/EditorVisualCommands';
import { createEventCommandDescriptors } from './editor/EventCommands';
import { createExportCommandDescriptors } from './editor/ExportCommands';
import { createProjectLifecycleCommandDescriptors } from './editor/ProjectLifecycleCommands';
import { createResourceCommandDescriptors } from './editor/ResourceCommands';
import { createValidationCommandDescriptors } from './editor/ValidationCommands';
import { createPreviewCommandDescriptors } from './runtime/PreviewCommands';
import { createRuntimeCommandDescriptors } from './runtime/RuntimeCommands';
import { createSafetyCommandDescriptors } from './safety/SafetyCommands';

type Options = {|
  environment: any,
  assetTools: any,
  diagnosticsTools: any,
  editorFunctionService: {| run: (options: any) => Promise<any> |},
  editorVisualService: any,
  eventTools: any,
  exportService: any,
  previewService: any,
  projectLifecycleService: any,
  runtimeTelemetry: any,
  safetyService: any,
  validationService: any,
|};

export const createRendererAgentHost = ({
  environment,
  assetTools,
  diagnosticsTools,
  editorFunctionService,
  editorVisualService,
  eventTools,
  exportService,
  previewService,
  projectLifecycleService,
  runtimeTelemetry,
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
      ...createEditorVisualCommandDescriptors({ editorVisualService }),
      ...createValidationCommandDescriptors({ validationService }),
      ...createExportCommandDescriptors({ exportService }),
      ...createPreviewCommandDescriptors({ previewService }),
      ...createRuntimeCommandDescriptors({ runtimeTelemetry }),
      ...createEditorFunctionCommandDescriptors({ editorFunctionService }),
    ],
  });
