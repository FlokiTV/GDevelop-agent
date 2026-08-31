const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createDesktopIntegrationHost } = require('./DesktopIntegrationHost');

const makeWindow = id => ({
  id,
  isDestroyed: () => false,
  isFocused: () => true,
  isVisible: () => true,
  getTitle: () => 'GDevelop',
  getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  webContents: {
    send: () => {},
    getURL: () => 'file:///editor/index.html',
    capturePage: async () => ({ toPNG: () => Buffer.from('png') }),
  },
});

test('owns desktop services and cleans IPC state exactly once', () => {
  const ipcMain = new EventEmitter();
  const editorWindow = makeWindow(1);
  const BrowserWindow = {
    fromWebContents: sender =>
      sender === editorWindow.webContents ? editorWindow : null,
    fromId: id => (Number(id) === 1 ? editorWindow : null),
    getFocusedWindow: () => editorWindow,
    getAllWindows: () => [editorWindow],
  };

  const host = createDesktopIntegrationHost({
    BrowserWindow,
    ipcMain,
    desktopCapturer: null,
    isRegisteredPreviewWindow: () => false,
  });

  ipcMain.emit(
    'gdevelop-agent-integration:register',
    { sender: editorWindow.webContents },
    { active: true, fileIdentifier: 'C:/game/game.json' }
  );
  assert.equal(host.windowRegistry.size, 1);
  assert.equal(typeof host.rendererBridge.executeCommand, 'function');
  assert.equal(typeof host.previewInteractionService.sendInput, 'function');
  assert.equal(typeof host.windowCaptureService.capture, 'function');

  host.dispose();
  host.dispose();
  assert.equal(host.windowRegistry.size, 0);
  assert.equal(
    ipcMain.listenerCount('gdevelop-agent-integration:register'),
    0
  );
  assert.equal(
    ipcMain.listenerCount('gdevelop-agent-integration:command-response'),
    0
  );
});
