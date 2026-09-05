// @flow strict-local
/* eslint-disable no-console */

// Node-only code generator. It derives AgentApi function metadata from the
// native EditorFunctions implementations instead of duplicating their schemas
// by hand. Run with:
//   node src/AgentApi/generateFunctionMetadata.js
// Check for stale generated metadata with:
//   node src/AgentApi/generateFunctionMetadata.js --check

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const appSrc = path.resolve(__dirname, '..');
const editorFunctionsIndexPath = path.join(
  appSrc,
  'EditorFunctions',
  'index.js'
);
const outputPath = path.join(__dirname, 'FunctionMetadata.generated.js');

const extractorTypes = {
  extractStringProperty: 'string',
  extractNumberProperty: 'number',
  extractBooleanProperty: 'boolean',
  extractObjectProperty: 'object',
  extractArrayProperty: 'array',
  extractStringArrayProperty: 'string[]',
  extractNumberOrStringOrBooleanProperty: 'number|string|boolean',
};

const cleanComment = value =>
  String(value || '')
    .replace(/^\*+/, '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

const parseFile = filePath => {
  const code = fs.readFileSync(filePath, 'utf8');
  return {
    code,
    ast: parser.parse(code, {
      sourceType: 'module',
      plugins: ['flow', 'jsx', 'classProperties', 'objectRestSpread'],
      attachComment: true,
    }),
  };
};

const resolveImportPath = (fromFile, source) => {
  if (!source.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), source);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      return candidate;
  }
  return null;
};

const getStringLiteral = node => {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  return null;
};

const getPropertyName = node => {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  return null;
};

const getObjectProperty = (objectExpression, name) =>
  objectExpression && objectExpression.type === 'ObjectExpression'
    ? objectExpression.properties.find(property =>
        property.type === 'ObjectProperty' || property.type === 'ObjectMethod'
          ? getPropertyName(property.key) === name
          : false
      )
    : null;

const getFunctionNodeFromProperty = property => {
  if (!property) return null;
  if (property.type === 'ObjectMethod') return property;
  if (property.type !== 'ObjectProperty') return null;
  const value = property.value;
  return value &&
    ['ArrowFunctionExpression', 'FunctionExpression'].includes(value.type)
    ? value
    : null;
};

const getBooleanObjectProperty = (objectExpression, name) => {
  const property = getObjectProperty(objectExpression, name);
  if (!property || property.type !== 'ObjectProperty') return null;
  return property.value.type === 'BooleanLiteral' ? property.value.value : null;
};

const makeProgramForNode = node => ({
  type: 'File',
  program: {
    type: 'Program',
    sourceType: 'module',
    body: [{ type: 'ExpressionStatement', expression: node }],
  },
});

const inferArguments = launchFunctionNode => {
  if (!launchFunctionNode) return [];
  const byName = new Map();
  const addArgument = (
    name,
    type,
    required = false,
    provenance = 'source',
    enumValue = null
  ) => {
    if (!name) return;
    const previous = byName.get(name);
    if (!previous) {
      const argument = { name, type, required, provenance };
      if (enumValue !== null) argument.enum = [enumValue];
      byName.set(name, argument);
      return;
    }
    if (previous.type === 'unknown' && type !== 'unknown') previous.type = type;
    if (required) previous.required = true;
    if (enumValue !== null) {
      if (!previous.enum) previous.enum = [];
      if (!previous.enum.includes(enumValue)) previous.enum.push(enumValue);
    }
  };

  const getArgsMemberName = node => {
    if (!node || node.type !== 'MemberExpression') return null;
    if (node.object.type !== 'Identifier' || node.object.name !== 'args')
      return null;
    if (!node.computed && node.property.type === 'Identifier')
      return node.property.name;
    if (node.computed && node.property.type === 'StringLiteral')
      return node.property.value;
    return null;
  };

  traverse(makeProgramForNode(launchFunctionNode), {
    CallExpression(callPath) {
      const { node } = callPath;
      if (
        node.callee.type === 'Identifier' &&
        node.callee.name === 'extractRequiredString'
      ) {
        addArgument(getStringLiteral(node.arguments[1]), 'string', true);
        return;
      }
      if (
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'SafeExtractor' &&
        node.callee.property.type === 'Identifier'
      ) {
        const type = extractorTypes[node.callee.property.name];
        if (type) addArgument(getStringLiteral(node.arguments[1]), type, false);
      }
      if (
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'Array' &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === 'isArray'
      ) {
        const name = getArgsMemberName(node.arguments[0]);
        if (name) addArgument(name, 'array', false, 'array-check');
      }
    },
    MemberExpression(memberPath) {
      const name = getArgsMemberName(memberPath.node);
      if (name) addArgument(name, 'unknown', false, 'direct-args-access');
    },
    BinaryExpression(binaryPath) {
      const { node } = binaryPath;
      const left = node.left;
      const right = node.right;
      if (
        left &&
        left.type === 'UnaryExpression' &&
        left.operator === 'typeof' &&
        right &&
        right.type === 'StringLiteral'
      ) {
        const name = getArgsMemberName(left.argument);
        if (
          name &&
          ['string', 'number', 'boolean', 'object'].includes(right.value)
        ) {
          addArgument(name, right.value, false, 'typeof-check');
        }
      }
      const directName = getArgsMemberName(left);
      if (directName && right) {
        if (right.type === 'StringLiteral') {
          addArgument(
            directName,
            'string',
            false,
            'literal-comparison',
            right.value
          );
        } else if (right.type === 'BooleanLiteral') {
          addArgument(directName, 'boolean', false, 'literal-comparison');
        } else if (right.type === 'NumericLiteral') {
          addArgument(directName, 'number', false, 'literal-comparison');
        }
      }
    },
    VariableDeclarator(variablePath) {
      const { node } = variablePath;
      if (
        node.init &&
        node.init.type === 'Identifier' &&
        node.init.name === 'args' &&
        node.id.type === 'ObjectPattern'
      ) {
        node.id.properties.forEach(property => {
          if (property.type !== 'ObjectProperty') return;
          addArgument(
            getPropertyName(property.key),
            'unknown',
            false,
            'args-destructure'
          );
        });
      }
    },
  });

  return [...byName.values()].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
};

