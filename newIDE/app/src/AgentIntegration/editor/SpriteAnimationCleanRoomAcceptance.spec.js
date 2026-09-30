// @flow
import { AgentHost } from '../core/AgentHost';
import { serializeAgentError } from '../core/AgentError';
import { ProjectRevisionTracker } from '../core/ProjectRevisionTracker';
import { createSpriteAnimationCommandDescriptors } from './SpriteAnimationCommands';
import { createSpriteAnimationService } from './SpriteAnimationService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const {
  runSpriteAnimationCleanRoomActor,
} = require('./SpriteAnimationCleanRoomActor');

const gd: libGDevelop = global.gd;

const addImageResource = (
  project: gdProject,
  name: string,
  width: number,
  height: number
) => {
  const resource = new gd.ImageResource();
  resource.setName(name);
  resource.setFile(name);
  project.getResourcesManager().addResource(resource);
  resource.delete();
  return { width, height };
};

describe('DX-30 Sprite animation clean-room acceptance', () => {
  beforeAll(() => {
    makeTestExtensions(gd);
  });

  it('lets an external actor discover and author Sprite animations/frames/points/masks using MCP-only contracts', async () => {
    // $FlowFixMe[invalid-constructor]
    const project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX30 Clean Room Acceptance');
    const scene = project.insertNewLayout('Game', 0);
    const hero = scene
      .getObjects()
      .insertNewObject(project, 'Sprite', 'Hero', 0);

    const dimensions = new Map();
    dimensions.set(
      'dx30-a.png',
      addImageResource(project, 'dx30-a.png', 32, 16)
    );
    dimensions.set(
      'dx30-b.png',
      addImageResource(project, 'dx30-b.png', 32, 16)
    );
    dimensions.set(
      'dx30-c.png',
      addImageResource(project, 'dx30-c.png', 64, 32)
    );

    const triggerUnsavedChanges = jest.fn();
    const forceUpdate = jest.fn();
    const onObjectsModifiedOutsideEditor = jest.fn();
    const assetTools = {
      inspectVisualResource: jest.fn(({ resourceName }) => ({
        image: dimensions.get(resourceName) || null,
        physical: {
          mimeType: 'image/png',
          byteSize: 128,
          projectRelativePath: resourceName,
        },
      })),
    };
    const spriteAnimationService = createSpriteAnimationService({
      project,
      assetTools,
      triggerUnsavedChanges,
      forceUpdate,
      onObjectsModifiedOutsideEditor,
    });
    const descriptors = createSpriteAnimationCommandDescriptors({
      spriteAnimationService,
    });

    let changesCount = 0;
    const projectRevisionTracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    projectRevisionTracker.setSource({ projectKey: 'dx30-clean-room' });

    const identity = {
      clientId: 'dx30-clean-room-client',
      agentId: 'external-clean-room-agent',
      sessionId: 'dx30-clean-room-session',
      taskId: 'dx30-clean-room-task',
      ownerKey: 'external-clean-room-agent::dx30-clean-room-session',
    };
    const host = new AgentHost({
      environment: {
        project,
        projectRevisionTracker,
        getTransactionStatus: () => ({
          active: true,
          transactionId: 'tx-dx30-clean-room',
          owner: identity,
          purpose: 'DX-30 clean-room acceptance',
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
      const evidence = await runSpriteAnimationCleanRoomActor({
        client,
        sceneName: 'Game',
        objectName: 'Hero',
        imageA: 'dx30-a.png',
        imageB: 'dx30-b.png',
        replacementImage: 'dx30-c.png',
      });

      expect(evidence).toMatchObject({
        createdAnimation: 'DX30Run',
        renamedAnimation: 'DX30Sprint',
        frameCount: 2,
        frameReplacement: {
          from: 'dx30-a.png',
          to: 'dx30-c.png',
          metadataPreserved: true,
        },
        pointAndMask: {
          origin: { x: 3, y: 4 },
          customPoint: 'Hand',
          collisionMask: 'polygons',
        },
        timing: {
          initialSeconds: 0.1,
          finalSeconds: 0.2,
          model: 'uniform-per-direction',
        },
        indexRisk: {
          dryRunVerified: true,
          unsafeApplyBlocked: true,
          acknowledgedApplySucceeded: true,
        },
        nativeRenameRefactor: true,
        removed: true,
        projectRevision: expect.any(Number),
      });

      expect(evidence.projectRevision).toBeGreaterThanOrEqual(6);
      expect(
        gd
          .asSpriteConfiguration(hero.getConfiguration())
          .getAnimations()
          .getAnimationsCount()
      ).toBe(0);
      expect(assetTools.inspectVisualResource).toHaveBeenCalled();
      expect(triggerUnsavedChanges).toHaveBeenCalled();
      expect(forceUpdate).toHaveBeenCalled();
      expect(onObjectsModifiedOutsideEditor).toHaveBeenCalledWith({
        scene,
        isNewObjectTypeUsed: false,
      });
    } finally {
      project.delete();
    }
  });
});
