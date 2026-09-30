// @flow
import { serializeAgentError } from '../core/AgentError';
import { createEventTools } from '../EventTools';
import { createEventCommandDescriptors } from './EventCommands';
import { createLayerOrderService } from './LayerOrderService';
import { createMetadataDiscoveryCommandDescriptors } from './MetadataDiscoveryCommands';
import { createMetadataDiscoveryService } from './MetadataDiscoveryService';
import { createObjectDefinitionCommandDescriptors } from './ObjectDefinitionCommands';
import { createObjectDefinitionService } from './ObjectDefinitionService';
import { createObjectGroupCommandDescriptors } from './ObjectGroupCommands';
import { createObjectGroupService } from './ObjectGroupService';
import { createObjectPropertyService } from './ObjectPropertyService';
import { createSceneInstanceCommandDescriptors } from './SceneInstanceCommands';
import { createSceneInstanceService } from './SceneInstanceService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const {
  runObjectDefinitionCleanRoomActor,
} = require('./ObjectDefinitionCleanRoomActor');

const gd: libGDevelop = global.gd;

describe('DX-34 Object definition clean-room acceptance', () => {
  beforeAll(() => makeTestExtensions(gd));

  it('authors and refactors a referenced object using only a MCP-shaped client', async () => {
    // $FlowFixMe[invalid-constructor]
    const project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX34 Clean Room');
    project.insertNewLayout('Game', 0);

    const triggerUnsavedChanges = jest.fn();
    const forceUpdate = jest.fn();
    const metadataDiscoveryService = createMetadataDiscoveryService({
      project,
    });
    const eventTools = createEventTools({
      project,
      diagnosticsTools: null,
      metadataDiscoveryService,
      triggerUnsavedChanges,
      onSceneEventsModifiedOutsideEditor: jest.fn(),
      forceUpdate,
    });
    const objectGroupService = createObjectGroupService({
      project,
      eventTools,
      metadataDiscoveryService,
      triggerUnsavedChanges,
      forceUpdate,
      onObjectGroupsModifiedOutsideEditor: jest.fn(),
    });
    const objectPropertyService = createObjectPropertyService({
      project,
      metadataDiscoveryService,
      editorFunctionService: { run: jest.fn() },
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor: jest.fn(),
    });
    const layerOrderService = createLayerOrderService({
      project,
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor: jest.fn(),
    });
    const sceneInstanceService = createSceneInstanceService({
      project,
      layerOrderService,
      objectPropertyService,
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor: jest.fn(),
    });
    const objectDefinitionService = createObjectDefinitionService({
      project,
      eventTools,
      metadataDiscoveryService,
      objectPropertyService,
      objectGroupService,
      assetTools: { inspectVisualResource: jest.fn(() => null) },
      triggerUnsavedChanges,
      forceUpdate,
      onObjectsModifiedOutsideEditor: jest.fn(),
    });
    const descriptors = [
      ...createObjectDefinitionCommandDescriptors({ objectDefinitionService }),
      ...createObjectGroupCommandDescriptors({ objectGroupService }),
      ...createSceneInstanceCommandDescriptors({ sceneInstanceService }),
      ...createEventCommandDescriptors({
        eventTools,
        metadataDiscoveryService,
      }),
      ...createMetadataDiscoveryCommandDescriptors({
        metadataDiscoveryService,
      }),
    ];
    const byName = new Map(
      descriptors.map(descriptor => [descriptor.name, descriptor])
    );
    let revision = 0;
    const client = {
      listTools: async () =>
        descriptors.map(descriptor => ({
          name: descriptor.name,
          inputSchema: descriptor.inputSchema,
        })),
      call: async (name, args = {}) => {
        const descriptor = byName.get(name);
        if (!descriptor) throw new Error('missing_descriptor:' + name);
        const { expectedRevision, idempotencyKey, ...input } = args;
        try {
          const data = await descriptor.execute({ input, requestContext: {} });
          const mutates =
            descriptor.metadata.modifiesProject &&
            (!descriptor.modifiesProjectWhen ||
              descriptor.modifiesProjectWhen(input));
          if (mutates) revision += 1;
          return {
            isError: false,
            data,
            meta: { projectRevision: revision },
            structuredContent: { data, meta: { projectRevision: revision } },
          };
        } catch (error) {
          const serialized = serializeAgentError(error);
          return {
            isError: true,
            data: { error: serialized },
            structuredContent: { error: serialized },
          };
        }
      },
    };

    try {
      const evidence = await runObjectDefinitionCleanRoomActor({
        client,
        sceneName: 'Game',
      });
      expect(evidence).toMatchObject({
        objectType: 'Sprite',
        objectId: expect.any(String),
        instanceId: expect.any(String),
        creationSchemaDiscovered: true,
        duplicateFreshIdentity: true,
        usageMapped: true,
        nativeRenameRefactor: true,
        deleteDryRunBlocked: true,
      });
      expect(revision).toBeGreaterThanOrEqual(7);
      expect(
        project
          .getLayout('Game')
          .getObjects()
          .hasObjectNamed('DX34HeroRenamed')
      ).toBe(true);
    } finally {
      project.delete();
    }
  });
});
