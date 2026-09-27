const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  isAllowedAgentChange,
  findDisallowedAgentChanges,
  runArchitectureGuard,
} = require('./ArchitectureGuard');

test('allows agent-owned files, repository metadata and only the explicit upstream/native hooks', () => {
  assert.equal(
    isAllowedAgentChange('newIDE/app/src/AgentIntegration/ExportTools.js'),
    true
  );
  assert.equal(
    isAllowedAgentChange('newIDE/electron-app/app/AgentIntegration/index.js'),
    true
  );
  assert.equal(
    isAllowedAgentChange('newIDE/app/src/AgentIntegration/core/AgentHost.js'),
    true
  );
  assert.equal(
    isAllowedAgentChange(
      'newIDE/electron-app/app/AgentIntegration/mcp/server.js'
    ),
    true
  );
  assert.equal(isAllowedAgentChange('newIDE/app/src/MainFrame/index.js'), true);
  assert.equal(isAllowedAgentChange('newIDE/electron-app/app/main.js'), true);
  assert.equal(
    isAllowedAgentChange('newIDE/electron-app/app/PreviewWindow.js'),
    true
  );
  assert.equal(isAllowedAgentChange('Core/GDCore/Project/Layout.cpp'), true);
  assert.equal(
    isAllowedAgentChange('Core/GDCore/Project/ExternalEvents.h'),
    true
  );
  assert.equal(isAllowedAgentChange('GDevelop.js/Bindings/Bindings.idl'), true);
  assert.equal(
    isAllowedAgentChange(
      'GDevelop.js/__tests__/PersistentProjectStructureIdentity.js'
    ),
    true
  );
  assert.equal(isAllowedAgentChange('newIDE/app/src/Utils/Layout.js'), true);
  assert.equal(
    isAllowedAgentChange('newIDE/electron-app/app/package.json'),
    true
  );
  assert.equal(
    isAllowedAgentChange('newIDE/electron-app/app/package-lock.json'),
    true
  );
  assert.equal(
    isAllowedAgentChange('.github/workflows/agent-integration.yml'),
    true
  );
  assert.equal(
    isAllowedAgentChange('.github/workflows/build-storybook.yml'),
    true
  );
  assert.equal(
    isAllowedAgentChange('.github/workflows/extract-translations.yml'),
    true
  );
  assert.equal(
    isAllowedAgentChange('.github/workflows/update-translations.yml'),
    true
  );
});

test('rejects changes elsewhere in GDevelop upstream', () => {
  assert.deepEqual(
    findDisallowedAgentChanges([
      'newIDE/app/src/AgentIntegration/useAgentIntegration.js',
      'GDJS/Runtime/runtimegame.js',
      'Core/GDCore/Project/Project.cpp',
      'GDevelop.js/Bindings/Other.idl',
      'newIDE/app/package.json',
    ]),
    [
      'GDJS/Runtime/runtimegame.js',
      'Core/GDCore/Project/Project.cpp',
      'GDevelop.js/Bindings/Other.idl',
      'newIDE/app/package.json',
    ]
  );
});

test('current fork delta stays inside the isolation allowlist when upstream is available', t => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  try {
    const result = runArchitectureGuard({
      repoRoot,
      baseRef: 'upstream/master',
    });
    assert.deepEqual(result.disallowedFiles, []);
  } catch (error) {
    if (error && error.code === 'architecture_guard_git_diff_failed') {
      t.skip('upstream/master is not available in this checkout');
      return;
    }
    throw error;
  }
});
