const test = require('node:test');
const assert = require('node:assert/strict');
const { assertTargetPreconditions } = require('./McpServerFactory');

const identity = {
  project: {
    open: true,
    projectId: 'project-layout',
    normalizedProjectPath: 'c:\\games\\layout\\game.json',
    scenes: [
      {
        sceneName: 'LayoutScene',
        sceneId: 'scene-layout',
        selector: 'scene:scene-layout',
      },
    ],
  },
  editor: {
    activeTargets: [
      {
        editorSelector: 'editor-tab:layout',
        selector: 'scene:scene-layout',
      },
    ],
    activeScene: {
      sceneName: 'LayoutScene',
      sceneId: 'scene-layout',
      selector: 'scene:scene-layout',
    },
  },
  preview: {
    targets: [
      {
        targetId: 'preview-window:8',
        windowId: 8,
        debuggerId: 'debugger-layout',
        sceneSelector: 'scene:scene-layout',
      },
    ],
  },
};

const rendererBridge = {
  executeCommand: async request => {
    assert.equal(request.command, 'target.status');
    return { data: identity };
  },
};

test('applies automatic preview-window target guard to DX-23 layout and region-capture commands', async () => {
  for (const name of [
    'preview.layout.inspect',
    'preview.layout.assert',
    'preview.capture.region',
  ]) {
    await assert.doesNotReject(
      assertTargetPreconditions({
        registration: { name },
        commandInput: { previewWindowId: 8 },
        preconditions: {
          expectedPreviewTarget: {
            targetId: 'preview-window:8',
            debuggerId: 'debugger-layout',
          },
        },
        rendererBridge,
        targeting: {},
        identity: { ownerKey: 'layout-agent' },
        targetIdentitySupported: true,
        capturePreviewWindowId: null,
      })
    );

    await assert.rejects(
      assertTargetPreconditions({
        registration: { name },
        commandInput: { previewWindowId: 99 },
        preconditions: {},
        rendererBridge,
        targeting: {},
        identity: { ownerKey: 'layout-agent' },
        targetIdentitySupported: true,
        capturePreviewWindowId: null,
      }),
      error =>
        error &&
        error.code === 'target_mismatch' &&
        error.details &&
        error.details.conflictScope === 'preview-window'
    );
  }
});
