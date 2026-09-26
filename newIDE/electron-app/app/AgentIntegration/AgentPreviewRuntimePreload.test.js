const test = require('node:test');
const assert = require('node:assert/strict');
const {
  installAgentRuntimeGameCapture,
} = require('./AgentPreviewRuntimePreload');

test('captures RuntimeGame instances even when the game variable is local to the preview bootstrap', () => {
  const globalObject = {};
  assert.equal(installAgentRuntimeGameCapture(globalObject), true);

  class RuntimeGame {
    constructor(name) {
      this.name = name;
      this._debuggerClient = { id: 'debugger-client' };
    }
  }

  globalObject.gdjs.RuntimeGame = RuntimeGame;
  const localGame = new globalObject.gdjs.RuntimeGame('preview');

  assert.equal(globalObject.__GDevelopAgentRuntimeGame, localGame);
  assert.equal(localGame.name, 'preview');
  assert.deepEqual(localGame._debuggerClient, { id: 'debugger-client' });
  assert.equal(localGame instanceof RuntimeGame, true);
});

test('capture install is idempotent', () => {
  const globalObject = {};
  assert.equal(installAgentRuntimeGameCapture(globalObject), true);
  const descriptorBefore = Object.getOwnPropertyDescriptor(
    globalObject.gdjs,
    'RuntimeGame'
  );
  assert.equal(installAgentRuntimeGameCapture(globalObject), true);
  const descriptorAfter = Object.getOwnPropertyDescriptor(
    globalObject.gdjs,
    'RuntimeGame'
  );
  assert.equal(descriptorAfter.get, descriptorBefore.get);
  assert.equal(descriptorAfter.set, descriptorBefore.set);
});
