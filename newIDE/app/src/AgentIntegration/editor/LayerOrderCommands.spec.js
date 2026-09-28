// @flow
import { AgentHost, resolveSemanticScopes } from '../core/AgentHost';
import { ProjectRevisionTracker } from '../core/ProjectRevisionTracker';
import { SemanticConcurrency } from '../core/SemanticConcurrency';
import { createLayerOrderService } from './LayerOrderService';
import { createLayerOrderCommandDescriptors } from './LayerOrderCommands';

const gd: libGDevelop = global.gd;

describe('DX-26 layer/render-order command contracts', () => {
  let project: gdProject;
  let scene: gdLayout;
  let service: any;
  let descriptors: Array<any>;

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('DX26 Command Contract');
    scene = project.insertNewLayout('Game', 0);
    service = createLayerOrderService({
      project,
      triggerUnsavedChanges: jest.fn(),
      forceUpdate: jest.fn(),
      onInstancesModifiedOutsideEditor: jest.fn(),
    });
    descriptors = createLayerOrderCommandDescriptors({
      layerOrderService: service,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('publishes the typed read/mutation surface with DX-19 scene scope inference', () => {
    expect(descriptors.map(descriptor => descriptor.name)).toEqual([
      'scene.layers.list',
      'scene.render.compare',
      'scene.layers.create',
      'scene.layers.rename',
      'scene.layers.reorder',
      'scene.layers.delete',
      'scene.instances.move-layer',
      'scene.instances.set-render-order',
    ]);

    const list = descriptors.find(
      descriptor => descriptor.name === 'scene.layers.list'
    );
    const reorder = descriptors.find(
      descriptor => descriptor.name === 'scene.layers.reorder'
    );
    const zOrder = descriptors.find(
      descriptor => descriptor.name === 'scene.instances.set-render-order'
    );

    expect(list.metadata).toMatchObject({
      readOnly: true,
      modifiesProject: false,
      requiresProject: true,
    });
    expect(reorder.metadata).toMatchObject({
      readOnly: false,
      modifiesProject: true,
      requiresProject: true,
    });
    expect(
      resolveSemanticScopes(reorder, { sceneName: 'Game', position: 1 })
    ).toEqual(['project', 'scene:Game']);
    expect(zOrder.inputSchema.oneOf).toEqual([
      { required: ['zOrder'] },
      { required: ['beforeInstanceId'] },
      { required: ['afterInstanceId'] },
    ]);
    expect(zOrder.inputSchema.properties.expectedZOrder).toMatchObject({
      type: 'integer',
      minimum: -2147483648,
      maximum: 2147483647,
    });
  });

  it('enforces project revision, semantic revisions and owner-aware scene leases through AgentHost', async () => {
    let changesCount = 0;
    const projectRevisionTracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    projectRevisionTracker.setSource({ projectKey: 'dx26-contract' });
    const semanticConcurrency = new SemanticConcurrency();
    const host = new AgentHost({
      environment: {
        project,
        projectRevisionTracker,
        semanticConcurrency,
      },
      descriptors,
    });
    const ownerA = {
      agentId: 'agent-a',
      sessionId: 'session-a',
      ownerKey: 'agent-a::session-a',
    };
    const ownerB = {
      agentId: 'agent-b',
      sessionId: 'session-b',
      ownerKey: 'agent-b::session-b',
    };

    const first = await host.execute(
      'scene.layers.create',
      { sceneName: 'Game', name: 'Gameplay' },
      {
        identity: ownerA,
        expectedRevision: 0,
        expectedSemanticRevisions: {
          project: 0,
          'scene:Game': 0,
        },
      }
    );
    expect(first.meta).toMatchObject({
      modifiesProject: true,
      projectRevision: 1,
      identity: ownerA,
    });
    expect(first.meta.semanticRevisions).toEqual([
      { scope: 'project', revision: 1 },
      { scope: 'scene:Game', revision: 1 },
    ]);

    await expect(
      host.execute(
        'scene.layers.create',
        { sceneName: 'Game', name: 'Stale' },
        { identity: ownerA, expectedRevision: 0 }
      )
    ).rejects.toMatchObject({
      code: 'revision_conflict',
      retryable: true,
    });
    expect(scene.getLayers().hasLayerNamed('Stale')).toBe(false);

    const lease = semanticConcurrency.acquireLease({
      scope: 'scene:Game',
      owner: ownerB.ownerKey,
      identity: ownerB,
      ttlMs: 5000,
    });

    await expect(
      host.execute(
        'scene.layers.create',
        { sceneName: 'Game', name: 'Blocked' },
        {
          identity: ownerA,
          expectedRevision: 1,
          expectedSemanticRevisions: {
            project: 1,
            'scene:Game': 1,
          },
        }
      )
    ).rejects.toMatchObject({
      code: 'semantic_scope_locked',
      retryable: true,
      details: expect.objectContaining({
        scope: 'scene:Game',
        owner: ownerB.ownerKey,
      }),
    });
    expect(scene.getLayers().hasLayerNamed('Blocked')).toBe(false);

    const leased = await host.execute(
      'scene.layers.create',
      { sceneName: 'Game', name: 'UI' },
      {
        identity: ownerB,
        expectedRevision: 1,
        expectedSemanticRevisions: {
          project: 1,
          'scene:Game': 1,
        },
      }
    );
    expect(leased.meta).toMatchObject({
      semanticLeaseOwner: ownerB.ownerKey,
      leaseId: lease.leaseId,
      leaseIds: [lease.leaseId],
      projectRevision: 2,
    });
    expect(scene.getLayers().hasLayerNamed('UI')).toBe(true);

    await expect(
      host.execute(
        'scene.layers.create',
        { sceneName: 'Game', name: 'Mismatch' },
        {
          identity: ownerB,
          semanticLeaseOwner: ownerA.ownerKey,
          expectedRevision: 2,
        }
      )
    ).rejects.toMatchObject({
      code: 'semantic_lease_owner_identity_mismatch',
    });
  });
});
