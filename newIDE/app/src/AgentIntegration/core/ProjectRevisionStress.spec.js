// @flow
import { AgentHost } from './AgentHost';
import { makeCommandMetadata } from './CommandRegistry';
import { ProjectRevisionTracker } from './ProjectRevisionTracker';

const makeMutationDescriptor = execute => ({
  name: 'scene.mutate',
  description: 'Stress mutation command.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { cycle: { type: 'number' } },
  },
  metadata: makeCommandMetadata({
    readOnly: false,
    idempotent: false,
    requiresProject: true,
    modifiesProject: true,
  }),
  execute,
});

describe('Project revision stress', () => {
  it('rejects every stale write across 25 interleaved external edits and recovers at the current revision', async () => {
    let changesCount = 0;
    const execute = jest.fn(({ input }) => ({ appliedCycle: input.cycle }));
    const projectRevisionTracker = new ProjectRevisionTracker({
      getChangesCount: () => changesCount,
    });
    projectRevisionTracker.setSource({ projectKey: 'stress-project' });
    const host = new AgentHost({
      environment: {
        project: {
          getProjectUuid: () => 'stress-project',
          getName: () => 'Stress Project',
        },
        projectRevisionTracker,
        fileIdentifier: 'C:/stress/game.json',
        hasUnsavedChanges: true,
      },
      descriptors: [makeMutationDescriptor(execute)],
    });

    let knownRevision = 0;
    for (let cycle = 0; cycle < 25; cycle++) {
      const agentMutation = await host.execute(
        'scene.mutate',
        { cycle },
        { expectedRevision: knownRevision }
      );
      knownRevision = agentMutation.meta.projectRevision;
      expect(knownRevision).toBe(cycle * 3 + 1);

      changesCount += 1;
      await expect(
        host.execute(
          'scene.mutate',
          { cycle },
          { expectedRevision: knownRevision }
        )
      ).rejects.toMatchObject({
        code: 'revision_conflict',
        retryable: true,
        currentRevision: knownRevision + 1,
        details: {
          expectedRevision: knownRevision,
          currentRevision: knownRevision + 1,
          revisionDelta: 1,
          lastChange: {
            source: 'external',
            revision: knownRevision + 1,
            revisionDelta: 1,
          },
        },
      });

      knownRevision += 1;
      const recoveredMutation = await host.execute(
        'scene.mutate',
        { cycle },
        { expectedRevision: knownRevision }
      );
      knownRevision = recoveredMutation.meta.projectRevision;
      expect(knownRevision).toBe(cycle * 3 + 3);
    }

    expect(knownRevision).toBe(75);
    expect(execute).toHaveBeenCalledTimes(50);
  });
});
