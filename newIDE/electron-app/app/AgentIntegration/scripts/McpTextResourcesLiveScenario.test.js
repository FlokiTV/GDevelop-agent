const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  REQUIRED_TOOLS,
  LOCALE_RESOURCE_NAME,
  getData,
  readRuntimeResource,
} = require('./McpTextResourcesLiveScenario');

test('DX-16 live scenario requires text authoring, packaging, preview and export tools', () => {
  for (const name of [
    'resources.text.create',
    'resources.text.read',
    'resources.text.update',
    'resources.packaging.inspect',
    'preview.start',
    'desktop.windows.list',
    'export.html5',
  ]) {
    assert.ok(REQUIRED_TOOLS.includes(name), `missing required tool ${name}`);
  }
  assert.equal(LOCALE_RESOURCE_NAME, 'locales/es.json');
});

test('getData accepts direct and structured MCP envelopes', () => {
  assert.deepEqual(getData({ data: { ok: 1 } }), { ok: 1 });
  assert.deepEqual(
    getData({ structuredContent: { data: { ok: 2 } } }),
    { ok: 2 }
  );
  assert.deepEqual(getData({ structuredContent: { ok: 3 } }), { ok: 3 });
});

test('readRuntimeResource resolves a packaged resource relative to a file preview URL', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx16-runtime-resource-')
  );
  try {
    const indexPath = path.join(root, 'index.html');
    const resourcePath = path.join(root, 'es.json');
    fs.writeFileSync(indexPath, '<!doctype html>', 'utf8');
    fs.writeFileSync(resourcePath, '{"locale":"es-ES"}', 'utf8');

    const content = await readRuntimeResource(
      pathToFileURL(indexPath).href,
      'es.json'
    );
    assert.equal(content, '{"locale":"es-ES"}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
