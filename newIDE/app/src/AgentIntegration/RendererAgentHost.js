// @flow
import { AgentHost } from './core/AgentHost';
import { createCoreCommandDescriptors } from './core/CoreCommands';
import { createEditorFunctionCommandDescriptors } from './editor/EditorFunctionCommands';
import { createEventCommandDescriptors } from './editor/EventCommands';
import { createProjectLifecycleCommandDescriptors } from './editor/ProjectLifecycleCommands';
import { createResourceCommandDescriptors } from './editor/ResourceCommands';
import { createSafetyCommandDescriptors } from './safety/SafetyCommands';

type Options = {|
  environment: any,
  assetTools: any,
  editorFunctionService: {| run: (options: any) => Promise<any> |},
  eventTools: any,
  projectLifecycleService: any,
  safetyService: any,
|};

export const createRendererAgentHost = ({
  environment,
  assetTools,
  editorFunctionService,
  eventTools,
  projectLifecycleService,
  safetyService,
}: Options): AgentHost =>
  new AgentHost({
    environment,
    descriptors: [
      ...createCoreCommandDescriptors(),
      ...createProjectLifecycleCommandDescriptors({ projectLifecycleService }),
      ...createSafetyCommandDescriptors({ safetyService }),
      ...createEventCommandDescriptors({ eventTools }),
      ...createResourceCommandDescriptors({ assetTools }),
      ...createEditorFunctionCommandDescriptors({ editorFunctionService }),
    ],
  });
