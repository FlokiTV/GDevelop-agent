const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agentIntegrationRoot = path.resolve(__dirname, '..', '..');
const read = relativePath =>
  fs.readFileSync(path.join(agentIntegrationRoot, relativePath), 'utf8');

test('external MCP client docs distinguish authoritative raw data from sanitized evidence', () => {
  const readme = read('README.md');
  const dx = read(path.join('docs', 'MCP_INTROSPECTION_AGENT_DX.md'));

  assert.match(readme, /connectLiveGDevelopMcp/);
  assert.match(readme, /McpToolCall\.js/);
  assert.match(readme, /--allow-mutate/);
  assert.match(readme, /--json-file/);
  assert.match(readme, /raw structured output/);
  assert.match(readme, /sanitized evidence is not an authoring contract/);
  assert.match(
    readme,
    /Discovery credentials and Authorization headers are never printed/
  );

  assert.match(dx, /implemented DX-6/);
  assert.match(dx, /returns no bearer credential/);
  assert.match(dx, /performs no hidden call retry/);
  assert.match(dx, /server-side destructive elicitation/);
  assert.match(dx, /raw `events\.read\.data\.eventsJson`/);
});
