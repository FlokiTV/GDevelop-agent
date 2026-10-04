// @flow
import { createMutationPlanningService } from './MutationPlanningService';

const makeImpact = ({
  graphRevision = 'reference-graph:test',
  operation = 'rename',
  blockers = [],
  warnings = [],
}: any = {}) => ({
  graphRevision,
  operation,
  target: {
    selector: 'object-definition:obj-1',
    kind: 'object-definition',
    name: 'Hero',
  },
  affectedReferenceCount: 3,
  affectedReferences: [
    {
      id: 'edge:instance',
      referenceKind: 'instance-of-object',
      strength: 'hard',
      autoRefactorable: true,
      blockerOnDelete: true,
      source: { selector: 'instance:one', kind: 'scene-instance' },
      target: {
        selector: 'object-definition:obj-1',
        kind: 'object-definition',
      },
      location: { sceneName: 'Scene', instanceId: 'inst-1' },
    },
    {
      id: 'edge:event',
      referenceKind: 'event-parameter-object',
      strength: 'hard',
      autoRefactorable: true,
      blockerOnDelete: true,
      source: { selector: 'action:fp:a', kind: 'event-action' },
      target: {
        selector: 'object-definition:obj-1',
        kind: 'object-definition',
      },
      location: {
        target: { kind: 'scene', sceneName: 'Scene' },
        eventHandle: 'event:fp:e',
        instructionHandle: 'action:fp:a',
        parameterIndex: 0,
        eventsRevision: 'events:one',
      },
    },
    {
      id: 'edge:group',
      referenceKind: 'group-member',
      strength: 'hard',
      autoRefactorable: true,
      blockerOnDelete: true,
      source: { selector: 'object-group:scene:Scene:Actors' },
      target: {
        selector: 'object-definition:obj-1',
        kind: 'object-definition',
      },
      location: { sceneName: 'Scene', groupName: 'Actors' },
    },
  ],
  hardReferenceCount: 3,
  softReferenceCount: 0,
  dynamicReferenceCount: warnings.length,
  safelyRewritableCount: 3,
  safelyRewritable: [
    {
      id: 'edge:instance',
      referenceKind: 'instance-of-object',
      source: { selector: 'instance:one', kind: 'scene-instance' },
      target: {
        selector: 'object-definition:obj-1',
        kind: 'object-definition',
      },
      scope: 'scene',
      location: { sceneName: 'Scene', instanceId: 'inst-1' },
    },
    {
      id: 'edge:event',
      referenceKind: 'event-parameter-object',
      source: { selector: 'action:fp:a', kind: 'event-action' },
      target: {
        selector: 'object-definition:obj-1',
        kind: 'object-definition',
      },
      scope: 'project-scene',
      location: {
        target: { kind: 'scene', sceneName: 'Scene' },
        eventHandle: 'event:fp:e',
        instructionHandle: 'action:fp:a',
        parameterIndex: 0,
        eventsRevision: 'events:one',
      },
    },
    {
      id: 'edge:group',
      referenceKind: 'group-member',
      source: { selector: 'object-group:scene:Scene:Actors' },
      target: {
        selector: 'object-definition:obj-1',
        kind: 'object-definition',
      },
      scope: 'scene',
      location: { sceneName: 'Scene', groupName: 'Actors' },
    },
  ],
  blockerCount: blockers.length,
  blockers,
  unresolvedWarnings: warnings,
  projectModified: false,
});

