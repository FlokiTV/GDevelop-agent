const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewInteractionService } = require('./PreviewInteractionService');

const makeFixture = () => {
  const sentInputEvents = [];
  const executedScripts = [];
  const previewWindow = {
    id: 12,
    isDestroyed: () => false,
    getTitle: () => 'Preview of Game',
    focus: () => {},
    webContents: {
      getURL: () => 'file:///C:/Temp/GDevelop/preview/index.html',
      focus: () => {},
      sendInputEvent: event => sentInputEvents.push(event),
      executeJavaScript: async source => {
        executedScripts.push(source);
        return { installed: true, version: 1 };
      },
    },
  };
  const BrowserWindow = {
    fromId: id => (Number(id) === 12 ? previewWindow : null),
  };
  const service = createPreviewInteractionService({
    BrowserWindow,
    windowRegistry: { isRegistered: () => false },
    isRegisteredPreviewWindow: id => Number(id) === 12,
  });
  return { service, sentInputEvents, executedScripts };
};

test('exposes protocol-independent keyboard/mouse input methods', () => {
  const { service, sentInputEvents } = makeFixture();
  assert.deepEqual(
    service.sendInput({
      windowId: 12,
      event: { type: 'keyDown', keyCode: 'W' },
    }),
    {
      sent: true,
      windowId: 12,
      event: { type: 'keyDown', keyCode: 'W' },
    }
  );
  assert.deepEqual(sentInputEvents, [{ type: 'keyDown', keyCode: 'W' }]);
});

test('exposes runtime/touch methods directly without an action router', async () => {
  const { service, executedScripts } = makeFixture();
  const status = await service.getRuntimeStatus({ windowId: 12 });
  assert.equal(status.windowId, 12);

  await service.sendTouch({
    windowId: 12,
    action: 'start',
    identifier: 1,
    x: 10,
    y: 20,
  });
  assert.ok(executedScripts.some(source => source.includes('touch')));
  assert.equal(typeof service.sendTouch, 'function');
});
