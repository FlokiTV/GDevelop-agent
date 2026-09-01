const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const integrationRoot = path.resolve(__dirname, '..', '..');
const startupPath = path.join(integrationRoot, 'index.js');

const collectJavaScriptFiles = directory => {
  const files = [];
  fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScriptFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath);
  });
  return files;
};

test('MCP and production startup do not depend on AgentApi or /v1', () => {
  const files = [startupPath, ...collectJavaScriptFiles(__dirname)].filter(
    filePath => !filePath.endsWith('.test.js')
  );

  files.forEach(filePath => {
    const source = fs.readFileSync(filePath, 'utf8');
    assert.equal(
      source.includes('AgentApi'),
      false,
      `${path.relative(integrationRoot, filePath)} imports or names AgentApi`
    );
    assert.equal(
      source.includes('/v1'),
      false,
      `${path.relative(integrationRoot, filePath)} references the legacy REST API`
    );
  });
});
