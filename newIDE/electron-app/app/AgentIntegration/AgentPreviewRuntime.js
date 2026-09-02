const fs = require('fs');
const path = require('path');
const { isLikelyPreviewWindow } = require('./PreviewInputTools');

const CLIENT_SOURCE = fs.readFileSync(
  path.join(__dirname, 'AgentPreviewRuntimeClient.js'),
  'utf8'
);
const RUNTIME_GLOBAL = '__GDevelopAgentPreviewRuntime';

const makeError = (code, message = code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const resolvePreviewWindow = ({
  BrowserWindow,
  isEditorWindow,
  isRegisteredPreviewWindow,
  windowId,
}) => {
  if (windowId == null || windowId === '')
    throw makeError('missing_preview_window_id');
  const id = Number(windowId);
  if (!Number.isInteger(id) || id <= 0)
    throw makeError('invalid_preview_window_id');
  const window = BrowserWindow.fromId(id);
  if (!isLikelyPreviewWindow(window, isEditorWindow, isRegisteredPreviewWindow))
    throw makeError('preview_window_not_found');
  return window;
};

const runtimeCall = (method, payload) =>
  `window[${JSON.stringify(RUNTIME_GLOBAL)}][${JSON.stringify(
    method
  )}](${JSON.stringify(payload)})`;

const validateTouch = body => {
  if (!['start', 'move', 'end', 'cancel'].includes(body.action))
    throw makeError('invalid_touch_action');
  const identifier = Number(body.identifier == null ? 0 : body.identifier);
  const x = Number(body.x);
  const y = Number(body.y);
  if (!Number.isInteger(identifier) || identifier < 0)
    throw makeError('invalid_touch_identifier');
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)
    throw makeError('invalid_touch_coordinates');
  return {
    action: body.action,
    identifier,
    x,
    y,
    force: body.force == null ? 1 : Number(body.force),
  };
};

const validateGamepad = body => {
  if (!['connect', 'update', 'disconnect', 'reset'].includes(body.action))
    throw makeError('invalid_gamepad_action');
  const index = Number(body.index == null ? 0 : body.index);
  if (!Number.isInteger(index) || index < 0 || index > 15)
    throw makeError('invalid_gamepad_index');
  if (body.axes != null && !Array.isArray(body.axes))
    throw makeError('invalid_gamepad_axes');
  if (body.buttons != null && !Array.isArray(body.buttons))
    throw makeError('invalid_gamepad_buttons');
  return {
    action: body.action,
    index,
    id: typeof body.id === 'string' ? body.id : undefined,
    mapping: typeof body.mapping === 'string' ? body.mapping : undefined,
    axes: body.axes,
    buttons: body.buttons,
  };
};

const createAgentPreviewRuntime = ({
  BrowserWindow,
  isEditorWindow,
  isRegisteredPreviewWindow,
}) => {
  const getWindow = windowId =>
    resolvePreviewWindow({
      BrowserWindow,
      isEditorWindow,
      isRegisteredPreviewWindow,
      windowId,
    });

  const ensureInstalled = async windowId => {
    const targetWindow = getWindow(windowId);
    targetWindow.focus();
    targetWindow.webContents.focus();
    const status = await targetWindow.webContents.executeJavaScript(
      CLIENT_SOURCE,
      true
    );
    return { windowId: targetWindow.id, ...status };
  };

  const call = async (windowId, method, payload) => {
    const targetWindow = getWindow(windowId);
    await ensureInstalled(targetWindow.id);
    const result = await targetWindow.webContents.executeJavaScript(
      runtimeCall(method, payload),
      true
    );
    return { windowId: targetWindow.id, result };
  };

  return {
    ensureInstalled,
    call,
  };
};

module.exports = {
  createAgentPreviewRuntime,
  validateTouch,
  validateGamepad,
};
