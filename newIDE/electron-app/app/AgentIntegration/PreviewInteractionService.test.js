const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewInteractionService } = require('./PreviewInteractionService');

const makeFixture = () => {
  const sentInputEvents = [];
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
        if (source.includes('__GDevelopAgentPreviewRuntime')) {
          return { installed: true, version: 1 };
        }
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
  return { service, sentInputEvents };
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

test('keeps legacy action routing as a transitional adapter only', async () => {
  const { service } = makeFixture();
  assert.equal(service.canHandleLegacyAction('preview-input'), true);
  assert.equal(service.canHandleLegacyAction('preview-touch'), true);
  assert.equal(service.canHandleLegacyAction('unknown'), false);
  assert.throws(
    () => service.handleLegacyAction({ type: 'unknown' }),
    error => error.code === 'unsupported_preview_interaction_action'
  );
});