const exampleValue = argument => {
  const { name, type } = argument;
  if (name === 'scene_name') return 'Scene';
  if (name === 'object_name') return 'Player';
  if (name === 'layer_name') return '';
  if (name === 'behavior_name') return 'Behavior';
  if (name === 'behavior_type') return 'BehaviorType';
  if (name === 'variable_scope') return 'scene';
  if (name === 'project_name') return 'Game';
  if (name === 'template_slug') return '';
  if (name === 'brush_kind') return 'point';
  if (name.endsWith('_ids') || name.endsWith('_id')) return '<id>';
  if (type === 'number') return 1;
  if (type === 'boolean') return true;
  if (type === 'array' || type === 'string[]') return [];
  if (type === 'object') return {};
  if (type === 'number|string|boolean') return 1;
  return `<${name}>`;
};

const collectModule = filePath => {
  const parsed = parseFile(filePath);
  const variables = new Map();
  const imports = new Map();

  traverse(parsed.ast, {
    ImportDeclaration(importPath) {
      const sourceFile = resolveImportPath(
        filePath,
        importPath.node.source.value
      );
      if (!sourceFile) return;
      importPath.node.specifiers.forEach(specifier => {
        if (specifier.type !== 'ImportSpecifier') return;
        imports.set(specifier.local.name, {
          filePath: sourceFile,
          importedName: getPropertyName(specifier.imported),
        });
      });
    },
    VariableDeclarator(variablePath) {
      const { node } = variablePath;
      if (node.id.type !== 'Identifier' || !node.init) return;
      const exportNode = variablePath.findParent(parentPath =>
        parentPath.isExportNamedDeclaration()
      );
      variables.set(node.id.name, {
        node: node.init,
        declarationNode: variablePath.parentPath.node,
        exportNode: exportNode ? exportNode.node : null,
        line: node.loc ? node.loc.start.line : null,
      });
    },
  });

  return { ...parsed, variables, imports, filePath };
};

const moduleCache = new Map();
const getModule = filePath => {
  if (!moduleCache.has(filePath))
    moduleCache.set(filePath, collectModule(filePath));
  return moduleCache.get(filePath);
};

const resolveImplementation = (moduleInfo, identifier, seen = new Set()) => {
  const visitKey = `${moduleInfo.filePath}:${identifier}`;
  if (seen.has(visitKey)) return null;
  seen.add(visitKey);

  const local = moduleInfo.variables.get(identifier);
  if (local) {
    if (local.node.type === 'Identifier') {
      return resolveImplementation(moduleInfo, local.node.name, seen);
    }
    if (local.node.type === 'ObjectExpression') {
      return { moduleInfo, identifier, ...local };
    }
  }

  const imported = moduleInfo.imports.get(identifier);
  if (imported) {
    return resolveImplementation(
      getModule(imported.filePath),
      imported.importedName,
      seen
    );
  }
  return null;
};

const collectExportMap = (moduleInfo, exportName) => {
  let result = null;
  traverse(moduleInfo.ast, {
    VariableDeclarator(variablePath) {
      const node = variablePath.node;
      if (node.id.type !== 'Identifier' || node.id.name !== exportName) return;
      if (!node.init || node.init.type !== 'ObjectExpression') return;
      result = node.init.properties
        .filter(property => property.type === 'ObjectProperty')
        .map(property => ({
          name: getPropertyName(property.key),
          implementation:
            property.value.type === 'Identifier' ? property.value.name : null,
        }))
        .filter(entry => entry.name && entry.implementation);
    },
  });
  return result || [];
};

