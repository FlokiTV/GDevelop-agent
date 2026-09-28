// @flow
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentHost } from '../core/AgentHost';
import { createAssetTools } from '../AssetTools';
import { createResourceCommandDescriptors } from './ResourceCommands';
import { createObjectStructureCommandDescriptors } from './ObjectStructureCommands';
import { createObjectStructureService } from './ObjectStructureService';
import { createObjectPropertyCommandDescriptors } from './ObjectPropertyCommands';
import { createObjectPropertyService } from './ObjectPropertyService';
import { createPreviewCommandDescriptors } from '../runtime/PreviewCommands';
import { runVisualResourceCleanRoomActor } from './VisualResourceCleanRoomActor';

const gd: libGDevelop = global.gd;

const makePng = (width: number, height: number) => {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
};

const makeTtf = () => {
  const le = Buffer.from('DX Clean Font', 'utf16le');
  const family = Buffer.alloc(le.length);
  for (let index = 0; index < le.length; index += 2) {
    family[index] = le[index + 1];
    family[index + 1] = le[index];
  }
  const nameOffset = 28;
  const nameLength = 18 + family.length;
  const buffer = Buffer.alloc(nameOffset + nameLength);
  buffer.writeUInt32BE(0x00010000, 0);
  buffer.writeUInt16BE(1, 4);
  buffer.write('name', 12, 'ascii');
  buffer.writeUInt32BE(nameOffset, 20);
  buffer.writeUInt32BE(nameLength, 24);
  buffer.writeUInt16BE(0, nameOffset);
  buffer.writeUInt16BE(1, nameOffset + 2);
  buffer.writeUInt16BE(18, nameOffset + 4);
  const record = nameOffset + 6;
  buffer.writeUInt16BE(3, record);
  buffer.writeUInt16BE(1, record + 2);
  buffer.writeUInt16BE(0x0409, record + 4);
  buffer.writeUInt16BE(1, record + 6);
  buffer.writeUInt16BE(family.length, record + 8);
  buffer.writeUInt16BE(0, record + 10);
  family.copy(buffer, nameOffset + 18);
  return buffer;
};

const addFixtureObjects = (project: gdProject) => {
  const scene = project.insertNewLayout('Game', 0);
  const spriteObject = scene
    .getObjects()
    .insertNewObject(project, 'Sprite', 'Hero', 0);
  const spriteConfiguration = gd.asSpriteConfiguration(
    spriteObject.getConfiguration()
  );
  const animation = new gd.Animation();
  animation.setName('Idle');
  animation.setDirectionsCount(1);
  const sprite = new gd.Sprite();
  sprite.setImageName('');
  animation.getDirection(0).addSprite(sprite);
  spriteConfiguration.getAnimations().addAnimation(animation);
  sprite.delete();
  animation.delete();

  scene.getObjects().insertNewObject(project, 'TextObject::Text', 'Label', 1);

  return { scene, spriteObject };
};

