const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreviewInputTools,
  normalizeInputEvent,
  isLikelyPreviewWindow,
} = require('./PreviewInputTools');

const makeWindowHarness = () => {
  const events = [];
  let focusCount = 0;
  const previewWindow = {
    id: 7,
    isDestroyed: () => false,
    getTitle: () => 'Preview of Test Game',
    focus: () => {
      focusCount += 1;
    },
    webContents: {
      getURL: () => 'file:///C:/Temp/GDevelop/preview/index.html',
      focus: () => {
        focusCount += 1;
      },
      sendInputEvent: event => events.push(event),
    },
  };
  const editorWindow = {
    ...previewWindow,
    id: 8,
    getTitle: () => 'GDevelop',
    webContents: {
      ...previewWindow.webContents,
      getURL: () => 'file:///C:/GDevelop/index.html',
    },
  };
  const BrowserWindow = {
    fromId: id => (id === 7 ? previewWindow : id === 8 ? editorWindow : null),
  };
  const tools = createPreviewInputTools({
    BrowserWindow,
    isEditorWindow: id => id === 8,
  });
  return {
    tools,
    events,
    previewWindow,
    editorWindow,
    getFocusCount: () => focusCount,
  };
};

test('normalizes keyboard and mouse input', () => {
  assert.deepEqual(
    normalizeInputEvent({
      type: 'keyDown',
      keyCode: 'Space',
      modifiers: ['shift'],
    }),
    { type: 'keyDown', keyCode: 'Space', modifiers: ['shift'] }
  );
  assert.deepEqual(
    normalizeInputEvent({
      type: 'mouseDown',
      x: 10.4,
      y: 20.6,
      button: 'left',
      clickCount: 1,
    }),
    { type: 'mouseDown', x: 10, y: 21, button: 'left', clickCount: 1 }
  );
  assert.throws(
    () => normalizeInputEvent({ type: 'keyDown' }),
    /invalid_input_event:keyCode/
  );
  assert.throws(
    () => normalizeInputEvent({ type: 'touchStart', x: 1, y: 2 }),
    /unsupported_input_event_type:touchStart/
  );
});

test('recognizes preview windows and rejects editor windows', () => {
  const { previewWindow, editorWindow } = makeWindowHarness();
  assert.equal(isLikelyPreviewWindow(previewWindow, () => false), true);
  assert.equal(isLikelyPreviewWindow(editorWindow, id => id === 8), false);
});

test('sends keyboard input to a focused preview', () => {
  const { tools, events, getFocusCount } = makeWindowHarness();
  const result = tools.sendInput({
    windowId: 7,
    inputEvent: { type: 'keyDown', keyCode: 'ArrowRight' },
  });
  assert.equal(result.sent, true);
  assert.equal(result.windowId, 7);
  assert.deepEqual(events, [{ type: 'keyDown', keyCode: 'ArrowRight' }]);
  assert.equal(getFocusCount(), 2);
});

test('runs an input sequence in order', async () => {
  const { tools, events } = makeWindowHarness();
  const result = await tools.sendSequence({
    windowId: 7,
    steps: [
      { event: { type: 'keyDown', keyCode: 'Space' } },
      { event: { type: 'keyUp', keyCode: 'Space' }, delayMs: 1 },
      { event: { type: 'mouseMove', x: 100, y: 120 } },
    ],
  });
  assert.equal(result.steps, 3);
  assert.deepEqual(events.map(event => event.type), [
    'keyDown',
    'keyUp',
    'mouseMove',
  ]);
});

test('reset releases tracked keys and mouse buttons', () => {
  const { tools, events } = makeWindowHarness();
  tools.sendInput({
    windowId: 7,
    inputEvent: { type: 'keyDown', keyCode: 'KeyA' },
  });
  tools.sendInput({
    windowId: 7,
    inputEvent: {
      type: 'mouseDown',
      x: 30,
      y: 40,
      button: 'left',
      clickCount: 1,
    },
  });
  const reset = tools.resetInput({ windowId: 7 });
  assert.deepEqual(reset.releasedKeys, ['KeyA']);
  assert.deepEqual(reset.releasedButtons, ['left']);
  assert.deepEqual(events.slice(-2), [
    { type: 'keyUp', keyCode: 'KeyA' },
    { type: 'mouseUp', button: 'left', clickCount: 1, x: 30, y: 40 },
  ]);
});

test('rejects non-preview target and oversized sequences', async () => {
  const { tools } = makeWindowHarness();
  assert.throws(
    () =>
      tools.sendInput({
        windowId: 8,
        inputEvent: { type: 'keyDown', keyCode: 'Space' },
      }),
    /preview_window_not_found/
  );
  await assert.rejects(
    tools.sendSequence({
      windowId: 7,
      steps: Array.from({ length: 201 }, () => ({
        event: { type: 'keyDown', keyCode: 'Space' },
      })),
    }),
    /too_many_input_sequence_steps/
  );
  assert.equal('handleAction' in tools, false);
});