const makeFixture = () => {
  let revision = 7;
  let now = 1000;
  const rename = jest.fn(input => {
    if (input.newObjectName === 'Taken') {
      const error: any = new Error('name conflict');
      error.code = 'object_definition_name_conflict';
      error.field = 'newObjectName';
      throw error;
    }
    if (input.dryRun === true) {
      return {
        renamed: false,
        dryRun: true,
        object: {
          identity: {
            objectId: 'obj-1',
            selector: 'object-definition:obj-1',
          },
          name: 'Hero',
          scope: 'scene',
          sceneName: 'Scene',
          type: 'Sprite',
        },
        plan: {
          operation: 'rename-object-definition',
          before: {
            objectId: 'obj-1',
            objectName: 'Hero',
            objectScope: 'scene',
            sceneName: 'Scene',
          },
          after: {
            objectId: 'obj-1',
            objectName: input.newObjectName,
            objectScope: 'scene',
            sceneName: 'Scene',
          },
          rewrittenReferences: {
            instances: 1,
            groups: 1,
            eventInstructions: 1,
          },
          blockers: [],
          warnings: [],
        },
      };
    }
    return {
      renamed: true,
      objectId: 'obj-1',
      newObjectName: input.newObjectName,
    };
  });
  const remove = jest.fn(input => ({
    deleted: input.dryRun === false,
    plan: {
      operation: 'delete-object-definition',
      target: {
        objectId: 'obj-1',
        objectName: 'Hero',
        objectScope: 'scene',
        sceneName: 'Scene',
      },
      blockers: [],
      warnings: [],
    },
  }));
  const moveScope = jest.fn(input => ({
    moved: input.dryRun === false,
    plan: {
      operation: 'promote-object-definition',
      objectId: 'obj-1',
      objectName: 'Hero',
      from: { scope: 'scene', sceneName: 'Scene' },
      to: { scope: 'global' },
      blockers: [],
      warnings: [],
    },
  }));
  const deleteVisualResource = jest.fn(input => ({
    dryRun: input.dryRun !== false,
    blocked: input.resourceName === 'used.png',
    blockReason: input.resourceName === 'used.png' ? 'resource_in_use' : null,
    wouldRemoveResource: input.resourceName !== 'used.png',
    wouldDeleteFile:
      input.resourceName !== 'used.png' && input.deleteFile === true,
    resource: {
      name: input.resourceName,
      kind: 'image',
      projectRelativePath: 'assets/' + input.resourceName,
    },
    usages:
      input.resourceName === 'used.png'
        ? { usedInProject: true, objectUsages: [{ objectName: 'Hero' }] }
        : { usedInProject: false, objectUsages: [] },
  }));

  const referenceGraphService = {
    impact: jest.fn(input => {
      if (input.kind === 'resource') {
        const used = input.name === 'used.png';
        return {
          ...makeImpact({
            graphRevision: 'reference-graph:resource-' + input.name,
            operation: 'delete',
            blockers: used
              ? [
                  {
                    id: 'edge:resource',
                    referenceKind: 'object-resource',
                    strength: 'hard',
                    blockerOnDelete: true,
                    source: { selector: 'object-definition:obj-1' },
                    target: { selector: 'resource:' + input.name },
                  },
                ]
              : [],
          }),
          target: {
            selector: 'resource:' + input.name,
            kind: 'resource',
            name: input.name,
          },
          affectedReferenceCount: used ? 1 : 0,
          affectedReferences: [],
          safelyRewritableCount: 0,
          safelyRewritable: [],
          blockerCount: used ? 1 : 0,
        };
      }
      return makeImpact({ operation: input.operation });
    }),
  };

  const planState = {};
  const createService = () =>
    createMutationPlanningService({
      getProjectRevision: () => revision,
      referenceGraphService,
      objectDefinitionService: {
        rename,
        remove,
        moveScope,
      },
      assetTools: { deleteVisualResource },
      planState,
      now: () => now,
    });
  const service = createService();

  return {
    service,
    recreateService: createService,
    rename,
    remove,
    moveScope,
    deleteVisualResource,
    referenceGraphService,
    setRevision: value => {
      revision = value;
    },
    advanceTime: value => {
      now += value;
    },
  };
};

