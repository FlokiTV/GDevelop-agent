// @flow
import { AgentHost } from '../core/AgentHost';
import { serializeAgentError } from '../core/AgentError';
import { ProjectRevisionTracker } from '../core/ProjectRevisionTracker';
import { createBehaviorLifecycleCommandDescriptors } from './BehaviorLifecycleCommands';
import { createBehaviorLifecycleService } from './BehaviorLifecycleService';
import { createMetadataDiscoveryService } from './MetadataDiscoveryService';
import { createObjectPropertyCommandDescriptors } from './ObjectPropertyCommands';
import { createObjectPropertyService } from './ObjectPropertyService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';
import { editorFunctions } from '../../EditorFunctions';

const {
  runBehaviorLifecycleCleanRoomActor,
} = require('./BehaviorLifecycleCleanRoomActor');

const gd: libGDevelop = global.gd;

describe('DX-29 behavior lifecycle clean-room acceptance', () => {
  beforeAll(() => {
    makeTestExtensions(gd);
  });

  it('lets an external actor discover, attach, configure and remove behaviors/capabilities using MCP-only contracts', async () => {
    // $FlowFixMe[invalid-constructor]
    const project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX29 Clean Room Acceptance');
    const scene = project.insertNewLayout('Game', 0);
    scene
      .getObjects()
      .insertNewObject(project, 'TextObject::Text', 'ConfigurableLabel', 0);
    scene
      .getObjects()
      .insertNewObject(project, 'Sprite', 'IncompatibleHero', 1);
    const resizable = scene
      .getObjects()
      .insertNewObject(
        project,
        'TiledSpriteObject::TiledSprite',
        'ResizableTile',
        2
      );

    const resizableName = resizable
      .getAllBehaviorNames()
      .toJSArray()
      .find(
        name =>
          resizable.getBehavior(name).getTypeName() ===
          'ResizableCapability::ResizableBehavior'
      );
    expect(resizableName).toBeTruthy();
    // Simulate a stale/legacy project missing a capability that the connected
    // object-type metadata declares as a default. The public lifecycle tool is
    // expected to repair this exact state, but never force the same capability
    // onto an object type that does not declare it.
    resizable.removeBehavior(resizableName);
    scene.updateBehaviorsSharedData(project);

    const editorFunctionService = {
      run: jest.fn().mockImplementation(async ({ calls }) => {
        const results = [];
        for (const call of calls || []) {
          const editorFunction = editorFunctions[call.name];
          if (!editorFunction) {
            results.push({
              status: 'finished',
              success: false,
              output: { success: false, message: 'unknown_editor_function' },
            });
            continue;
          }
          // The clean-room actor never imports this implementation. The
          // harness deliberately executes the same canonical backend that the
          // production EditorFunctionService dispatches.
          const output = await editorFunction.launchFunction({
            project,
            args: call.arguments || {},
            toolsVersion: 'dx29-clean-room',
          });
          results.push({
            status: 'finished',
            success: output && output.success !== false,
            output,
          });
        }
        return {
          results,
          didModifyProject: results.some(result => result.success),
        };
      }),
    };

    const triggerUnsavedChanges = jest.fn();
    const forceUpdate = jest.fn();
    const onObjectsModifiedOutsideEditor = jest.fn();
    const metadataDiscoveryService = createMetadataDiscoveryService({
      project,
    });
    const objectPropertyService = createObjectPropertyService({
      project,
      metadataDiscoveryService,
      editorFunctionService,
      triggerUnsavedChanges,
      forceUpdate,
      onInstancesModifiedOutsideEditor: jest.fn(),
    });
    const behaviorLifecycleService = createBehaviorLifecycleService({
      project,
      metadataDiscoveryService,
      objectPropertyService,
      triggerUnsavedChanges,
      forceUpdate,
      onObjectsModifiedOutsideEditor,
    });
    const descriptors = [
      ...createBehaviorLifecycleCommandDescriptors({
        behaviorLifecycleService,
      }),
      ...createObjectPropertyCommandDescriptors({ objectPropertyService }),
    ];

    let changesCount = 0;
    const projectRevisionTracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    projectRevisionTracker.setSource({ projectKey: 'dx29-clean-room' });

    const identity = {
      clientId: 'dx29-clean-room-client',
      agentId: 'external-clean-room-agent',
      sessionId: 'dx29-clean-room-session',
      taskId: 'dx29-clean-room-task',
      ownerKey: 'external-clean-room-agent::dx29-clean-room-session',
    };
    const host = new AgentHost({
      environment: {
        project,
        projectRevisionTracker,
        getTransactionStatus: () => ({
          active: true,
          transactionId: 'tx-dx29-clean-room',
          owner: identity,
          purpose: 'DX-29 clean-room acceptance',
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
      const evidence = await runBehaviorLifecycleCleanRoomActor({
        client,
        sceneName: 'Game',
        configurableObjectName: 'ConfigurableLabel',
        incompatibleObjectName: 'IncompatibleHero',
        resizableObjectName: 'ResizableTile',
      });

      expect(evidence).toMatchObject({
        resizable: {
          behaviorType: 'ResizableCapability::ResizableBehavior',
          restored: true,
          width: {
            path: expect.stringMatching(/width$/i),
            value: 321,
            actionId: expect.stringMatching(/SetWidth$/),
          },
          height: {
            path: expect.stringMatching(/height$/i),
            value: 181,
            actionId: expect.stringMatching(/SetHeight$/),
          },
        },
        lifecycle: {
          behaviorName: 'DX29ConfiguredBehavior',
          propertyPath: expect.stringMatching(
            /^behaviors\.DX29ConfiguredBehavior\.properties\./
          ),
          removed: true,
        },
        incompatible: {
          errorCode: 'behavior_incompatible_with_object',
          field: 'behaviorType',
          mutationPrevented: true,
        },
        projectRevision: expect.any(Number),
      });
      expect(evidence.projectRevision).toBeGreaterThanOrEqual(4);
      const finalTiledConfiguration = gd.asTiledSpriteConfiguration(
        scene
          .getObjects()
          .getObject('ResizableTile')
          .getConfiguration()
      );
      expect(finalTiledConfiguration.getWidth()).toBe(321);
      expect(finalTiledConfiguration.getHeight()).toBe(181);
      expect(
        scene
          .getObjects()
          .getObject('ConfigurableLabel')
          .hasBehaviorNamed('DX29ConfiguredBehavior')
      ).toBe(false);
      expect(
        scene
          .getObjects()
          .getObject('IncompatibleHero')
          .hasBehaviorNamed('DX29ShouldNotAttach')
      ).toBe(false);
    } finally {
      project.delete();
    }
  });
});
