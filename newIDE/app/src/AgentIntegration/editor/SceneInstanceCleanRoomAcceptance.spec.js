// @flow
import { AgentHost } from '../core/AgentHost';
import { serializeAgentError } from '../core/AgentError';
import { ProjectRevisionTracker } from '../core/ProjectRevisionTracker';
import { createLayerOrderService } from './LayerOrderService';
import { createMetadataDiscoveryService } from './MetadataDiscoveryService';
import { createObjectPropertyService } from './ObjectPropertyService';
import { createSceneInstanceCommandDescriptors } from './SceneInstanceCommands';
import { createSceneInstanceService } from './SceneInstanceService';

const {
  runSceneInstanceCleanRoomActor,
} = require('./SceneInstanceCleanRoomActor');

const gd: libGDevelop = global.gd;

describe('DX-27 scene instance clean-room acceptance', () => {
  it('updates one identity without duplication and deterministically cleans sidebar duplicates without raw project JSON', async () => {
    // $FlowFixMe[invalid-constructor]
    const project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX27 Clean Room');
    const scene = project.insertNewLayout('Game', 0);
    scene.getLayers().insertNewLayer('Gameplay', 1);
    scene.getObjects().insertNewObject(project, 'Sprite', 'Coin', 0);
    scene.getObjects().insertNewObject(project, 'Sprite', 'Worker', 1);

    const add = (objectName, x, y, zOrder) => {
      const instance = scene.getInitialInstances().insertNewInitialInstance();
      instance.setObjectName(objectName);
      instance.setLayer('Gameplay');
      instance.setX(x);
      instance.setY(y);
      instance.setZ(0);
      instance.setAngle(0);
      instance.setZOrder(zOrder);
      return instance;
    };

    add('Worker', 20, 40, 1);
    add('Coin', 100, 200, 2);
    add('Coin', 100, 200, 2);
    add('Coin', 100, 200, 2);

    const triggerUnsavedChanges = jest.fn();
    const forceUpdate = jest.fn();
    const onInstancesModifiedOutsideEditor = jest.fn();
    const layerOrderService = createLayerOrderService({
      project,
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor,
    });
    const objectPropertyService = createObjectPropertyService({
      project,
      metadataDiscoveryService: createMetadataDiscoveryService({ project }),
      editorFunctionService: {
        run: jest.fn().mockResolvedValue({
          results: [{ status: 'finished', success: true, output: {} }],
          didModifyProject: true,
        }),
      },
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor,
    });
    const sceneInstanceService = createSceneInstanceService({
      project,
      layerOrderService,
      objectPropertyService,
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor,
    });
    const descriptors = createSceneInstanceCommandDescriptors({
      sceneInstanceService,
    });

    let changesCount = 0;
    const tracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    tracker.setSource({ projectKey: 'dx27-clean-room' });

    const identity = {
      clientId: 'dx27-client',
      agentId: 'external-instance-agent',
      sessionId: 'dx27-session',
      taskId: 'dx27-task',
      ownerKey: 'external-instance-agent::dx27-session',
    };
    const host = new AgentHost({
      environment: {
        project,
        projectRevisionTracker: tracker,
        getTransactionStatus: () => ({
          active: true,
          transactionId: 'tx-dx27-clean-room',
          owner: identity,
          purpose: 'DX-27 clean-room acceptance',
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
      const evidence = await runSceneInstanceCleanRoomActor({
        client,
        sceneName: 'Game',
      });

      expect(evidence).toMatchObject({
        updateDidNotCreate: true,
        countBeforeUpdate: 4,
        countAfterUpdate: 4,
        finalCoinCount: 1,
        rawProjectJsonUsed: false,
      });
      expect(evidence.updateInstanceId).toEqual(expect.any(String));
      expect(evidence.canonicalInstanceId).toEqual(expect.any(String));
      expect(evidence.deletedDuplicateInstanceIds).toHaveLength(2);
      expect(evidence.dryRunSelectionRevision).toMatch(/^selection-rev-/);
      expect(evidence.finalProjectRevision).toBeGreaterThan(
        evidence.dryRunProjectRevision
      );
      expect(scene.getInitialInstances().getInstancesCount()).toBe(2);
    } finally {
      project.delete();
    }
  });
});
