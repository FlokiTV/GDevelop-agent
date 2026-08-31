// @flow
const fs = require('fs');
const path = require('path');

const CORE_DIRECTORY = __dirname;
const FORBIDDEN_IMPORT_PATTERNS = [
  /(?:from\s+|require\()['"]react(?:['"]|\/)/,
  /(?:from\s+|require\()['"]electron(?:['"]|\/)/,
  /(?:from\s+|require\()['"]http['"]?/,
  /(?:from\s+|require\()['"]https['"]?/,
  /(?:from\s+|require\()['"]@modelcontextprotocol\//,
  /(?:from\s+|require\().*AgentApi\//,
];

describe('AgentIntegration core dependency boundary', () => {
  it('does not import React, Electron, HTTP, MCP or legacy AgentApi', () => {
    const productionFiles = fs
      .readdirSync(CORE_DIRECTORY)
      .filter(fileName => fileName.endsWith('.js'))
      .filter(fileName => !fileName.endsWith('.spec.js'));

    const violations = [];
    for (const fileName of productionFiles) {
      const source = fs.readFileSync(path.join(CORE_DIRECTORY, fileName), 'utf8');
      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`${fileName}: ${String(pattern)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
