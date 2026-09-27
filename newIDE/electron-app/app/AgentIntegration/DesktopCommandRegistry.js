const PREVIEW_WINDOW_SCHEMA = {
  type: 'integer',
  minimum: 1,
  description: 'Electron window id of a running GDevelop preview.',
};

const PREVIEW_TARGET_SELECTOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objectName: { type: 'string', minLength: 1, maxLength: 500 },
    instanceId: { type: 'integer', minimum: 0 },
    instanceIndex: { type: 'integer', minimum: 0, maximum: 100000 },
  },
  description:
    'Runtime-object selector. Provide objectName and optional instanceIndex, or a runtime instanceId from runtime/preview inspection.',
};

const PREVIEW_STATE_CONDITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['variable'],
  properties: {
    scope: { type: 'string', enum: ['scene', 'global'] },
    variable: { type: 'string', minLength: 1, maxLength: 500 },
    operator: {
      type: 'string',
      enum: [
        'equals',
        'not-equals',
        'gt',
        'gte',
        'lt',
        'lte',
        'truthy',
        'falsy',
      ],
    },
    value: {},
    timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
    stableFrames: { type: 'integer', minimum: 1, maximum: 10 },
  },
};

const PREVIEW_CONTROL_STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    disabledWhen: PREVIEW_STATE_CONDITION_SCHEMA,
    legacyWhen: PREVIEW_STATE_CONDITION_SCHEMA,
  },
  description:
    'Optional explicit runtime-state predicates used to classify disabled/legacy controls without guessing from names or visuals.',
};

const PREVIEW_LAYOUT_REGION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'x', 'y', 'width', 'height'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 160 },
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number', exclusiveMinimum: 0 },
    height: { type: 'number', exclusiveMinimum: 0 },
  },
  description:
    'Caller-declared named region in preview viewport CSS pixels for structural containment or safe-area assertions.',
};

const PREVIEW_LAYOUT_TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 160 },
    kind: { type: 'string', enum: ['object', 'layer', 'region'] },
    objectName: { type: 'string', minLength: 1, maxLength: 500 },
    instanceId: { type: 'integer', minimum: 0 },
    instanceIndex: { type: 'integer', minimum: 0, maximum: 100000 },
    layer: { type: 'string', minLength: 1, maxLength: 500 },
    region: { type: 'string', minLength: 1, maxLength: 160 },
    includeHidden: { type: 'boolean' },
  },
  description:
    'Structural target selector. Object targets use objectName/instanceId/instanceIndex, layer targets use layer, and region targets reference a named region.',
};

const PREVIEW_LAYOUT_ASSERTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 160 },
    type: {
      type: 'string',
      enum: [
        'visible',
        'not-clipped',
        'within',
        'no-overlap',
        'min-gap',
        'align',
        'safe-area',
        'text-fit',
      ],
    },
    severity: { type: 'string', enum: ['error', 'warning', 'info'] },
    targets: {
      type: 'array',
      maxItems: 200,
      items: { type: 'string', minLength: 1, maxLength: 160 },
    },
    includeHidden: { type: 'boolean' },
    scope: { type: 'string', enum: ['viewport', 'canvas'] },
    container: { type: 'string', minLength: 1, maxLength: 160 },
    region: { type: 'string', minLength: 1, maxLength: 160 },
    padding: { type: 'number', minimum: 0 },
    allowPairs: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: { type: 'string', minLength: 1, maxLength: 160 },
      },
    },
    axis: { type: 'string', enum: ['horizontal', 'vertical'] },
    minimum: { type: 'number', minimum: 0 },
    edge: {
      type: 'string',
      enum: ['left', 'right', 'top', 'bottom', 'center-x', 'center-y'],
    },
    tolerance: { type: 'number', minimum: 0 },
    relation: { type: 'string', enum: ['inside', 'outside'] },
    textTarget: { type: 'string', minLength: 1, maxLength: 160 },
  },
  description:
    'Deterministic structural assertion evaluated against resolved runtime visual bounds.',
};

