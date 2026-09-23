const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agentIntegrationRoot = path.resolve(__dirname, '..', '..');
const read = relativePath =>
  fs.readFileSync(path.join(agentIntegrationRoot, relativePath), 'utf8');

test('native Event Sheet authoring docs preserve canonical/discovery guidance', () => {
  const readme = read('README.md');
  const guide = read(path.join('docs', 'MCP_NATIVE_EVENT_AUTHORING.md'));

  assert.match(readme, /MCP_NATIVE_EVENT_AUTHORING\.md/);
  assert.match(readme, /events\.nodes\.list/);
  assert.match(readme, /events\.nodes\.describe/);

  assert.match(guide, /events\.read\.data\.eventsJson/);
  assert.match(guide, /data\.eventsJson/);
  assert.match(guide, /data\.events/);
  assert.match(guide, /eventsRevision/);
  assert.match(
    guide,
    /Do not reconstruct or style event nodes from `data\.events`/
  );

  assert.match(guide, /events\.instructions\.search/);
  assert.match(guide, /events\.instructions\.describe/);
  assert.match(guide, /kind: \"expression\"/);
  assert.match(guide, /RandomInRange/);
  assert.match(guide, /returnType/);
  assert.match(guide, /events\.nodes\.list/);
  assert.match(guide, /events\.nodes\.describe/);
  assert.match(guide, /known-default-fields/);
  assert.match(guide, /discriminated union/);
  assert.match(guide, /unknown-type fallback/);
  assert.match(guide, /x-gdevelop-schema-reference/);
  assert.match(guide, /MCP input boundary/);
  assert.match(guide, /ordered `parameters`/);

  assert.match(guide, /BuiltinCommonInstructions::Group/);
  assert.match(guide, /"colorR"/);
  assert.match(guide, /"colorG"/);
  assert.match(guide, /"colorB"/);

  assert.match(guide, /BuiltinCommonInstructions::Comment/);
  assert.match(guide, /"textR"/);
  assert.match(guide, /"textG"/);
  assert.match(guide, /"textB"/);
  assert.match(readme, /events\.style\.update/);
  assert.match(guide, /events\.style\.update/);
  assert.match(guide, /"background"/);
  assert.match(guide, /"text"/);
  assert.match(guide, /0 through 255/);
  assert.match(guide, /preserves the complete canonical node/);
  assert.match(guide, /beforeStyle/);
  assert.match(guide, /afterStyle/);
  assert.match(guide, /idempotencyKey/);

  assert.match(guide, /editor\.functions\.inspect-variables/);
  assert.match(guide, /Prefer the typed tool/);
  assert.match(guide, /Use `editor\.functions\.call` only for compatibility/);
});
