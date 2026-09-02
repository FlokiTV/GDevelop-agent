const { createPreviewInputTools } = require('./PreviewInputTools');
const {
  createAgentPreviewRuntime,
  validateTouch,
  validateGamepad,
} = require('./AgentPreviewRuntime');

const createPreviewInteractionService = ({
  BrowserWindow,
  windowRegistry,
  isRegisteredPreviewWindow,
}) => {
  const isEditorWindow = windowId => windowRegistry.isRegistered(windowId);
  const inputTools = createPreviewInputTools({
    BrowserWindow,
    isEditorWindow,
    isRegisteredPreviewWindow,
  });
  const previewRuntime = createAgentPreviewRuntime({
    BrowserWindow,
    isEditorWindow,
    isRegisteredPreviewWindow,
  });

  const getWindowId = input =>
    input && input.previewWindowId != null
      ? input.previewWindowId
      : input && input.windowId;

  const sendInput = input =>
    inputTools.sendInput({
      windowId: getWindowId(input),
      inputEvent: input && (input.event || input.inputEvent),
    });

  const sendSequence = input =>
    inputTools.sendSequence({
      windowId: getWindowId(input),
      steps: input && input.steps,
    });

  const resetInput = input =>
    inputTools.resetInput({ windowId: getWindowId(input) });

  const getRuntimeStatus = input =>
    previewRuntime.ensureInstalled(getWindowId(input));

  const resetRuntime = input =>
    previewRuntime.call(getWindowId(input), 'reset', {});

  const sendTouch = input =>
    previewRuntime.call(getWindowId(input), 'touch', validateTouch(input || {}));

  const sendGamepad = input =>
    previewRuntime.call(
      getWindowId(input),
      'gamepad',
      validateGamepad(input || {})
    );

  return {
    sendInput,
    sendSequence,
    resetInput,
    getRuntimeStatus,
    resetRuntime,
    sendTouch,
    sendGamepad,
  };
};

module.exports = { createPreviewInteractionService };
