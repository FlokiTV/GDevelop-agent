// @flow
import { AgentHost } from '../core/AgentHost';
import { serializeAgentError } from '../core/AgentError';
import { ProjectRevisionTracker } from '../core/ProjectRevisionTracker';
import { createLayerOrderService } from './LayerOrderService';
import { createLayerOrderCommandDescriptors } from './LayerOrderCommands';

const { runLayerOrderCleanRoomActor } = require('./LayerOrderCleanRoomActor');
const gd: libGDevelop = global.gd;

describe('DX-26 layer/render-order clean-room acceptance', () => {
  it('lets an external actor discover and fix Board/gameplay/UI stacking using only public MCP schemas and calls', async () => {
    // $FlowFixMe[invalid-constructor]
    const project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX26 Clean Room');
    const scene = project.insertNewLayout('Game', 0);
    scene.getLayers().insertNewLayer('UI', 1);
    scene.getLayers().insertNewLayer('Gameplay', 2);

    const add = (name, layer, zOrder) => {
      const instance = scene.getInitialInstances().insertNewInitialInstance();
      instance.setObjectName(name);
      instance.setLayer(layer);
      instance.setZOrder(zOrder);
      return instance;
    };
    add('Board', 'Gameplay', 20);
    add('Coin', 'Gameplay', 5);
    add('Worker', 'Gameplay', 6);
    add('HUD', 'UI', 1000);

    const service = createLayerOrderService({
      project,
      triggerUnsavedChanges: jest.fn(),
      forceUpdate: jest.fn(),
      onInstancesModifiedOutsideEditor: jest.fn(),
    });
    const descriptors = createLayerOrderCommandDescriptors({
      layerOrderService: service,
    });
    let changesCount = 0;
    const tracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    tracker.setSource({ projectKey: 'dx26-clean-room' });
    const identity = {
      clientId: 'dx26-client',
      agentId: 'external-layer-agent',
      sessionId: 'dx26-session',
      taskId: 'dx26-task',
      ownerKey: 'external-layer-agent::dx26-session',
    };
    const host = new AgentHost({
      environment: {
        project,
        projectRevisionTracker: tracker,
        getTransactionStatus: () => ({
          active: true,
          transactionId: 'tx-dx26-clean-room',
          owner: identity,
          purpose: 'DX-26 clean-room acceptance',
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
      const evidence = await runLayerOrderCleanRoomActor({
        client,
        sceneName: 'Game',
      });
      expect(evidence.boardBelowCoin).toMatchObject({
        determinable: true,
        relation: 'below',
      });
      expect(evidence.boardBelowWorker).toMatchObject({
        determinable: true,
        relation: 'below',
      });
      expect(evidence.hudAboveWorker).toMatchObject({
        determinable: true,
        relation: 'above',
        reason: 'layer-order',
      });
      expect(evidence.projectRevision).toBeGreaterThanOrEqual(2);
      expect(
        evidence.layers.find(layer => layer.name === 'UI').index
      ).toBeGreaterThan(
        evidence.layers.find(layer => layer.name === 'Gameplay').index
      );
    } finally {
      project.delete();
    }
  });
});
