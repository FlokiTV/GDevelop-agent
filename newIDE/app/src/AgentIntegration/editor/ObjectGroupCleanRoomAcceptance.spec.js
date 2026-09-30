// @flow
import { AgentHost } from '../core/AgentHost';
import { serializeAgentError } from '../core/AgentError';
import { ProjectRevisionTracker } from '../core/ProjectRevisionTracker';
import { createEventTools } from '../EventTools';
import { createEventCommandDescriptors } from './EventCommands';
import { createMetadataDiscoveryCommandDescriptors } from './MetadataDiscoveryCommands';
import { createMetadataDiscoveryService } from './MetadataDiscoveryService';
import { createObjectGroupCommandDescriptors } from './ObjectGroupCommands';
import { createObjectGroupService } from './ObjectGroupService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const { runObjectGroupCleanRoomActor } = require('./ObjectGroupCleanRoomActor');

const gd: libGDevelop = global.gd;

describe('DX-31 Object group clean-room acceptance', () => {
  beforeAll(() => {
    makeTestExtensions(gd);
  });

  it('lets an external actor discover, author, refactor and safely remove a referenced group using MCP only', async () => {
    // $FlowFixMe[invalid-constructor]
    const project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX31 Clean Room Acceptance');
    const scene = project.insertNewLayout('Game', 0);
    scene.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);
    project.getObjects().insertNewObject(project, 'TextObject::Text', 'HUD', 0);

    const triggerUnsavedChanges = jest.fn();
    const forceUpdate = jest.fn();
    const onObjectGroupsModifiedOutsideEditor = jest.fn();
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
      onObjectGroupsModifiedOutsideEditor,
    });

    const descriptors = [
      ...createObjectGroupCommandDescriptors({ objectGroupService }),
      ...createEventCommandDescriptors({
        eventTools,
        metadataDiscoveryService,
      }),
      ...createMetadataDiscoveryCommandDescriptors({
        metadataDiscoveryService,
      }),
    ];

    let changesCount = 0;
    const projectRevisionTracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    projectRevisionTracker.setSource({ projectKey: 'dx31-clean-room' });

    const identity = {
      clientId: 'dx31-clean-room-client',
      agentId: 'external-clean-room-agent',
      sessionId: 'dx31-clean-room-session',
      taskId: 'dx31-clean-room-task',
      ownerKey: 'external-clean-room-agent::dx31-clean-room-session',
    };
    const host = new AgentHost({
      environment: {
        project,
        projectRevisionTracker,
        getTransactionStatus: () => ({
          active: true,
          transactionId: 'tx-dx31-clean-room',
          owner: identity,
          purpose: 'DX-31 clean-room acceptance',
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
      const evidence = await runObjectGroupCleanRoomActor({
        client,
        sceneName: 'Game',
        sceneObjectName: 'Player',
        globalObjectName: 'HUD',
      });
      expect(evidence).toMatchObject({
        createdGroup: 'DX31Actors',
        renamedGroup: 'DX31Units',
        members: ['Player', 'HUD'],
        objectParameterSemantics: true,
        eventAuthored: true,
        usageMapped: true,
        nativeRenameRefactor: true,
        deleteDryRunBlocked: true,
        removed: true,
        projectRevision: expect.any(Number),
      });
      expect(evidence.projectRevision).toBeGreaterThanOrEqual(6);
      expect(
        scene
          .getObjects()
          .getObjectGroups()
          .has('DX31Units')
      ).toBe(false);
      expect(triggerUnsavedChanges).toHaveBeenCalled();
      expect(forceUpdate).toHaveBeenCalled();
      expect(onObjectGroupsModifiedOutsideEditor).toHaveBeenCalledWith({
        scene,
      });
    } finally {
      project.delete();
    }
  });
});
