// @flow

const requireTool = (toolNames: Set<string>, name: string) => {
  if (!toolNames.has(name)) {
    throw new Error(`clean_room_missing_tool:${name}`);
  }
};

const replaceFirstSpriteFrameImage = (structure: any, resourceName: string) => {
  const copy = JSON.parse(JSON.stringify(structure));
  if (
    !copy ||
    copy.kind !== 'sprite' ||
    !Array.isArray(copy.animations) ||
    !copy.animations[0] ||
    !Array.isArray(copy.animations[0].directions) ||
    !copy.animations[0].directions[0] ||
    !Array.isArray(copy.animations[0].directions[0].frames) ||
    !copy.animations[0].directions[0].frames[0]
  ) {
    throw new Error('clean_room_sprite_structure_unavailable');
  }
  copy.animations[0].directions[0].frames[0].image = resourceName;
  return copy;
};

export const runVisualResourceCleanRoomActor = async ({
  mcp,
  sceneName,
  spriteObjectName,
  textObjectName,
  imageBase64,
  replacementImageBase64,
  fontBase64,
}: any): Promise<any> => {
  const listed = await mcp.listTools();
  const toolNames = new Set(
    (Array.isArray(listed) ? listed : listed.tools || []).map(tool =>
      typeof tool === 'string' ? tool : tool.name
    )
  );
  [
    'resources.visual.import',
    'resources.visual.inspect',
    'resources.visual.replace',
    'resources.visual.delete',
    'resources.packaging.inspect',
    'objects.structure.inspect',
    'objects.structure.apply',
    'objects.properties.describe',
    'objects.properties.set',
    'preview.start',
  ].forEach(name => requireTool(toolNames, name));

  const imageResourceName = 'dx28-clean-image';
  const fontResourceName = 'dx28-clean-font';

  const importedImage = await mcp.call('resources.visual.import', {
    resourceName: imageResourceName,
    kind: 'image',
    contentBase64: imageBase64,
  });
  const importedFont = await mcp.call('resources.visual.import', {
    resourceName: fontResourceName,
    kind: 'font',
    contentBase64: fontBase64,
  });

  const spriteBefore = await mcp.call('objects.structure.inspect', {
    scope: 'scene',
    sceneName,
    objectName: spriteObjectName,
  });
  const nextSpriteStructure = replaceFirstSpriteFrameImage(
    spriteBefore.structure,
    imageResourceName
  );
  await mcp.call('objects.structure.apply', {
    scope: 'scene',
    sceneName,
    objectName: spriteObjectName,
    mode: 'replace',
    structure: nextSpriteStructure,
  });

  const textDescription = await mcp.call('objects.properties.describe', {
    targetKind: 'object-definition',
    sceneName,
    objectName: textObjectName,
    objectScope: 'scene',
  });
  const fontProperty = (textDescription.properties || []).find(
    property =>
      property &&
      property.writable !== false &&
      property.constraints &&
      Array.isArray(property.constraints.extraInfo) &&
      property.constraints.extraInfo.includes('font')
  );
  if (!fontProperty) throw new Error('clean_room_font_property_not_found');
  await mcp.call('objects.properties.set', {
    targetKind: 'object-definition',
    sceneName,
    objectName: textObjectName,
    objectScope: 'scene',
    changes: [{ path: fontProperty.path, value: fontResourceName }],
  });

  const imageBeforeReplace = await mcp.call('resources.visual.inspect', {
    resourceName: imageResourceName,
  });
  const fontInspection = await mcp.call('resources.visual.inspect', {
    resourceName: fontResourceName,
  });
  const packagingBefore = await mcp.call('resources.packaging.inspect', {});

  const preview = await mcp.call('preview.start', {
    waitUntilReady: true,
    readyTimeoutMs: 5000,
  });

  const replaced = await mcp.call('resources.visual.replace', {
    resourceName: imageResourceName,
    contentBase64: replacementImageBase64,
  });
  const imageAfterReplace = await mcp.call('resources.visual.inspect', {
    resourceName: imageResourceName,
  });
  const deleteDryRun = await mcp.call('resources.visual.delete', {
    resourceName: imageResourceName,
    deleteFile: true,
    dryRun: true,
  });

  return {
    importedImage,
    importedFont,
    imageBeforeReplace,
    imageAfterReplace,
    fontInspection,
    packagingBefore,
    preview,
    replaced,
    deleteDryRun,
    imageResourceName,
    fontResourceName,
  };
};