describe('MutationPlanningService', () => {
  test('plans object rename with localized structured diff, DX-37 impact and captured revisions without mutation', () => {
    const { service, rename } = makeFixture();
    const plan = service.plan({
      command: 'objects.definitions.rename',
      input: {
        objectId: 'obj-1',
        newObjectName: 'HeroRenamed',
      },
    });

    expect(plan).toMatchObject({
      valid: true,
      dryRun: true,
      commitAllowed: true,
      sideEffects: {
        projectModified: false,
        filesystemModified: false,
        runtimeModified: false,
      },
      preconditions: {
        projectRevision: 7,
        graphRevision: 'reference-graph:test',
        eventRevisions: [
          {
            target: { kind: 'scene', sceneName: 'Scene' },
            eventsRevision: 'events:one',
          },
        ],
      },
    });
    expect(plan.planToken).toMatch(/^mutation-plan:/);
    expect(plan.changeSet.renames).toEqual([
      expect.objectContaining({
        entityKind: 'object-definition',
        identity: {
          objectId: 'obj-1',
          selector: 'object-definition:obj-1',
        },
        before: expect.objectContaining({ objectName: 'Hero' }),
        after: expect.objectContaining({ objectName: 'HeroRenamed' }),
      }),
    ]);
    expect(plan.changeSet.referenceRewrites).toHaveLength(3);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
  });

  test('commits unchanged plan once and returns a committed diff identical to the reviewed plan', () => {
    const { service, rename } = makeFixture();
    const plan = service.plan({
      command: 'objects.definitions.rename',
      input: { objectId: 'obj-1', newObjectName: 'HeroRenamed' },
    });

    const committed = service.commit({ planToken: plan.planToken });
    expect(committed).toMatchObject({
      committed: true,
      planHash: plan.planHash,
      committedDiffMatchesPlan: true,
      committedDiff: plan.changeSet,
      plannedChangeSet: plan.changeSet,
      result: {
        renamed: true,
        objectId: 'obj-1',
        newObjectName: 'HeroRenamed',
      },
    });
    expect(rename).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false })
    );
    expect(() => service.commit({ planToken: plan.planToken })).toThrow(
      expect.objectContaining({ code: 'mutation_plan_not_found' })
    );
  });

  test('rejects stale plan after intervening project revision and never executes the mutation', () => {
    const { service, rename, setRevision } = makeFixture();
    const plan = service.plan({
      command: 'objects.definitions.rename',
      input: { objectId: 'obj-1', newObjectName: 'HeroRenamed' },
    });
    setRevision(8);

    expect(() => service.commit({ planToken: plan.planToken })).toThrow(
      expect.objectContaining({
        code: 'mutation_plan_stale',
        details: expect.objectContaining({
          actualProjectRevision: 8,
        }),
      })
    );
    expect(
      rename.mock.calls.filter(call => call[0].dryRun === false)
    ).toHaveLength(0);
  });

  test('preserves a planned token across service recreation and reports stale state after a later mutation', () => {
    const { service, recreateService, rename, setRevision } = makeFixture();
    const plan = service.plan({
      command: 'objects.definitions.rename',
      input: { objectId: 'obj-1', newObjectName: 'HeroRenamed' },
    });
    setRevision(8);

    const recreatedService = recreateService();
    expect(() =>
      recreatedService.commit({ planToken: plan.planToken })
    ).toThrow(
      expect.objectContaining({
        code: 'mutation_plan_stale',
        details: expect.objectContaining({ actualProjectRevision: 8 }),
      })
    );
    expect(
      rename.mock.calls.filter(call => call[0].dryRun === false)
    ).toHaveLength(0);
  });

  test('resource delete plan reports usages/blockers without project or filesystem mutation and commit stays blocked', () => {
    const { service, deleteVisualResource } = makeFixture();
    const plan = service.plan({
      command: 'resources.visual.delete',
      input: {
        resourceName: 'used.png',
        deleteFile: true,
      },
    });

    expect(plan).toMatchObject({
      valid: true,
      commitAllowed: false,
      sideEffects: {
        projectModified: false,
        filesystemModified: false,
        runtimeModified: false,
      },
    });
    expect(plan.changeSet.deletes[0]).toMatchObject({
      entityKind: 'resource',
      identity: {
        resourceName: 'used.png',
        selector: 'resource:used.png',
      },
      filesystem: { deleteFile: true },
    });
    expect(plan.diagnostics.blockers.length).toBeGreaterThan(0);
    expect(deleteVisualResource).toHaveBeenCalledTimes(1);
    expect(deleteVisualResource).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
    expect(() => service.commit({ planToken: plan.planToken })).toThrow(
      expect.objectContaining({ code: 'mutation_plan_commit_blocked' })
    );
    expect(
      deleteVisualResource.mock.calls.filter(call => call[0].dryRun === false)
    ).toHaveLength(0);
  });

  test('invalid target mutation becomes validation diagnostics with no commit token', () => {
    const { service } = makeFixture();
    const plan = service.plan({
      command: 'objects.definitions.rename',
      input: { objectId: 'obj-1', newObjectName: 'Taken' },
    });
    expect(plan).toMatchObject({
      valid: false,
      planToken: null,
      commitAllowed: false,
      diagnostics: {
        validationErrors: [
          expect.objectContaining({
            code: 'object_definition_name_conflict',
            field: 'newObjectName',
          }),
        ],
      },
    });
  });

  test('expires short-lived tokens before commit', () => {
    const { service, advanceTime } = makeFixture();
    const plan = service.plan({
      command: 'objects.definitions.rename',
      input: { objectId: 'obj-1', newObjectName: 'HeroRenamed' },
      ttlMs: 1000,
    });
    advanceTime(1001);
    expect(() => service.commit({ planToken: plan.planToken })).toThrow(
      expect.objectContaining({ code: 'mutation_plan_expired' })
    );
  });
});
