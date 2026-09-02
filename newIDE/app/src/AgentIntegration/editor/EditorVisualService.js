// @flow
import { AgentError } from '../core/AgentError';

type Options = {|
  project: ?gdProject,
  editorVisualTools: ?any,
  onOpenLayout: (sceneName: string, options: any) => void,
|};

export const createEditorVisualService = ({
  project,
  editorVisualTools,
  onOpenLayout,
}: Options) => {
  const requireTools = () => {
    if (!project || !editorVisualTools) {
      throw new AgentError({ code: 'no_project_open' });
    }
    return editorVisualTools;
  };

  return {
    getStatus: () => ({
      openSceneEditors: requireTools().listOpenSceneEditors(),
    }),

    selectInstances: (input: any) => requireTools().selectInstances(input),

    focusSelection: (input: any) => requireTools().focusSelection(input),

    openScene: ({ sceneName, mode = 'scene' }: any) => {
      if (!project) throw new AgentError({ code: 'no_project_open' });
      if (
        typeof sceneName !== 'string' ||
        !sceneName ||
        !project.hasLayoutNamed(sceneName)
      ) {
        throw new AgentError({ code: 'scene_not_found' });
      }
      if (!['scene', 'events', 'both'].includes(mode)) {
        throw new AgentError({ code: 'invalid_scene_open_mode' });
      }

      onOpenLayout(sceneName, {
        openEventsEditor: mode === 'events' || mode === 'both',
        openSceneEditor: mode !== 'events',
        focusWhenOpened: mode === 'events' ? 'events' : 'scene',
      });
      return { opened: true, sceneName, mode };
    },
  };
};
