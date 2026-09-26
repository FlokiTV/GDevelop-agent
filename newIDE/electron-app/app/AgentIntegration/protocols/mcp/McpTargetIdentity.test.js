const test = require('node:test');
const assert = require('node:assert/strict');
const { assertTargetPreconditions } = require('./McpServerFactory');

const makeIdentity = () => ({
  project: {
    open: true,
    projectId: 'project-a',
    normalizedProjectPath: 'c:\\games\\a\\game.json',
  },
  editor: {
    activeTargets: [
      {
        editorSelector: 'editor-tab:editor-tab-1',
        selector: 'scene:SceneA',
      },
    ],
    activeScene: {
      sceneName: 'SceneA',
      sceneId: 'scene:SceneA',
      selector: 'scene:SceneA',
    },
  },
  preview: {
    targets: [
      {
        targetId: 'preview-window:8',
        windowId: 8,
        debuggerId: 'debugger-a',
        sceneSelector: 'scene:SceneA',
      },
    ],
  },
});

const makeBridge = identity => ({
  executeCommand: async request => {
    assert.equal(request.command, 'target.status');
    return { data: identity };
  },
});

test('rejects pinned project and scene mismatches with structured target_mismatch', async () => {
  const identity = makeIdentity();
  await assert.rejects(
    assertTargetPreconditions({
      registration: { name: 'events.update' },
      commandInput: { sceneName: 'SceneA' },
      preconditions: { expectedProjectId: 'project-b' },
      rendererBridge: makeBridge(identity),
      targeting: { windowId: '1' },
      identity: { ownerKey: 'agent::session' },
      targetIdentitySupported: true,
      capturePreviewWindowId: null,
    }),
    error =>
      error &&
      error.code === 'target_mismatch' &&
      error.details &&
      error.details.conflictScope === 'project' &&
      error.details.actual.projectId === 'project-a'
  );

  await assert.rejects(
    assertTargetPreconditions({
      registration: { name: 'preview.start' },
      commandInput: {},
      preconditions: { expectedSceneSelector: 'scene:SceneB' },
      rendererBridge: makeBridge(identity),
      targeting: { windowId: '1' },
      identity: { ownerKey: 'agent::session' },
      targetIdentitySupported: true,
      capturePreviewWindowId: null,
    }),
    error =>
      error &&
      error.code === 'target_mismatch' &&
      error.details.conflictScope === 'scene' &&
      error.details.actual.selector === 'scene:SceneA'
  );
});

test('accepts explicit scene mutation target independently from currently active editor scene', async () => {
  const identity = makeIdentity();
  const result = await assertTargetPreconditions({
    registration: { name: 'events.update' },
    commandInput: { sceneName: 'SceneB' },
    preconditions: { expectedSceneSelector: 'scene:SceneB' },
    rendererBridge: makeBridge(identity),
    targeting: {},
    identity: {},
    targetIdentitySupported: true,
    capturePreviewWindowId: null,
  });
  assert.equal(result.project.projectId, 'project-a');
});

test('blocks unrelated preview input and preview capture automatically', async () => {
  const identity = makeIdentity();
  for (const request of [
    {
      registration: { name: 'preview.input.send' },
      commandInput: { previewWindowId: 99 },
      capturePreviewWindowId: null,
    },
    {
      registration: { name: 'desktop.window.capture' },
      commandInput: { windowId: 99 },
      capturePreviewWindowId: 99,
    },
  ]) {
    await assert.rejects(
      assertTargetPreconditions({
        ...request,
        preconditions: {},
        rendererBridge: makeBridge(identity),
        targeting: {},
        identity: {},
        targetIdentitySupported: true,
      }),
      error =>
        error &&
        error.code === 'target_mismatch' &&
        error.details.conflictScope === 'preview-window'
    );
  }

  await assert.doesNotReject(
    assertTargetPreconditions({
      registration: { name: 'preview.input.send' },
      commandInput: { previewWindowId: 8 },
      preconditions: {
        expectedPreviewTarget: {
          targetId: 'preview-window:8',
          debuggerId: 'debugger-a',
        },
      },
      rendererBridge: makeBridge(identity),
      targeting: {},
      identity: {},
      targetIdentitySupported: true,
      capturePreviewWindowId: null,
    })
  );
});

test('keeps legacy renderer compatibility unless explicit target preconditions are requested', async () => {
  await assert.doesNotReject(
    assertTargetPreconditions({
      registration: { name: 'preview.input.send' },
      commandInput: { previewWindowId: 8 },
      preconditions: {},
      rendererBridge: {
        executeCommand: async () => {
          throw new Error('must_not_query_legacy_target_status');
        },
      },
      targeting: {},
      identity: {},
      targetIdentitySupported: false,
      capturePreviewWindowId: null,
    })
  );

  await assert.rejects(
    assertTargetPreconditions({
      registration: { name: 'events.update' },
      commandInput: { sceneName: 'SceneA' },
      preconditions: { expectedProjectId: 'project-a' },
      rendererBridge: {},
      targeting: {},
      identity: {},
      targetIdentitySupported: false,
      capturePreviewWindowId: null,
    }),
    error => error && error.code === 'target_identity_unavailable'
  );
});

test('binds expectedPreviewTarget to the same requested preview window when multiple previews are valid', async () => {
  const identity = makeIdentity();
  identity.preview.targets.push({
    targetId: 'preview-window:9',
    windowId: 9,
    debuggerId: 'debugger-b',
    sceneSelector: 'scene:SceneA',
  });

  await assert.rejects(
    assertTargetPreconditions({
      registration: { name: 'preview.input.runtime-status' },
      commandInput: { previewWindowId: 8 },
      preconditions: {
        expectedPreviewTarget: {
          targetId: 'preview-window:9',
          debuggerId: 'debugger-b',
        },
      },
      rendererBridge: makeBridge(identity),
      targeting: {},
      identity: {},
      targetIdentitySupported: true,
      capturePreviewWindowId: null,
    }),
    error =>
      error &&
      error.code === 'target_mismatch' &&
      error.details.conflictScope === 'preview-window' &&
      error.details.actual.windowId === 8
  );
});
