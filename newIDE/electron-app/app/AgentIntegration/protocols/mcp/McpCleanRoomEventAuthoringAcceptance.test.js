const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agentIntegrationRoot = path.resolve(__dirname, '..', '..');
const read = relativePath =>
  fs.readFileSync(path.join(agentIntegrationRoot, relativePath), 'utf8');

test('clean-room authoring scenario enforces MCP-only discovery and preserves sanitized evidence', () => {
  const scenario = read(
    path.join('scripts', 'McpCleanRoomEventAuthoringLiveScenario.js')
  );
  const evidenceText = read(
    path.join('docs', 'evidence', 'DX9_CLEAN_ROOM_ACCEPTANCE.json')
  );
  const evidence = JSON.parse(evidenceText);

  [
    /clean_room_repository_read_forbidden/,
    /listTools\(\)/,
    /listPrompts\(\)/,
    /getPrompt/,
    /listResources\(\)/,
    /readResource/,
    /events\.instructions\.search/,
    /events\.instructions\.describe/,
    /events\.nodes\.list/,
    /events\.nodes\.describe/,
    /events\.style\.update/,
    /validation\.run/,
    /preview\.start/,
    /runtime\.logs/,
    /project\.save-as/,
    /sanitizeForReplay/,
  ].forEach(pattern => assert.match(scenario, pattern));

  assert.equal(evidence.kind, 'dx9-clean-room-event-authoring-acceptance');
  assert.deepEqual(evidence.cleanRoom, {
    repositoryImplementationOrTestsReadDuringScenario: false,
    repositoryReadGuard: true,
    connectionSource: 'gdevelop-mcp.json + tokenFile',
    authoringInputSource: 'live raw MCP responses',
    sanitizedEvidenceUsedAsAuthoringInput: false,
  });
  assert.equal(evidence.protocolVersion, '2026-07-28');
  assert.equal(typeof evidence.discovery.toolCount, 'number');
  assert.ok(evidence.discovery.toolCount > 0);
  assert.equal(evidence.discovery.prompt, 'gdevelop.events-authoring');
  assert.equal(
    evidence.discovery.resource,
    'gdevelop://guides/native-event-authoring'
  );
  assert.equal(evidence.discovery.promptVersion, 3);
  assert.equal(evidence.discovery.guideVersion, 2);

  assert.equal(
    typeof evidence.discoveredAuthoringContracts.condition.id,
    'string'
  );
  assert.equal(
    typeof evidence.discoveredAuthoringContracts.action.id,
    'string'
  );
  assert.equal(
    evidence.discoveredAuthoringContracts.expression.returnType,
    'number'
  );
  assert.equal(
    evidence.discoveredAuthoringContracts.eventNodes.group,
    'BuiltinCommonInstructions::Group'
  );
  assert.equal(
    evidence.discoveredAuthoringContracts.eventNodes.comment,
    'BuiltinCommonInstructions::Comment'
  );
  assert.equal(
    evidence.discoveredAuthoringContracts.eventNodes.standard,
    'BuiltinCommonInstructions::Standard'
  );

  assert.equal(evidence.validation.errors, 0);
  assert.equal(evidence.preview.running, true);
  assert.equal(evidence.runtime.logsReadable, true);
  assert.equal(evidence.save.explicit, true);
  assert.equal(evidence.save.cleanAfterSave, true);
  assert.equal(evidence.save.saved, true);

  assert.doesNotMatch(evidenceText, /Bearer\s+/i);
  assert.doesNotMatch(evidenceText, /"authorization"\s*:/i);
  assert.doesNotMatch(evidenceText, /"fileIdentifier"\s*:/);
  assert.doesNotMatch(evidenceText, /[A-Z]:\\\\Users\\\\/i);
  assert.doesNotMatch(evidenceText, /"gameId"\s*:/);
});
