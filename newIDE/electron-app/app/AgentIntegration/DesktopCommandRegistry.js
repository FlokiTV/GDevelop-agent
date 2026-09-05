const PREVIEW_WINDOW_SCHEMA = {
  type: 'integer',
  minimum: 1,
  description: 'Electron window id of a running GDevelop preview.',
};

const emptyObjectSchema = () => ({
  type: 'object',
  additionalProperties: false,
  properties: {},
});

const metadata = ({
  readOnly = false,
  idempotent = false,
  longRunning = false,
} = {}) => ({
  readOnly,
  destructive: false,
  idempotent,
  longRunning,
  requiresProject: false,
  modifiesProject: false,
});

const DESCRIPTORS = [
  {
    name: 'desktop.windows.list',
    description:
      'List live GDevelop editor and preview windows with ids, bounds, focus and project association.',
    inputSchema: emptyObjectSchema(),
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'desktop.window.capture',
    description:
      'Capture one GDevelop editor or preview window as a PNG image. Uses the focused window when windowId is omitted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        windowId: {
          type: 'integer',
          minimum: 1,
          description:
            'Electron window id. Omit to capture the focused window.',
        },
        region: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y', 'width', 'height'],
          properties: {
            x: { type: 'integer', minimum: 0 },
            y: { type: 'integer', minimum: 0 },
            width: { type: 'integer', minimum: 1 },
            height: { type: 'integer', minimum: 1 },
          },
          description:
            'Optional capture rectangle in window content coordinates.',
        },
        maxWidth: { type: 'integer', minimum: 1, maximum: 8192 },
        maxHeight: { type: 'integer', minimum: 1, maximum: 8192 },
      },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.input.send',
    description:
      'Send one validated keyboard or mouse input event to a running preview window.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'event'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        event: {
          type: 'object',
          description:
            'Electron sendInputEvent-compatible keyboard/mouse payload validated by AgentIntegration.',
          required: ['type'],
          properties: {
            type: { type: 'string' },
            keyCode: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            button: { type: 'string' },
            clickCount: { type: 'number' },
            deltaX: { type: 'number' },
            deltaY: { type: 'number' },
            wheelTicksX: { type: 'number' },
            wheelTicksY: { type: 'number' },
            hasPreciseScrollingDeltas: { type: 'boolean' },
            canScroll: { type: 'boolean' },
            modifiers: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    metadata: metadata(),
  },
  {
    name: 'preview.input.sequence',
    description:
      'Send an ordered keyboard/mouse input sequence to a running preview, with bounded per-step delays.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'steps'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['event'],
            properties: {
              event: { type: 'object', required: ['type'] },
              delayMs: { type: 'number', minimum: 0, maximum: 5000 },
            },
          },
        },
      },
    },
    metadata: metadata({ longRunning: true }),
  },
  {
    name: 'preview.input.reset',
    description:
      'Release keyboard keys and mouse buttons currently tracked as pressed for a preview window.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId'],
      properties: { previewWindowId: PREVIEW_WINDOW_SCHEMA },
    },
    metadata: metadata({ idempotent: true }),
  },
  {
    name: 'preview.input.touch',
    description:
      'Send a synthetic touch start/move/end/cancel event to a running preview.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'action', 'x', 'y'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        action: { type: 'string', enum: ['start', 'move', 'end', 'cancel'] },
        identifier: { type: 'integer', minimum: 0 },
        x: { type: 'number', minimum: 0 },
        y: { type: 'number', minimum: 0 },
        force: { type: 'number' },
      },
    },
    metadata: metadata(),
  },
  {
    name: 'preview.input.gamepad',
    description:
      'Connect, update, disconnect or reset a virtual gamepad in a running preview.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'action'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        action: {
          type: 'string',
          enum: ['connect', 'update', 'disconnect', 'reset'],
        },
        index: { type: 'integer', minimum: 0, maximum: 15 },
        id: { type: 'string' },
        mapping: { type: 'string' },
        axes: { type: 'array', items: { type: 'number' } },
        buttons: { type: 'array' },
      },
    },
    metadata: metadata(),
  },
  {
    name: 'preview.input.runtime-status',
    description:
      'Ensure the synthetic touch/gamepad runtime is installed in a preview and return its status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId'],
      properties: { previewWindowId: PREVIEW_WINDOW_SCHEMA },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.input.runtime-reset',
    description:
      'Reset synthetic touch and virtual gamepad state in a running preview.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId'],
      properties: { previewWindowId: PREVIEW_WINDOW_SCHEMA },
    },
    metadata: metadata({ idempotent: true }),
  },
];

const makeResult = (descriptor, data) => ({
  command: descriptor.name,
  data,
  meta: {
    readOnly: !!descriptor.metadata.readOnly,
    modifiesProject: false,
  },
});

const createDesktopCommandRegistry = ({
  windowCaptureService,
  previewInteractionService,
}) => {
  const handlers = {
    'desktop.windows.list': () => windowCaptureService.listWindows(),
    'desktop.window.capture': async input => {
      const captured = await windowCaptureService.capture(input || {});
      return {
        windowId: captured.windowId,
        mimeType: captured.mimeType,
        region: captured.region || null,
        maxWidth: captured.maxWidth || null,
        maxHeight: captured.maxHeight || null,
        imageBuffer: captured.data,
      };
    },
    'preview.input.send': input =>
      previewInteractionService.sendInput(input || {}),
    'preview.input.sequence': input =>
      previewInteractionService.sendSequence(input || {}),
    'preview.input.reset': input =>
      previewInteractionService.resetInput(input || {}),
    'preview.input.touch': input =>
      previewInteractionService.sendTouch(input || {}),
    'preview.input.gamepad': input =>
      previewInteractionService.sendGamepad(input || {}),
    'preview.input.runtime-status': input =>
      previewInteractionService.getRuntimeStatus(input || {}),
    'preview.input.runtime-reset': input =>
      previewInteractionService.resetRuntime(input || {}),
  };
  const descriptorsByName = new Map(
    DESCRIPTORS.map(descriptor => [descriptor.name, descriptor])
  );

  const listDescriptors = () => DESCRIPTORS.slice();
  const has = command => descriptorsByName.has(command);
  const execute = async ({ command, input = {} }) => {
    const descriptor = descriptorsByName.get(command);
    const handler = handlers[command];
    if (!descriptor || !handler) {
      const error = new Error(`desktop_command_not_found:${String(command)}`);
      error.code = 'desktop_command_not_found';
      throw error;
    }
    return makeResult(descriptor, await handler(input));
  };

  return { listDescriptors, has, execute };
};

module.exports = {
  DESCRIPTORS,
  createDesktopCommandRegistry,
};
