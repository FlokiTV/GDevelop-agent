const RESOURCE_DEFINITIONS = [
  {
    name: 'gdevelop-project-status',
    uri: 'gdevelop://project/status',
    title: 'GDevelop project status',
    description:
      'Fresh status of the currently targeted live GDevelop project, including project revision.',
    command: 'project.status',
  },
  {
    name: 'gdevelop-editor-visual',
    uri: 'gdevelop://editor/visual',
    title: 'GDevelop editor visual context',
    description:
      'Fresh visual editor context for the targeted live project, including open scene editors and active scene.',
    command: 'editor.visual.status',
  },
  {
    name: 'gdevelop-project-resources',
    uri: 'gdevelop://project/resources',
    title: 'GDevelop project resources',
    description:
      'Fresh project resource catalog with usage and file-health metadata.',
    command: 'resources.list',
  },
  {
    name: 'gdevelop-object-types',
    uri: 'gdevelop://types/objects',
    title: 'Installed GDevelop object types',
    description:
      'Authoritative installed object type index from the connected build.',
    command: 'editor.types.objects.list',
    input: { limit: 100, offset: 0 },
  },
  {
    name: 'gdevelop-behavior-types',
    uri: 'gdevelop://types/behaviors',
    title: 'Installed GDevelop behavior types',
    description:
      'Authoritative installed behavior type index from the connected build.',
    command: 'editor.types.behaviors.list',
    input: { limit: 100, offset: 0 },
  },
  {
    name: 'gdevelop-effect-types',
    uri: 'gdevelop://types/effects',
    title: 'Installed GDevelop effect types',
    description:
      'Authoritative installed effect type index from the connected build.',
    command: 'editor.types.effects.list',
    input: { limit: 100, offset: 0 },
  },
  {
    name: 'gdevelop-runtime-status',
    uri: 'gdevelop://runtime/status',
    title: 'GDevelop runtime status',
    description:
      'Fresh preview/runtime telemetry status for the targeted live project.',
    command: 'runtime.status',
  },
  {
    name: 'gdevelop-concurrency-status',
    uri: 'gdevelop://project/concurrency',
    title: 'GDevelop semantic concurrency status',
    description:
      'Fresh semantic revisions and active process-local leases for the project scope.',
    command: 'agent.concurrency.status',
  },
];

const toResourceContents = (definition, result) => ({
  contents: [
    {
      uri: definition.uri,
      mimeType: 'application/json',
      text: JSON.stringify(result),
    },
  ],
});

const registerGDevelopResources = ({ server, rendererBridge, targeting }) => {
  RESOURCE_DEFINITIONS.forEach(definition => {
    server.registerResource(
      definition.name,
      definition.uri,
      {
        title: definition.title,
        description: definition.description,
        mimeType: 'application/json',
        _meta: {
          'gdevelop/cacheScope': 'request',
          'gdevelop/live': true,
        },
      },
      async () => {
        const result = await rendererBridge.executeCommand({
          command: definition.command,
          input: definition.input || {},
          ...targeting,
        });
        return toResourceContents(definition, result);
      }
    );
  });
};

const notifyGDevelopResourcesUpdated = async ({ server, command }) => {
  if (
    !server ||
    !server.server ||
    typeof server.server.sendResourceUpdated !== 'function'
  )
    return [];
  const uris = RESOURCE_DEFINITIONS.filter(definition => {
    if (!command) return true;
    if (definition.command === 'project.status') return true;
    if (definition.command === 'agent.concurrency.status') return true;
    if (definition.command === 'runtime.status')
      return /^preview\.|^runtime\./.test(command);
    if (definition.command === 'resources.list')
      return /^resources\.|^store\./.test(command);
    if (/^editor\.types\./.test(definition.command))
      return /^extensions\.|^editor\.functions\./.test(command);
    return false;
  }).map(definition => definition.uri);
  await Promise.all(
    uris.map(uri => server.server.sendResourceUpdated({ uri }).catch(() => {}))
  );
  return uris;
};

module.exports = {
  RESOURCE_DEFINITIONS,
  toResourceContents,
  registerGDevelopResources,
  notifyGDevelopResourcesUpdated,
};
