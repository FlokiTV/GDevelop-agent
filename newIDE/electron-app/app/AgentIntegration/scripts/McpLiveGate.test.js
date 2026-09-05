const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getDefaultDiscoveryPath,
  loadRuntimeConfig,
  makeRequestHeaders,
  parseArgs,
  sanitizeForReplay,
} = require('./McpLiveGate');

test('parses explicit live gate targeting options', () => {
  assert.deepEqual(
    parseArgs([
      '--discovery',
      'C:/tmp/gdevelop-mcp.json',
      '--output',
      'C:/tmp/replay.json',
      '--window-id',
      '17',
      '--project-path',
      'C:/game/game.json',
      '--client-id',
      'ci-probe',
    ]),
    {
      discoveryPath: 'C:/tmp/gdevelop-mcp.json',
      outputPath: 'C:/tmp/replay.json',
      windowId: '17',
      projectPath: 'C:/game/game.json',
      clientId: 'ci-probe',
    }
  );
  assert.throws(() => parseArgs(['--unknown']), /unknown_argument/);
});

test('resolves discovery from APPDATA unless explicitly overridden', () => {
  assert.equal(
    getDefaultDiscoveryPath({ APPDATA: 'C:/Users/Test/AppData/Roaming' }),
    path.join(
      'C:/Users/Test/AppData/Roaming',
      'GDevelop 5',
      'gdevelop-mcp.json'
    )
  );
  assert.equal(
    getDefaultDiscoveryPath({
      GDEVELOP_MCP_DISCOVERY: 'D:/custom/discovery.json',
    }),
    'D:/custom/discovery.json'
  );
});

test('loads runtime credentials without copying secret fields into replay helpers', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-mcp-live-gate-'));
  const tokenPath = path.join(tempDir, 'token');
  const discoveryPath = path.join(tempDir, 'discovery.json');
  fs.writeFileSync(tokenPath, 'super-secret-token\n');
  fs.writeFileSync(
    discoveryPath,
    JSON.stringify({
      service: 'gdevelop-mcp',
      endpoint: 'http://127.0.0.1:38473/mcp',
      protocolVersion: '2026-07-28',
      auth: { type: 'bearer', tokenFile: tokenPath },
    })
  );

  try {
    const runtime = loadRuntimeConfig(discoveryPath);
    assert.equal(runtime.endpoint, 'http://127.0.0.1:38473/mcp');
    assert.equal(runtime.protocolVersion, '2026-07-28');
    assert.equal(runtime.token, 'super-secret-token');

    const sanitized = sanitizeForReplay({
      authorization: 'Bearer super-secret-token',
      token: 'super-secret-token',
      nested: {
        bearerToken: 'super-secret-token',
        safe: true,
      },
    });
    assert.deepEqual(sanitized, { nested: { safe: true } });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('builds request headers without leaking credentials into unrelated fields', () => {
  assert.deepEqual(
    makeRequestHeaders({
      token: 'secret',
      clientId: 'live-probe',
      windowId: '17',
      projectPath: 'C:/game/game.json',
    }),
    {
      Authorization: 'Bearer secret',
      'X-GDevelop-Client-Id': 'live-probe',
      'X-GDevelop-Window-Id': '17',
      'X-GDevelop-Project-Path': 'C:/game/game.json',
    }
  );
});
