// @flow
import { AgentHost } from './core/AgentHost';
import { createCoreCommandDescriptors } from './core/CoreCommands';
import { createEditorFunctionCommandDescriptors } from './editor/EditorFunctionCommands';
import { createProjectLifecycleCommandDescriptors } from './editor/ProjectLifecycleCommands';

type Options = {|
  environment: any,
  editorFunctionService: {| run: (options: any) => Promise<any> |},
  projectLifecycleService: any,
|};

export const createRendererAgentHost = ({
  environment,
  editorFunctionService,
  projectLifecycleService,
}: Options): AgentHost =>
  new AgentHost({
    environment,
    descriptors: [
      ...createCoreCommandDescriptors(),
      ...createProjectLifecycleCommandDescriptors({ projectLifecycleService }),
      ...createEditorFunctionCommandDescriptors({ editorFunctionService }),
    ],
  });
