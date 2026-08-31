// @flow
import { AgentHost } from './core/AgentHost';
import { createCoreCommandDescriptors } from './core/CoreCommands';
import { createEditorFunctionCommandDescriptors } from './editor/EditorFunctionCommands';
import { createProjectLifecycleCommandDescriptors } from './editor/ProjectLifecycleCommands';
import { createSafetyCommandDescriptors } from './safety/SafetyCommands';

type Options = {|
  environment: any,
  editorFunctionService: {| run: (options: any) => Promise<any> |},
  projectLifecycleService: any,
  safetyService: any,
|};

export const createRendererAgentHost = ({
  environment,
  editorFunctionService,
  projectLifecycleService,
  safetyService,
}: Options): AgentHost =>
  new AgentHost({
    environment,
    descriptors: [
      ...createCoreCommandDescriptors(),
      ...createProjectLifecycleCommandDescriptors({ projectLifecycleService }),
      ...createSafetyCommandDescriptors({ safetyService }),
      ...createEditorFunctionCommandDescriptors({ editorFunctionService }),
    ],
  });
