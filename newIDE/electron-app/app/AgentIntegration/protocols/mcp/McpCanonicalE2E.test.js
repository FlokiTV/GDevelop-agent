const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const { PROTOCOL_VERSION } = require('./McpServerFactory');
const { startMcpHttpServer } = require('./McpHttpServer');
const {
  createDesktopCommandRegistry,
} = require('../../DesktopCommandRegistry');

const metadata = overrides => ({
  readOnly: true,
  destructive: false,
  idempotent: true,
  longRunning: false,
  requiresProject: false,
  modifiesProject: false,
  ...(overrides || {}),
});

const descriptor = (name, overrides = {}) => ({
  name,
  description: `Canonical E2E tool ${name}`,
  inputSchema: {
    type: 'object',
    additionalProperties: true,
  },
  outputSchema: {
    type: 'object',
    additionalProperties: true,
  },
  metadata: metadata(overrides),
});

const connectClient = async ({ url, token }) => {
  const client = new Client(
    { name: 'gdevelop-canonical-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-GDevelop-Client-Id': 'canonical-e2e-client',
        'X-GDevelop-Window-Id': '17',
      },
    },
  });
  await client.connect(transport);
  return client;
};

const result = ({ command, data, state, modifiesProject = false }) => ({
  command,
  data,
  meta: {
    traceId: null,
    readOnly: !modifiesProject,
    modifiesProject,
    projectRevision: state.projectRevision,
  },
});

