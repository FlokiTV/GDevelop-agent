// @flow
import { AgentHost } from './core/AgentHost';
import { createCoreCommandDescriptors } from './core/CoreCommands';
import { createEditorFunctionCommandDescriptors } from './editor/EditorFunctionCommands';

type Options = {|
  environment: any,
  editorFunctionService: {| run: (options: any) => Promise<any> |},
|};

export const createRendererAgentHost = ({
  environment,
  editorFunctionService,
}: Options): AgentHost =>
  new AgentHost({
    environment,
    descriptors: [
      ...createCoreCommandDescriptors(),
      ...createEditorFunctionCommandDescriptors({ editorFunctionService }),
    ],
  });