describe('DX-28 visual resource clean-room acceptance', () => {
  it('imports image+font, wires them through public tools, previews, packages, replaces and blocks in-use deletion', async () => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    const projectFolder = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gd-agent-dx28-clean-room-')
    );
    project.setProjectFile(path.join(projectFolder, 'game.json'));
    const { scene, spriteObject } = addFixtureObjects(project);

    const callbacks = {
      triggerUnsavedChanges: jest.fn(),
      forceUpdate: jest.fn(),
      onObjectsModifiedOutsideEditor: jest.fn(),
    };
    const assetTools = createAssetTools({
      project,
      // $FlowFixMe[incompatible-type]
      resourceManagementProps: {
        onNewResourcesAdded: jest.fn(),
        onResourceUsageChanged: jest.fn(),
      },
      triggerUnsavedChanges: callbacks.triggerUnsavedChanges,
      forceUpdate: callbacks.forceUpdate,
    });
    const objectStructureService = createObjectStructureService({
      project,
      ...callbacks,
    });
    const metadataDiscoveryService = {
      describeObjectType: jest.fn(() => ({ item: { properties: [] } })),
      describeBehaviorType: jest.fn(() => ({ item: { properties: [] } })),
      searchInstructions: jest.fn(() => ({ items: [] })),
    };
    const editorFunctionService = {
      run: jest.fn(async options => {
        const call = options.calls[0];
        if (call.name !== 'change_object_property') {
          throw new Error(`unexpected_editor_function:${call.name}`);
        }
        const args = call.arguments;
        const targetScene = project.getLayout(args.scene_name);
        const object = targetScene.getObjects().getObject(args.object_name);
        const text = gd.asTextObjectConfiguration(object.getConfiguration());
        args.changed_properties.forEach(change => {
          if (change.property_name === 'font') {
            text.setFontName(change.new_value);
          } else {
            throw new Error(
              `unexpected_property_change:${change.property_name}`
            );
          }
        });
        return { results: [{ status: 'finished', success: true }] };
      }),
    };
    const objectPropertyService = createObjectPropertyService({
      project,
      metadataDiscoveryService,
      editorFunctionService,
      triggerUnsavedChanges: callbacks.triggerUnsavedChanges,
      forceUpdate: callbacks.forceUpdate,
      onInstancesModifiedOutsideEditor: jest.fn(),
    });
    const previewService = {
      start: jest.fn(async input => ({
        ready: true,
        lifecycle: 'ready',
        waitUntilReady: input.waitUntilReady === true,
        validationErrors: 0,
      })),
      getStatus: jest.fn(() => ({ lifecycle: 'ready' })),
      hotReload: jest.fn(),
      control: jest.fn(),
      closeAll: jest.fn(),
    };

    const host = new AgentHost({
      environment: { project },
      descriptors: [
        ...createResourceCommandDescriptors({ assetTools }),
        ...createObjectStructureCommandDescriptors({ objectStructureService }),
        ...createObjectPropertyCommandDescriptors({ objectPropertyService }),
        ...createPreviewCommandDescriptors({ previewService }),
      ],
    });
    const mcp = {
      listTools: async () => host.listCommands(),
      call: async (name, input) => (await host.execute(name, input)).data,
    };

    const result = await runVisualResourceCleanRoomActor({
      mcp,
      sceneName: 'Game',
      spriteObjectName: 'Hero',
      textObjectName: 'Label',
      imageBase64: makePng(32, 16).toString('base64'),
      replacementImageBase64: makePng(64, 32).toString('base64'),
      fontBase64: makeTtf().toString('base64'),
    });

    expect(result.importedImage.resource).toMatchObject({
      kind: 'image',
      projectRelativePath: 'assets/dx28-clean-image.png',
      userAdded: true,
    });
    expect(result.importedFont.visual.font).toMatchObject({
      family: 'DX Clean Font',
      registeredAsProjectFont: true,
      usableByTextObjects: true,
    });
    expect(result.imageBeforeReplace.usages.objectUsages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sceneName: 'Game',
          objectName: 'Hero',
        }),
      ])
    );
    expect(result.fontInspection.font.textObjectUsages).toEqual([
      expect.objectContaining({ sceneName: 'Game', objectName: 'Label' }),
    ]);
    expect(result.packagingBefore.summary).toMatchObject({
      total: 2,
      willPackage: 2,
    });
    expect(result.preview).toMatchObject({
      ready: true,
      lifecycle: 'ready',
      validationErrors: 0,
    });
    expect(result.replaced).toMatchObject({
      referencesPreserved: true,
      visual: { image: { width: 64, height: 32 } },
    });
    expect(result.imageAfterReplace.usages.objectUsages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sceneName: 'Game',
          objectName: 'Hero',
        }),
      ])
    );
    expect(result.deleteDryRun).toMatchObject({
      dryRun: true,
      blocked: true,
      blockReason: 'resource_in_use',
      wouldRemoveResource: false,
    });

    const spriteImage = gd
      .asSpriteConfiguration(spriteObject.getConfiguration())
      .getAnimations()
      .getAnimation(0)
      .getDirection(0)
      .getSprite(0)
      .getImageName();
    const textFont = gd
      .asTextObjectConfiguration(
        scene
          .getObjects()
          .getObject('Label')
          .getConfiguration()
      )
      .getFontName();
    expect(spriteImage).toBe(result.imageResourceName);
    expect(textFont).toBe(result.fontResourceName);
    expect(
      project
        .getResourcesManager()
        .getAllResourceNames()
        .toJSArray()
    ).toEqual(
      expect.arrayContaining([
        result.imageResourceName,
        result.fontResourceName,
      ])
    );
    expect(
      project
        .getResourcesManager()
        .getAllResourceNames()
        .size()
    ).toBe(2);

    project.delete();
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });
});