test('official MCP client completes the canonical MCP-only authoring replay without project reopen or legacy REST', async () => {
  const descriptors = [
    descriptor('agent.capabilities'),
    descriptor('project.status'),
    descriptor('editor.functions.call', {
      readOnly: false,
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: true,
    }),
    descriptor('scene.open', { requiresProject: true }),
    descriptor('editor.instances.select', { requiresProject: true }),
    descriptor('events.read', { requiresProject: true }),
    descriptor('events.update', {
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    descriptor('resources.import-local', {
      readOnly: false,
      idempotent: false,
      longRunning: true,
      requiresProject: true,
      modifiesProject: true,
    }),
    descriptor('preview.hot-reload', {
      idempotent: false,
      requiresProject: true,
    }),
    descriptor('runtime.snapshot'),
    descriptor('runtime.assert'),
    descriptor('diagnostics.inspect', { requiresProject: true }),
    descriptor('validation.run', {
      longRunning: true,
      requiresProject: true,
    }),
    descriptor('project.save', {
      readOnly: false,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    descriptor('export.html5', {
      idempotent: false,
      longRunning: true,
      requiresProject: true,
    }),
  ];

  const state = {
    projectRevision: 0,
    projectOpen: true,
    sceneName: 'Game',
    sceneOpened: false,
    objectCreated: false,
    instanceCreated: false,
    selectedInstance: false,
    eventsRevision: 'events:e2e-0',
    eventDisabled: false,
    resourceImported: false,
    resourceUsed: false,
    previewRunning: true,
    debuggerId: 'preview-e2e-1',
    inputSent: false,
    failureInjected: false,
    failureCorrected: false,
    saved: false,
    exported: false,
  };
  const rendererCalls = [];
  const replay = [];

  const mutate = () => {
    state.projectRevision++;
  };

  const rendererBridge = {
    executeCommand: async options => {
      rendererCalls.push(options);
      const { command, input = {} } = options;
      if (command === 'agent.commands.list') {
        return result({
          command,
          data: { commands: descriptors },
          state,
        });
      }
      replay.push({ surface: 'renderer', command, input });

      if (command === 'agent.capabilities') {
        return result({
          command,
          data: {
            protocol: 'mcp',
            projectLiveEditing: true,
            commandCount: descriptors.length,
          },
          state,
        });
      }
      if (command === 'project.status') {
        return result({
          command,
          data: {
            projectOpen: state.projectOpen,
            projectName: 'Canonical E2E',
            hasUnsavedChanges: state.projectRevision > 0 && !state.saved,
          },
          state,
        });
      }
      if (command === 'editor.functions.call') {
        const functionName = input.name;
        if (functionName === 'create_scene') {
          state.sceneName = input.arguments.scene_name;
          mutate();
          return result({
            command,
            data: { createdSceneNames: [state.sceneName] },
            state,
            modifiesProject: true,
          });
        }
        if (functionName === 'create_object') {
          state.objectCreated = true;
          mutate();
          return result({
            command,
            data: { objectName: input.arguments.object_name },
            state,
            modifiesProject: true,
          });
        }
        if (functionName === 'put_2d_instances') {
          assert.equal(state.objectCreated, true);
          state.instanceCreated = true;
          mutate();
          return result({
            command,
            data: { createdInstances: 1 },
            state,
            modifiesProject: true,
          });
        }
        if (functionName === 'edit_object') {
          assert.equal(state.resourceImported, true);
          state.resourceUsed = true;
          mutate();
          return result({
            command,
            data: { edited: true },
            state,
            modifiesProject: true,
          });
        }
        if (functionName === 'run_gameplay_test') {
          return result({
            command,
            data: {
              results: [{ status: 'finished', success: true }],
              didModifyProject: false,
            },
            state,
          });
        }
        throw new Error(`unexpected_editor_function:${functionName}`);
      }
      if (command === 'scene.open') {
        assert.equal(input.sceneName, state.sceneName);
        state.sceneOpened = true;
        return result({ command, data: { opened: true }, state });
      }
      if (command === 'editor.instances.select') {
        assert.equal(state.instanceCreated, true);
        state.selectedInstance = true;
        return result({
          command,
          data: { selectedCount: 1, focusMode: 'fit' },
          state,
        });
      }
      if (command === 'events.read') {
        return result({
          command,
          data: {
            sceneName: state.sceneName,
            eventsRevision: state.eventsRevision,
            events: [
              {
                handle: 'event:id:e2e-event',
                path: [0],
                disabled: state.eventDisabled,
              },
            ],
          },
          state,
        });
      }
      if (command === 'events.update') {
        assert.equal(input.expectedEventsRevision, state.eventsRevision);
        state.eventDisabled = !!input.eventJson.disabled;
        mutate();
        state.eventsRevision = `events:e2e-${state.projectRevision}`;
        return result({
          command,
          data: {
            updated: true,
            eventsRevision: state.eventsRevision,
            validation: { ok: true, issues: [] },
          },
          state,
          modifiesProject: true,
        });
      }
      if (command === 'resources.import-local') {
        assert.equal(typeof input.filePath, 'string');
        state.resourceImported = true;
        mutate();
        return result({
          command,
          data: { imported: true, resource: { name: 'e2e.png' } },
          state,
          modifiesProject: true,
        });
      }
      if (command === 'preview.hot-reload') {
        assert.equal(state.previewRunning, true);
        return result({
          command,
          data: {
            reloaded: true,
            running: true,
            debuggerIds: [state.debuggerId],
          },
          state,
        });
      }
      if (command === 'runtime.snapshot') {
        return result({
          command,
          data: {
            debuggerId: state.debuggerId,
            scene: { name: state.sceneName },
            objects: { Player: { count: state.instanceCreated ? 1 : 0 } },
          },
          state,
        });
      }
      if (command === 'runtime.assert') {
        if (input.path === 'objects.Player.count' && input.value === 2) {
          state.failureInjected = true;
          return result({
            command,
            data: { passed: false, actual: 1, expected: 2 },
            state,
          });
        }
        if (input.path === 'objects.Player.count' && input.value === 1) {
          assert.equal(state.failureInjected, true);
          state.failureCorrected = true;
          return result({
            command,
            data: { passed: true, actual: 1, expected: 1 },
            state,
          });
        }
        throw new Error('unexpected_runtime_assertion');
      }
      if (command === 'diagnostics.inspect') {
        return result({
          command,
          data: {
            summary: {
              ok: state.failureCorrected,
              errors: state.failureCorrected ? 0 : 1,
            },
            issues: state.failureCorrected
              ? []
              : [{ code: 'e2e-deliberate-failure' }],
          },
          state,
        });
      }
      if (command === 'validation.run') {
        assert.equal(state.failureCorrected, true);
        assert.equal(state.resourceUsed, true);
        return result({
          command,
          data: {
            ok: true,
            summary: { passed: true, errors: 0, warnings: 0 },
          },
          state,
        });
      }
      if (command === 'project.save') {
        state.saved = true;
        return result({
          command,
          data: { saved: true, fileIdentifier: 'C:/e2e/game.json' },
          state,
          modifiesProject: true,
        });
      }
      if (command === 'export.html5') {
        assert.equal(state.saved, true);
        state.exported = true;
        return result({
          command,
          data: { exported: true, outputDir: input.outputDir },
          state,
        });
      }
      throw new Error(`unexpected_command:${command}`);
    },
  };

  const desktopCalls = [];
  const desktopCommandRegistry = createDesktopCommandRegistry({
    windowCaptureService: {
      listWindows: () => [
        { windowId: 17, editorWindow: true, previewWindow: false },
        { windowId: 8, editorWindow: false, previewWindow: true },
      ],
      capture: async input => {
        desktopCalls.push({ command: 'desktop.window.capture', input });
        replay.push({
          surface: 'desktop',
          command: 'desktop.window.capture',
          input,
        });
        return {
          windowId: Number(input.windowId),
          mimeType: 'image/png',
          data: Buffer.from(`e2e-capture-${input.windowId}`),
        };
      },
    },
    previewInteractionService: {
      sendInput: input => {
        state.inputSent = true;
        desktopCalls.push({ command: 'preview.input.send', input });
        replay.push({
          surface: 'desktop',
          command: 'preview.input.send',
          input,
        });
        return { sent: true, windowId: input.previewWindowId };
      },
      sendSequence: async input => ({ sent: true, steps: input.steps.length }),
      resetInput: input => ({ reset: true, windowId: input.previewWindowId }),
      sendTouch: input => ({ sent: true, windowId: input.previewWindowId }),
      sendGamepad: input => ({ sent: true, windowId: input.previewWindowId }),
      getRuntimeStatus: input => ({
        installed: true,
        windowId: input.previewWindowId,
      }),
      resetRuntime: input => ({ reset: true, windowId: input.previewWindowId }),
    },
  });

  const token = 'canonical-e2e-token';
  const host = await startMcpHttpServer({
    rendererBridge,
    desktopCommandRegistry,
    token,
    port: 0,
  });
  const client = await connectClient({ url: host.url, token });

  try {
    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map(tool => tool.name));
    [
      'agent.capabilities',
      'project.status',
      'editor.functions.call',
      'events.read',
      'events.update',
      'resources.import-local',
      'desktop.window.capture',
      'preview.input.send',
      'validation.run',
      'project.save',
      'export.html5',
    ].forEach(name =>
      assert.equal(toolNames.has(name), true, `missing ${name}`)
    );

    const capabilities = await client.callTool({
      name: 'agent.capabilities',
      arguments: {},
    });
    assert.equal(capabilities.structuredContent.data.protocol, 'mcp');
    const initialStatus = await client.callTool({
      name: 'project.status',
      arguments: {},
    });
    assert.equal(initialStatus.structuredContent.data.projectOpen, true);

    await client.callTool({
      name: 'editor.functions.call',
      arguments: {
        name: 'create_scene',
        arguments: { scene_name: 'E2E Scene' },
        expectedRevision: 0,
        idempotencyKey: 'e2e-create-scene',
      },
    });
    await client.callTool({
      name: 'scene.open',
      arguments: { sceneName: 'E2E Scene' },
    });
    await client.callTool({
      name: 'editor.functions.call',
      arguments: {
        name: 'create_object',
        arguments: { scene_name: 'E2E Scene', object_name: 'Player' },
        expectedRevision: 1,
        idempotencyKey: 'e2e-create-object',
      },
    });
    await client.callTool({
      name: 'editor.functions.call',
      arguments: {
        name: 'put_2d_instances',
        arguments: { scene_name: 'E2E Scene', object_name: 'Player' },
        expectedRevision: 2,
        idempotencyKey: 'e2e-create-instance',
      },
    });
    const selection = await client.callTool({
      name: 'editor.instances.select',
      arguments: { sceneName: 'E2E Scene', objectName: 'Player' },
    });
    assert.equal(selection.structuredContent.data.selectedCount, 1);
    const editorCapture = await client.callTool({
      name: 'desktop.window.capture',
      arguments: { windowId: 17 },
    });
    assert.equal(editorCapture.content[0].type, 'image');

    const eventRead = await client.callTool({
      name: 'events.read',
      arguments: { sceneName: 'E2E Scene' },
    });
    await client.callTool({
      name: 'events.update',
      arguments: {
        sceneName: 'E2E Scene',
        handle: 'event:id:e2e-event',
        expectedEventsRevision: eventRead.structuredContent.data.eventsRevision,
        eventJson: {
          type: 'BuiltinCommonInstructions::Standard',
          disabled: true,
        },
        expectedRevision: 3,
        idempotencyKey: 'e2e-event-update',
      },
    });

    await client.callTool({
      name: 'resources.import-local',
      arguments: {
        filePath: 'C:/e2e/source/e2e.png',
        resourceName: 'e2e.png',
        expectedRevision: 4,
        idempotencyKey: 'e2e-import-resource',
      },
    });
    await client.callTool({
      name: 'editor.functions.call',
      arguments: {
        name: 'edit_object',
        arguments: {
          scene_name: 'E2E Scene',
          object_name: 'Player',
          resource_name: 'e2e.png',
        },
        expectedRevision: 5,
        idempotencyKey: 'e2e-use-resource',
      },
    });

    const hotReload = await client.callTool({
      name: 'preview.hot-reload',
      arguments: {},
    });
    assert.equal(hotReload.structuredContent.data.running, true);
    await client.callTool({
      name: 'preview.input.send',
      arguments: {
        previewWindowId: 8,
        event: { type: 'keyDown', keyCode: 'W' },
      },
    });
    const snapshot = await client.callTool({
      name: 'runtime.snapshot',
      arguments: {},
    });
    assert.equal(snapshot.structuredContent.data.debuggerId, state.debuggerId);
    const previewCapture = await client.callTool({
      name: 'desktop.window.capture',
      arguments: { windowId: 8 },
    });
    assert.equal(previewCapture.content[0].type, 'image');

    const failedAssertion = await client.callTool({
      name: 'runtime.assert',
      arguments: { path: 'objects.Player.count', operator: 'equals', value: 2 },
    });
    assert.equal(failedAssertion.structuredContent.data.passed, false);
    const failedDiagnostics = await client.callTool({
      name: 'diagnostics.inspect',
      arguments: {},
    });
    assert.equal(failedDiagnostics.structuredContent.data.summary.ok, false);
    const correctedAssertion = await client.callTool({
      name: 'runtime.assert',
      arguments: { path: 'objects.Player.count', operator: 'equals', value: 1 },
    });
    assert.equal(correctedAssertion.structuredContent.data.passed, true);

    const gameplay = await client.callTool({
      name: 'editor.functions.call',
      arguments: {
        name: 'run_gameplay_test',
        arguments: { test_name: 'Canonical E2E', persist: false },
        expectedRevision: 6,
        idempotencyKey: 'e2e-gameplay-test',
      },
    });
    assert.equal(gameplay.structuredContent.data.results[0].success, true);
    const validation = await client.callTool({
      name: 'validation.run',
      arguments: {},
    });
    assert.equal(validation.structuredContent.data.ok, true);

    const save = await client.callTool({
      name: 'project.save',
      arguments: { expectedRevision: 6, idempotencyKey: 'e2e-save' },
    });
    assert.equal(save.structuredContent.data.saved, true);
    const exported = await client.callTool({
      name: 'export.html5',
      arguments: { outputDir: 'C:/e2e/export' },
    });
    assert.equal(exported.structuredContent.data.exported, true);

    assert.equal(state.sceneOpened, true);
    assert.equal(state.selectedInstance, true);
    assert.equal(state.resourceUsed, true);
    assert.equal(state.inputSent, true);
    assert.equal(state.failureInjected, true);
    assert.equal(state.failureCorrected, true);
    assert.equal(state.saved, true);
    assert.equal(state.exported, true);
    assert.equal(
      rendererCalls.some(
        call =>
          call.command === 'project.open' || call.command === 'project.close'
      ),
      false
    );
    assert.equal(
      rendererCalls.some(
        call =>
          call.request || call.type || String(call.command).startsWith('/v1')
      ),
      false
    );
    assert.ok(replay.length >= 20);
  } finally {
    await client.close();
    await host.stop();
  }
});
