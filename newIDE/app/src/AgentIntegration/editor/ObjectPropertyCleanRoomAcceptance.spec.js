// @flow
import { AgentHost } from '../core/AgentHost';
import { serializeAgentError } from '../core/AgentError';
import { ProjectRevisionTracker } from '../core/ProjectRevisionTracker';
import { createMetadataDiscoveryService } from './MetadataDiscoveryService';
import { createObjectPropertyService } from './ObjectPropertyService';
import { createObjectPropertyCommandDescriptors } from './ObjectPropertyCommands';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const {
  runObjectPropertyCleanRoomActor,
} = require('./ObjectPropertyCleanRoomActor');

const gd: libGDevelop = global.gd;

describe('DX-24 object property clean-room acceptance', () => {
  beforeAll(() => {
    makeTestExtensions(gd);
  });

  it('lets an external actor discover and mutate a property using only the public tool schema/call surface', async () => {
    // $FlowFixMe[invalid-constructor]
    const project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX24 Clean Room Acceptance');
    const scene = project.insertNewLayout('Game', 0);

    scene
      .getObjects()
      .insertNewObject(project, 'FakeTextInput::TextInput', 'CustomInput', 0);
    const resizableObject = scene
      .getObjects()
      .insertNewObject(
        project,
        'TiledSpriteObject::TiledSprite',
        'ResizableTile',
        1
      );
    const hasResizable = resizableObject
      .getAllBehaviorNames()
      .toJSArray()
      .some(
        name =>
          resizableObject.getBehavior(name).getTypeName() ===
          'ResizableCapability::ResizableBehavior'
      );
    if (!hasResizable) {
      resizableObject.addNewBehavior(
        project,
        'ResizableCapability::ResizableBehavior',
        'Resizable'
      );
    }

    const instance = scene.getInitialInstances().insertNewInitialInstance();
    instance.setObjectName('CustomInput');
    instance.setRawStringProperty('initialValue', 'Before');
    const instanceId = instance.getPersistentUuid();

    const objectPropertyService = createObjectPropertyService({
      project,
      metadataDiscoveryService: createMetadataDiscoveryService({ project }),
      editorFunctionService: { run: jest.fn() },
      triggerUnsavedChanges: jest.fn(),
      forceUpdate: jest.fn(),
      onInstancesModifiedOutsideEditor: jest.fn(),
    });
    const descriptors = createObjectPropertyCommandDescriptors({
      objectPropertyService,
    });

    let changesCount = 0;
    const projectRevisionTracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    projectRevisionTracker.setSource({ projectKey: 'dx24-clean-room' });

    const identity = {
      clientId: 'dx24-clean-room-client',
      agentId: 'external-clean-room-agent',
      sessionId: 'dx24-clean-room-session',
      taskId: 'dx24-clean-room-task',
      ownerKey: 'external-clean-room-agent::dx24-clean-room-session',
    };
    const host = new AgentHost({
      environment: {
        project,
        projectRevisionTracker,
        getTransactionStatus: () => ({
          active: true,
          transactionId: 'tx-dx24-clean-room',
          owner: identity,
          purpose: 'DX-24 clean-room acceptance',
          startedAt: 1,
        }),
      },
      descriptors,
    });

    const client = {
      listTools: async () =>
        descriptors.map(descriptor => ({
          name: descriptor.name,
          inputSchema: descriptor.metadata.modifiesProject
            ? {
                ...descriptor.inputSchema,
                properties: {
                  ...(descriptor.inputSchema.properties || {}),
                  expectedRevision: { type: 'integer', minimum: 0 },
                  expectedSemanticRevisions: {
                    type: 'object',
                    additionalProperties: { type: 'integer', minimum: 0 },
                  },
                  semanticLeaseOwner: { type: 'string', minLength: 1 },
                  idempotencyKey: { type: 'string', minLength: 1 },
                },
              }
            : descriptor.inputSchema,
          annotations: {
            readOnlyHint: !!descriptor.metadata.readOnly,
            destructiveHint: !!descriptor.metadata.destructive,
            idempotentHint: !!descriptor.metadata.idempotent,
            openWorldHint: false,
          },
        })),
      call: async (name, args = {}) => {
        const {
          expectedRevision,
          expectedSemanticRevisions,
          semanticLeaseOwner,
          idempotencyKey,
          ...input
        } = args;
        try {
          const result = await host.execute(name, input, {
            identity,
            ...(Number.isInteger(expectedRevision) ? { expectedRevision } : {}),
            ...(expectedSemanticRevisions ? { expectedSemanticRevisions } : {}),
            ...(semanticLeaseOwner ? { semanticLeaseOwner } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          });
          return {
            isError: false,
            data: result.data,
            meta: result.meta,
            structuredContent: result,
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
      const evidence = await runObjectPropertyCleanRoomActor({
        client,
        sceneName: 'Game',
        instanceId,
        resizableObjectName: 'ResizableTile',
        sentinel: 'After via public MCP schema',
      });

      expect(evidence).toMatchObject({
        discoveredProperty: {
          path: expect.stringMatching(/^instance\.custom\./),
          valueType: 'string',
          mutationCommand: 'objects.properties.set',
        },
        mutation: {
          value: 'After via public MCP schema',
          projectRevision: 1,
          transactionId: 'tx-dx24-clean-room',
        },
        diagnostics: {
          invalidType: {
            code: 'invalid_property_type',
            field: 'changes[0].value',
          },
          invalidPath: {
            code: 'unknown_property_path',
            field: 'changes[0].path',
          },
        },
        capabilities: [
          {
            property: 'width',
            path: 'runtime.width',
            actionId: expect.stringMatching(/SetWidth$/),
            authoringCommand: 'events.patch',
          },
          {
            property: 'height',
            path: 'runtime.height',
            actionId: expect.stringMatching(/SetHeight$/),
            authoringCommand: 'events.patch',
          },
        ],
      });
      expect(instance.getRawStringProperty('initialValue')).toBe(
        'After via public MCP schema'
      );
    } finally {
      project.delete();
    }
  });
});
