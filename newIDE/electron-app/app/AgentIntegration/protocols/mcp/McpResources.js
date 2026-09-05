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
          input: {},
          ...targeting,
        });
        return toResourceContents(definition, result);
      }
    );
  });
};

module.exports = {
  RESOURCE_DEFINITIONS,
  toResourceContents,
  registerGDevelopResources,
};