const PREVIEW_CAPTURE_REGION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number', exclusiveMinimum: 0 },
    height: { type: 'number', exclusiveMinimum: 0 },
  },
  description: 'Explicit preview viewport rectangle in CSS pixels.',
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
      'Capture one GDevelop editor or preview window as PNG with bounded readiness/retry and desktop-capture fallback. Uses the focused window when windowId is omitted.',
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
        captureAttempts: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
          description:
            'Bounded capture attempts before returning a persistent empty-capture diagnostic.',
        },
        retryDelayMs: {
          type: 'integer',
          minimum: 0,
          maximum: 2000,
          description: 'Delay between empty capture attempts.',
        },
        readyTimeoutMs: {
          type: 'integer',
          minimum: 0,
          maximum: 10000,
          description:
            'Maximum time to wait for preview content loading to settle before capture attempts.',
        },
      },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'agent.workspace.temp.capabilities',
    description:
      'Describe MCP-managed temporary workspace isolation, owner binding, TTL cleanup and artifact limits.',
    inputSchema: emptyObjectSchema(),
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'agent.workspace.temp.create',
    description:
      'Create an isolated temporary workspace namespace owned by the current MCP agent/session and optionally associated with a task.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        purpose: { type: 'string', maxLength: 240 },
        taskId: { type: 'string', maxLength: 160 },
        ttlMs: { type: 'integer', minimum: 1000, maximum: 300000 },
      },
    },
    metadata: metadata(),
  },
  {
    name: 'agent.workspace.temp.status',
    description:
      'Read one owned temporary namespace or list namespaces owned by the current MCP agent/session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        namespaceId: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'agent.workspace.temp.heartbeat',
    description:
      'Renew the TTL heartbeat of an owned temporary workspace namespace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['namespaceId'],
      properties: {
        namespaceId: { type: 'string', minLength: 1, maxLength: 200 },
        ttlMs: { type: 'integer', minimum: 1000, maximum: 300000 },
      },
    },
    metadata: metadata({ idempotent: true }),
  },
  {
    name: 'agent.workspace.temp.write',
    description:
      'Write one bounded artifact inside an owned temporary namespace. Existing files require overwrite=true and cross-agent access is rejected.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['namespaceId', 'relativePath', 'content'],
      properties: {
        namespaceId: { type: 'string', minLength: 1, maxLength: 200 },
        relativePath: { type: 'string', minLength: 1, maxLength: 1024 },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] },
        overwrite: { type: 'boolean' },
      },
    },
    metadata: metadata(),
  },
  {
    name: 'agent.workspace.temp.read',
    description:
      'Read one owned temporary artifact as UTF-8 text or base64 without exposing other agents namespaces.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['namespaceId', 'relativePath'],
      properties: {
        namespaceId: { type: 'string', minLength: 1, maxLength: 200 },
        relativePath: { type: 'string', minLength: 1, maxLength: 1024 },
        encoding: { type: 'string', enum: ['utf8', 'base64'] },
      },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'agent.workspace.temp.list',
    description:
      'List bounded artifact metadata inside an owned temporary workspace namespace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['namespaceId'],
      properties: {
        namespaceId: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'agent.workspace.temp.release',
    description:
      'Deterministically delete an owned temporary workspace namespace and all of its artifacts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['namespaceId'],
      properties: {
        namespaceId: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    metadata: metadata({ idempotent: false }),
  },
  {
    name: 'preview.viewport.status',
    description:
      'Read the requested and actual Electron preview content viewport separately from outer window bounds.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId'],
      properties: { previewWindowId: PREVIEW_WINDOW_SCHEMA },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.viewport.set',
    description:
      'Set an exact preview content viewport in device-independent pixels using Electron content sizing, without caller compensation for title bars, DPI or OS chrome.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'width', 'height'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        width: { type: 'integer', minimum: 64, maximum: 8192 },
        height: { type: 'integer', minimum: 64, maximum: 8192 },
        waitUntilApplied: { type: 'boolean' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 10000 },
        restoreWindowState: { type: 'boolean' },
        focus: { type: 'boolean' },
      },
    },
    metadata: metadata({ idempotent: true, longRunning: true }),
  },
  {
    name: 'preview.layout.capabilities',
    description:
      'Describe MCP-native structural preview layout inspection, assertions, hidden-object semantics, text-fit authority and bounds-based region capture.',
    inputSchema: emptyObjectSchema(),
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.layout.inspect',
    description:
      'Resolve runtime object/instance, layer and named-region selectors into structured scene/viewport bounds, transformed hitboxes, visibility and clipping diagnostics without game instrumentation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'targets'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        targets: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: PREVIEW_LAYOUT_TARGET_SCHEMA,
        },
        regions: {
          type: 'array',
          maxItems: 200,
          items: PREVIEW_LAYOUT_REGION_SCHEMA,
        },
        maxInstances: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.layout.assert',
    description:
      'Run deterministic structural layout assertions for visibility, clipping/offscreen, containment, overlap, gaps, alignment, safe areas and runtime text-fit, returning machine-readable violations.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'targets', 'assertions'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        targets: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: PREVIEW_LAYOUT_TARGET_SCHEMA,
        },
        regions: {
          type: 'array',
          maxItems: 200,
          items: PREVIEW_LAYOUT_REGION_SCHEMA,
        },
        assertions: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: PREVIEW_LAYOUT_ASSERTION_SCHEMA,
        },
        maxInstances: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.capture.region',
    description:
      'Capture only an explicit preview rectangle or the resolved transformed bounds of one runtime object/instance, optionally padded and clamped to the logical viewport, and return the actual captured region.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        target: PREVIEW_TARGET_SELECTOR_SCHEMA,
        region: PREVIEW_CAPTURE_REGION_SCHEMA,
        padding: { type: 'number', minimum: 0, maximum: 8192 },
        clampToViewport: { type: 'boolean' },
        maxInstances: { type: 'integer', minimum: 1, maximum: 1000 },
        maxWidth: { type: 'integer', minimum: 1, maximum: 8192 },
        maxHeight: { type: 'integer', minimum: 1, maximum: 8192 },
        captureAttempts: { type: 'integer', minimum: 1, maximum: 8 },
        retryDelayMs: { type: 'integer', minimum: 0, maximum: 2000 },
        readyTimeoutMs: { type: 'integer', minimum: 0, maximum: 10000 },
      },
    },
    metadata: metadata({ readOnly: true, idempotent: true, longRunning: true }),
  },
  {
    name: 'preview.input.inspect',
    description:
      'Resolve a preview runtime object selector or coordinate into authoritative runtime bounds, transformed hitboxes, hit-test owner, visibility diagnostics, viewport/DPI mapping and cursor state without dispatching input.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        target: PREVIEW_TARGET_SELECTOR_SCHEMA,
        x: { type: 'number' },
        y: { type: 'number' },
        coordinateSpace: {
          type: 'string',
          enum: ['viewport', 'scene'],
          description:
            'viewport means Electron content CSS pixels; scene uses RuntimeLayer coordinates and optional layer.',
        },
        layer: { type: 'string', maxLength: 500 },
        controlState: PREVIEW_CONTROL_STATE_SCHEMA,
      },
    },
    metadata: metadata({ readOnly: true, idempotent: true }),
  },
  {
    name: 'preview.input.interact',
    description:
      'Deterministically move/hover/press/release/click/double-click/drag a preview target or coordinate. Every state-changing mouse event is followed by an observed runtime frame; optional waitFor/assertAfter use runtime variables instead of sleeps.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['previewWindowId', 'action'],
      properties: {
        previewWindowId: PREVIEW_WINDOW_SCHEMA,
        action: {
          type: 'string',
          enum: [
            'move',
            'hover',
            'press',
            'release',
            'click',
            'double-click',
            'drag',
          ],
        },
        target: PREVIEW_TARGET_SELECTOR_SCHEMA,
        x: { type: 'number' },
        y: { type: 'number' },
        coordinateSpace: { type: 'string', enum: ['viewport', 'scene'] },
        layer: { type: 'string', maxLength: 500 },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        allowOccluded: { type: 'boolean' },
        controlState: PREVIEW_CONTROL_STATE_SCHEMA,
        toTarget: PREVIEW_TARGET_SELECTOR_SCHEMA,
        toX: { type: 'number' },
        toY: { type: 'number' },
        toCoordinateSpace: { type: 'string', enum: ['viewport', 'scene'] },
        toLayer: { type: 'string', maxLength: 500 },
        allowDestinationOccluded: { type: 'boolean' },
        toControlState: PREVIEW_CONTROL_STATE_SCHEMA,
        dragSteps: { type: 'integer', minimum: 1, maximum: 20 },
        frameTimeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
        frameMaxAnimationFrames: {
          type: 'integer',
          minimum: 1,
          maximum: 120,
        },
        waitFor: PREVIEW_STATE_CONDITION_SCHEMA,
        assertAfter: PREVIEW_STATE_CONDITION_SCHEMA,
      },
    },
    metadata: metadata({ longRunning: true }),
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
      'Capture the preview and compare it with a stored baseline using exact, pixel-tolerance or perceptual modes, with quantitative metrics, divergent regions and an optional PNG heatmap.',
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
        mode: {
          type: 'string',
          enum: ['exact', 'pixel-tolerance', 'perceptual'],
          description:
            'Comparison mode. Defaults to exact for backwards compatibility.',
        },
        channelThreshold: { type: 'integer', minimum: 0, maximum: 255 },
        maxDifferentPixelRatio: { type: 'number', minimum: 0, maximum: 1 },
        maxMeanDifference: { type: 'number', minimum: 0, maximum: 255 },
        minSimilarity: { type: 'number', minimum: 0, maximum: 1 },
        perceptualDownscale: { type: 'integer', minimum: 1, maximum: 32 },
        regionSize: { type: 'integer', minimum: 4, maximum: 256 },
        regionDifferenceRatioThreshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        maxRegions: { type: 'integer', minimum: 0, maximum: 64 },
        includeDiffImage: { type: 'boolean' },
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

