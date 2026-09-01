const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DESCRIPTORS,
  createDesktopCommandRegistry,
} = require('./DesktopCommandRegistry');

test('lists deterministic desktop command descriptors without protocol metadata', () => {
  const registry = createDesktopCommandRegistry({
    windowCaptureService: {},
    previewInteractionService: {},
  });
  const descriptors = registry.listDescriptors();

  assert.deepEqual(
    descriptors.map(descriptor => descriptor.name),
    DESCRIPTORS.map(descriptor => descriptor.name)
  );
  assert.equal(descriptors.some(descriptor => descriptor.name.includes('/v1')), false);
  assert.equal(
    descriptors.some(descriptor => JSON.stringify(descriptor).includes('mcp')),
    false
  );
  assert.equal(registry.has('desktop.window.capture'), true);
  assert.equal(registry.has('project.status'), false);
});

test('executes windows, capture and preview input through injected services', async () => {
  const calls = [];
  const registry = createDesktopCommandRegistry({
    windowCaptureService: {
      listWindows: () => [{ windowId: 1, editorWindow: true }],
      capture: async input => {
        calls.push(['capture', input]);
        return {
          windowId: Number(input.windowId),
          mimeType: 'image/png',
          data: Buffer.from('png-data'),
        };
      },
    },
    previewInteractionService: {
      sendInput: input => {
        calls.push(['sendInput', input]);
        return { sent: true };
      },
      sendSequence: async input => {
        calls.push(['sendSequence', input]);
        return { sent: true, steps: input.steps.length };
      },
      resetInput: input => {
        calls.push(['resetInput', input]);
        return { reset: true };
      },
      sendTouch: input => {
        calls.push(['sendTouch', input]);
        return { sent: true };
      },
      sendGamepad: input => {
        calls.push(['sendGamepad', input]);
        return { sent: true };
      },
      getRuntimeStatus: input => {
        calls.push(['getRuntimeStatus', input]);
        return { installed: true };
      },
      resetRuntime: input => {
        calls.push(['resetRuntime', input]);
        return { reset: true };
      },
    },
  });

  const windows = await registry.execute({
    command: 'desktop.windows.list',
    input: {},
  });
  assert.equal(windows.data[0].windowId, 1);
  assert.equal(windows.meta.readOnly, true);

  const capture = await registry.execute({
    command: 'desktop.window.capture',
    input: { windowId: 9 },
  });
  assert.equal(capture.data.windowId, 9);
  assert.equal(capture.data.mimeType, 'image/png');
  assert.deepEqual(capture.data.imageBuffer, Buffer.from('png-data'));

  await registry.execute({
    command: 'preview.input.send',
    input: { previewWindowId: 2, event: { type: 'keyDown', keyCode: 'W' } },
  });
  await registry.execute({
    command: 'preview.input.sequence',
    input: {
      previewWindowId: 2,
      steps: [{ event: { type: 'keyDown', keyCode: 'W' } }],
    },
  });
  await registry.execute({
    command: 'preview.input.reset',
    input: { previewWindowId: 2 },
  });
  await registry.execute({
    command: 'preview.input.touch',
    input: { previewWindowId: 2, action: 'start', x: 10, y: 20 },
  });
  await registry.execute({
    command: 'preview.input.gamepad',
    input: { previewWindowId: 2, action: 'connect' },
  });
  await registry.execute({
    command: 'preview.input.runtime-status',
    input: { previewWindowId: 2 },
  });
  await registry.execute({
    command: 'preview.input.runtime-reset',
    input: { previewWindowId: 2 },
  });

  assert.deepEqual(
    calls.map(call => call[0]),
    [
      'capture',
      'sendInput',
      'sendSequence',
      'resetInput',
      'sendTouch',
      'sendGamepad',
      'getRuntimeStatus',
      'resetRuntime',
    ]
  );
});

test('rejects unknown desktop commands', async () => {
  const registry = createDesktopCommandRegistry({
    windowCaptureService: {},
    previewInteractionService: {},
  });
  await assert.rejects(
    registry.execute({ command: 'desktop.missing', input: {} }),
    error => error && error.code === 'desktop_command_not_found'
  );
});