const getDescription = implementation => {
  const comments = [
    ...((implementation.exportNode &&
      implementation.exportNode.leadingComments) ||
      []),
    ...(implementation.declarationNode.leadingComments || []),
    ...(implementation.node.leadingComments || []),
  ];
  const cleaned = comments
    .map(comment => cleanComment(comment.value))
    .filter(Boolean);
  return cleaned.length ? cleaned[cleaned.length - 1] : '';
};

const mergeArguments = argumentLists => {
  const byName = new Map();
  argumentLists.flat().forEach(argument => {
    const previous = byName.get(argument.name);
    if (!previous) {
      byName.set(argument.name, { ...argument });
      return;
    }
    if (previous.type === 'unknown' && argument.type !== 'unknown') {
      previous.type = argument.type;
      previous.provenance = argument.provenance;
    }
    if (argument.required) previous.required = true;
    if (argument.enum) {
      previous.enum = [
        ...new Set([...(previous.enum || []), ...argument.enum]),
      ];
    }
  });
  return [...byName.values()].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
};

const makeEntry = ({
  name,
  implementationName,
  requiresProject,
  rootModule,
}) => {
  const implementation = resolveImplementation(rootModule, implementationName);
  if (!implementation) {
    return {
      name,
      implementation: implementationName,
      requiresProject,
      description: '',
      arguments: [],
      source: null,
      generatedExample: { name, arguments: {} },
    };
  }

  const launchProperty = getObjectProperty(
    implementation.node,
    'launchFunction'
  );
  const renderProperty = getObjectProperty(
    implementation.node,
    'renderForEditor'
  );
  const launchFunctionNode = getFunctionNodeFromProperty(launchProperty);
  const renderFunctionNode = getFunctionNodeFromProperty(renderProperty);
  const argumentsMetadata = mergeArguments([
    inferArguments(launchFunctionNode),
    inferArguments(renderFunctionNode),
  ]);
  const description = getDescription(implementation);
  const relativeSource = path
    .relative(appSrc, implementation.moduleInfo.filePath)
    .replace(/\\/g, '/');
  const modifiesProject = getBooleanObjectProperty(
    implementation.node,
    'modifiesProject'
  );
  const requiredArgs = argumentsMetadata.filter(argument => argument.required);
  const generatedArguments = {};
  requiredArgs.forEach(argument => {
    generatedArguments[argument.name] = exampleValue(argument);
  });

  return {
    name,
    implementation: implementation.identifier,
    requiresProject,
    description,
    arguments: argumentsMetadata,
    modifiesProjectFromSource: modifiesProject,
    source: {
      file: relativeSource,
      line: implementation.line,
    },
    generatedExample: {
      name,
      arguments: generatedArguments,
    },
  };
};

const rootModule = getModule(editorFunctionsIndexPath);
const projectFunctions = collectExportMap(rootModule, 'editorFunctions');
const projectlessFunctions = collectExportMap(
  rootModule,
  'editorFunctionsWithoutProject'
);
const entries = [
  ...projectFunctions.map(entry =>
    makeEntry({
      ...entry,
      implementationName: entry.implementation,
      requiresProject: true,
      rootModule,
    })
  ),
  ...projectlessFunctions.map(entry =>
    makeEntry({
      ...entry,
      implementationName: entry.implementation,
      requiresProject: false,
      rootModule,
    })
  ),
];

const namesByImplementation = new Map();
entries.forEach(entry => {
  const key = `${entry.source ? entry.source.file : ''}:${
    entry.implementation
  }`;
  if (!namesByImplementation.has(key)) namesByImplementation.set(key, []);
  namesByImplementation.get(key).push(entry.name);
});
entries.forEach(entry => {
  const key = `${entry.source ? entry.source.file : ''}:${
    entry.implementation
  }`;
  entry.aliases = namesByImplementation
    .get(key)
    .filter(name => name !== entry.name);
  entry.searchText = [
    entry.name,
    entry.implementation,
    entry.description,
    ...entry.arguments.map(argument => argument.name),
  ]
    .join(' ')
    .toLowerCase();
});
entries.sort((a, b) => a.name.localeCompare(b.name));

const serialized = JSON.stringify(entries, null, 2);
const output = `// @flow\n// AUTO-GENERATED by AgentApi/generateFunctionMetadata.js. Do not edit by hand.\n\nexport const generatedFunctionMetadata: Array<any> = ${serialized};\n`;
const checkOnly = process.argv.includes('--check');
if (checkOnly) {
  const existing = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, 'utf8')
    : null;
  if (existing !== output) {
    console.error(
      'FunctionMetadata.generated.js is stale. Run node src/AgentApi/generateFunctionMetadata.js.'
    );
    process.exitCode = 1;
  } else {
    console.log(`Function metadata is up to date (${entries.length} entries).`);
  }
} else {
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(
    `Generated ${entries.length} AgentApi function metadata entries.`
  );
  console.log(`Output: ${outputPath}`);
}