const makeResult = (descriptor, data, requestContext = {}) => ({
  command: descriptor.name,
  data,
  meta: {
    readOnly: !!descriptor.metadata.readOnly,
    modifiesProject: false,
    ...(requestContext.identity && typeof requestContext.identity === 'object'
      ? { identity: requestContext.identity }
      : {}),
  },
});

const createDesktopCommandRegistry = ({
  windowCaptureService,
  managedTempWorkspaceService,
  previewInteractionService,
  previewViewportService,
  previewQaService,
  previewLayoutService,
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
        captureMethod: captured.captureMethod,
        attempts: captured.attempts,
        readiness: captured.readiness,
        windowState: captured.windowState,
        sourceSize: captured.sourceSize,
        outputSize: captured.outputSize,
        fallback: captured.fallback,
        imageBuffer: captured.data,
      };
    },
    'agent.workspace.temp.capabilities': () =>
      managedTempWorkspaceService.capabilities(),
    'agent.workspace.temp.create': (input, requestContext) =>
      managedTempWorkspaceService.create(input || {}, requestContext || {}),
    'agent.workspace.temp.status': (input, requestContext) =>
      managedTempWorkspaceService.status(input || {}, requestContext || {}),
    'agent.workspace.temp.heartbeat': (input, requestContext) =>
      managedTempWorkspaceService.heartbeat(input || {}, requestContext || {}),
    'agent.workspace.temp.write': (input, requestContext) =>
      managedTempWorkspaceService.write(input || {}, requestContext || {}),
    'agent.workspace.temp.read': (input, requestContext) =>
      managedTempWorkspaceService.read(input || {}, requestContext || {}),
    'agent.workspace.temp.list': (input, requestContext) =>
      managedTempWorkspaceService.list(input || {}, requestContext || {}),
    'agent.workspace.temp.release': (input, requestContext) =>
      managedTempWorkspaceService.release(input || {}, requestContext || {}),
    'preview.viewport.status': input =>
      previewViewportService.status(input || {}),
    'preview.viewport.set': input =>
      previewViewportService.setViewport(input || {}),
    'preview.layout.capabilities': () => previewLayoutService.capabilities(),
    'preview.layout.inspect': input =>
      previewLayoutService.inspect(input || {}),
    'preview.layout.assert': input => previewLayoutService.assert(input || {}),
    'preview.capture.region': input =>
      previewLayoutService.captureRegion(input || {}),
    'preview.input.inspect': input =>
      previewInteractionService.inspect(input || {}),
    'preview.input.interact': input =>
      previewInteractionService.interact(input || {}),
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
  const execute = async ({ command, input = {}, requestContext = {} }) => {
    const descriptor = descriptorsByName.get(command);
    const handler = handlers[command];
    if (!descriptor || !handler) {
      const error = new Error(`desktop_command_not_found:${String(command)}`);
      error.code = 'desktop_command_not_found';
      throw error;
    }
    return makeResult(
      descriptor,
      await handler(input, requestContext),
      requestContext
    );
  };

  return { listDescriptors, has, execute };
};

module.exports = {
  DESCRIPTORS,
  createDesktopCommandRegistry,
};
