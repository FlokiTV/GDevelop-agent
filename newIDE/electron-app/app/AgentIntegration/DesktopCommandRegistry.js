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
  {
    name: 'preview.qa.capabilities',
    description:
      'Describe deterministic gameplay, input replay, visual regression and device simulation capabilities without claiming unsupported runtime controls.',
    inputSchema: emptyObjectSchema(),
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.input.record.start',
    description:
      'Start a bounded normalized keyboard/mouse recording for one preview.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        recordingId: { type: 'string', minLength: 1, maxLength: 120 },
      },
    },
    metadata: metadata(),
  },
  {
    name: 'preview.input.record.send',
    description:
      'Send and append one normalized keyboard/mouse event to the active recording.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'event'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        event: { type: 'object', required: ['type'] },
      },
    },
    metadata: metadata(),
  },
  {
    name: 'preview.input.record.stop',
    description:
      'Stop the active recording and return its portable normalized sequence.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { recordingId: { type: 'string' } },
    },
    metadata: metadata(),
  },
  {
    name: 'preview.input.replay',
    description:
      'Replay a recorded normalized sequence against a preview, resetting synthetic runtime/input state first by default.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'recordingId'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        recordingId: { type: 'string', minLength: 1 },
        resetBefore: { type: 'boolean' },
      },
    },
    metadata: metadata({ longRunning: true }),
  },
  {
    name: 'preview.visual.baseline.capture',
    description:
      'Capture a bounded preview PNG baseline in process memory and return its SHA-256 identity.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'baselineId'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        baselineId: { type: 'string', minLength: 1, maxLength: 120 },
        region: { type: 'object' },
        maxWidth: { type: 'integer', minimum: 1, maximum: 8192 },
        maxHeight: { type: 'integer', minimum: 1, maximum: 8192 },
      },
    },
    metadata: metadata({ readOnly: true }),
  },
  {
    name: 'preview.visual.baseline.compare',
    description:
      'Capture the preview and compare it with a stored baseline using exact PNG SHA-256 equality.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'baselineId'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        baselineId: { type: 'string', minLength: 1 },
        region: { type: 'object' },
        maxWidth: { type: 'integer', minimum: 1, maximum: 8192 },
        maxHeight: { type: 'integer', minimum: 1, maximum: 8192 },
      },
    },
    metadata: metadata({ readOnly: true }),
  },
  {
    name: 'preview.multiplayer.capabilities',
    description:
      'Describe multi-preview orchestration and network diagnostics/shaping capabilities without claiming unavailable network primitives.',
    inputSchema: emptyObjectSchema(),
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.multiplayer.clients.list',
    description: 'List live preview clients and their assigned stable aliases.',
    inputSchema: emptyObjectSchema(),
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.multiplayer.clients.assign',
    description:
      'Atomically assign stable aliases to a bounded set of live preview windows.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['clients'],
      properties: {
        clients: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['alias', 'previewWindowId'],
            properties: {
              alias: { type: 'string', minLength: 1, maxLength: 64 },
              previewWindowId: PREVIEW_WINDOW_SCHEMA,
            },
          },
        },
      },
    },
    metadata: metadata({ idempotent: true }),
  },
  {
    name: 'preview.multiplayer.batch',
    description:
      'Run an ordered bounded batch of input, input-sequence, runtime-status or runtime-reset actions against aliased preview clients.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['actions'],
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: {
            type: 'object',
            required: ['alias', 'operation'],
            properties: {
              alias: { type: 'string', minLength: 1, maxLength: 64 },
              operation: {
                type: 'string',
                enum: ['input', 'sequence', 'runtime-status', 'runtime-reset'],
              },
              event: { type: 'object' },
              steps: { type: 'array', maxItems: 200 },
            },
          },
        },
      },
    },
    metadata: metadata({ longRunning: true }),
  },
  {
    name: 'preview.multiplayer.runtime-status',
    description:
      'Read synthetic runtime status across all assigned preview aliases or a selected subset.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        aliases: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.network.capabilities',
    description:
      'Describe bounded redacted HTTP/WebSocket diagnostics and truthful network-shaping support.',
    inputSchema: emptyObjectSchema(),
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.network.capture.start',
    description:
      'Start bounded redacted HTTP/WebSocket metadata capture for one aliased preview client.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias'],
      properties: {
        alias: { type: 'string', minLength: 1, maxLength: 64 },
        maxEvents: { type: 'integer', minimum: 1, maximum: 2000 },
      },
    },
    metadata: metadata(),
  },
  {
    name: 'preview.network.capture.status',
    description:
      'Return capture state and bounded event counts for one aliased preview client.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias'],
      properties: { alias: { type: 'string', minLength: 1, maxLength: 64 } },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.network.capture.read',
    description:
      'Read recent redacted network metadata without response bodies or WebSocket frame payloads.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias'],
      properties: {
        alias: { type: 'string', minLength: 1, maxLength: 64 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
        clear: { type: 'boolean' },
      },
    },
    metadata: metadata({ readOnly: true }),
  },
  {
    name: 'preview.network.capture.stop',
    description:
      'Stop network metadata capture, detach the debugger and return the final bounded redacted events.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias'],
      properties: { alias: { type: 'string', minLength: 1, maxLength: 64 } },
    },
    metadata: metadata(),
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
  previewQaService,
  multiplayerPreviewService,
  previewNetworkDiagnosticsService,
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
    'preview.qa.capabilities': () => previewQaService.capabilities(),
    'preview.input.record.start': input =>
      previewQaService.startRecording(input || {}),
    'preview.input.record.send': input =>
      previewQaService.sendAndRecord(input || {}),
    'preview.input.record.stop': input =>
      previewQaService.stopRecording(input || {}),
    'preview.input.replay': input => previewQaService.replay(input || {}),
    'preview.visual.baseline.capture': input =>
      previewQaService.captureBaseline(input || {}),
    'preview.visual.baseline.compare': input =>
      previewQaService.compareBaseline(input || {}),
    'preview.multiplayer.capabilities': () =>
      multiplayerPreviewService.capabilities(),
    'preview.multiplayer.clients.list': () =>
      multiplayerPreviewService.listClients(),
    'preview.multiplayer.clients.assign': input =>
      multiplayerPreviewService.assignAliases(input || {}),
    'preview.multiplayer.batch': input =>
      multiplayerPreviewService.runBatch(input || {}),
    'preview.multiplayer.runtime-status': input =>
      multiplayerPreviewService.runtimeStatus(input || {}),
    'preview.network.capabilities': () =>
      previewNetworkDiagnosticsService.capabilities(),
    'preview.network.capture.start': input =>
      previewNetworkDiagnosticsService.start(input || {}),
    'preview.network.capture.status': input =>
      previewNetworkDiagnosticsService.status(input || {}),
    'preview.network.capture.read': input =>
      previewNetworkDiagnosticsService.read(input || {}),
    'preview.network.capture.stop': input =>
      previewNetworkDiagnosticsService.stop(input || {}),
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
