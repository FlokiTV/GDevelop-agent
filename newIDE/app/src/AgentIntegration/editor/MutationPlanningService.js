// @flow
import { AgentError } from '../core/AgentError';

export const ELIGIBLE_MUTATION_COMMANDS = [
  'objects.definitions.rename',
  'objects.definitions.delete',
  'objects.definitions.move-scope',
  'resources.visual.delete',
];

const DEFAULT_PLAN_TTL_MS = 2 * 60 * 1000;
const MAX_PLAN_TTL_MS = 10 * 60 * 1000;

const stableStringify = (value: any): string => {
  const normalize = input => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      const output = {};
      Object.keys(input)
        .sort()
        .forEach(key => {
          if (input[key] !== undefined) output[key] = normalize(input[key]);
        });
      return output;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const clampInteger = (
  value: any,
  fallback: number,
  min: number,
  max: number
): number =>
  Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;

const normalizeError = (error: any): any => ({
  code:
    (error && error.code) ||
    (error && error.details && error.details.code) ||
    'mutation_plan_validation_failed',
  message: error && error.message ? error.message : String(error),
  field: error && error.field ? error.field : null,
  details: error && error.details ? error.details : null,
});

const uniqueEventRevisions = (impact: any): Array<any> => {
  const revisions = new Map();
  ((impact && impact.affectedReferences) || []).forEach(edge => {
    const location = edge && edge.location;
    if (!location || !location.eventsRevision) return;
    const target = location.target || {};
    const key = stableStringify({
      target,
      eventsRevision: location.eventsRevision,
    });
    if (!revisions.has(key)) {
      revisions.set(key, {
        target,
        eventsRevision: location.eventsRevision,
      });
    }
  });
  return Array.from(revisions.values());
};

export const createMutationPlanningService = ({
  getProjectRevision,
  referenceGraphService,
  objectDefinitionService,
  assetTools,
  planState,
  now = () => Date.now(),
}: {|
  getProjectRevision: () => number,
  referenceGraphService: any,
  objectDefinitionService: any,
  assetTools: any,
  planState?: any,
  now?: () => number,
|}) => {
  const persistentState = planState || {};
  if (!(persistentState.plans instanceof Map))
    persistentState.plans = new Map();
  if (!Number.isInteger(persistentState.sequence)) persistentState.sequence = 0;
  const plans = persistentState.plans;

  const requireEligibleCommand = (command: any): string => {
    if (
      typeof command !== 'string' ||
      !ELIGIBLE_MUTATION_COMMANDS.includes(command)
    ) {
      throw new AgentError({
        code: 'mutation_plan_command_not_supported',
        field: 'command',
        details: {
          command,
          eligibleCommands: ELIGIBLE_MUTATION_COMMANDS,
        },
      });
    }
    return command;
  };

  const getImpact = (command: string, input: any, dryRunResult: any): ?any => {
    if (command.startsWith('objects.definitions.')) {
      const objectId =
        (dryRunResult &&
          dryRunResult.object &&
          dryRunResult.object.identity &&
          dryRunResult.object.identity.objectId) ||
        (dryRunResult &&
          dryRunResult.plan &&
          dryRunResult.plan.target &&
          dryRunResult.plan.target.objectId) ||
        (dryRunResult && dryRunResult.plan && dryRunResult.plan.objectId) ||
        input.objectId;
      if (!objectId) return null;
      const operation =
        command === 'objects.definitions.rename'
          ? 'rename'
          : command === 'objects.definitions.move-scope'
          ? 'move'
          : 'delete';
      return referenceGraphService.impact({
        selector: 'object-definition:' + objectId,
        operation,
        maxDepth: 2,
      });
    }
    if (command === 'resources.visual.delete') {
      return referenceGraphService.impact({
        kind: 'resource',
        name: input.resourceName,
        operation: 'delete',
        maxDepth: 2,
      });
    }
    return null;
  };

  const dryRunCommand = (command: string, input: any): any => {
    if (command === 'objects.definitions.rename') {
      return objectDefinitionService.rename({
        ...input,
        dryRun: true,
      });
    }
    if (command === 'objects.definitions.delete') {
      return objectDefinitionService.remove({
        ...input,
        dryRun: true,
      });
    }
    if (command === 'objects.definitions.move-scope') {
      return objectDefinitionService.moveScope({
        ...input,
        dryRun: true,
      });
    }
    if (command === 'resources.visual.delete') {
      return assetTools.deleteVisualResource({
        ...input,
        dryRun: true,
      });
    }
    throw new AgentError({
      code: 'mutation_plan_command_not_supported',
      details: { command },
    });
  };

  const summarizeReferenceRewrite = (edge: any): any => ({
    edgeId: edge.id,
    referenceKind: edge.referenceKind,
    source: edge.source,
    target: edge.target,
    scope: edge.scope || null,
    location: edge.location || null,
  });

  const buildChangeSet = (
    command: string,
    input: any,
    dryRunResult: any,
    impact: ?any
  ): any => {
    const empty = {
      creates: [],
      updates: [],
      deletes: [],
      moves: [],
      renames: [],
      referenceRewrites: [],
    };
    const referenceRewrites = ((impact && impact.safelyRewritable) || []).map(
      summarizeReferenceRewrite
    );

    if (command === 'objects.definitions.rename') {
      const plan = dryRunResult.plan || {};
      return {
        ...empty,
        renames: [
          {
            entityKind: 'object-definition',
            identity: {
              objectId: plan.before && plan.before.objectId,
              selector:
                dryRunResult.object &&
                dryRunResult.object.identity &&
                dryRunResult.object.identity.selector,
            },
            scope:
              (plan.before && plan.before.objectScope) ||
              (dryRunResult.object && dryRunResult.object.scope) ||
              null,
            before: plan.before || null,
            after: plan.after || null,
          },
        ],
        referenceRewrites,
      };
    }

    if (command === 'objects.definitions.delete') {
      const plan = dryRunResult.plan || {};
      return {
        ...empty,
        deletes: [
          {
            entityKind: 'object-definition',
            identity: {
              objectId: plan.target && plan.target.objectId,
              selector:
                plan.target && plan.target.objectId
                  ? 'object-definition:' + plan.target.objectId
                  : null,
            },
            scope: plan.target && plan.target.objectScope,
            before: plan.target || null,
            after: null,
          },
        ],
        referenceRewrites,
      };
    }

    if (command === 'objects.definitions.move-scope') {
      const plan = dryRunResult.plan || {};
      return {
        ...empty,
        moves: [
          {
            entityKind: 'object-definition',
            identity: {
              objectId: plan.objectId,
              selector: plan.objectId
                ? 'object-definition:' + plan.objectId
                : null,
            },
            scope: {
              before: plan.from || null,
              after: plan.to || null,
            },
            before: plan.from || null,
            after: plan.to || null,
          },
        ],
        referenceRewrites,
      };
    }

    if (command === 'resources.visual.delete') {
      return {
        ...empty,
        deletes: [
          {
            entityKind: 'resource',
            identity: {
              resourceName: input.resourceName,
              selector: 'resource:' + encodeURIComponent(input.resourceName),
            },
            scope: 'project',
            before: dryRunResult.resource || {
              resourceName: input.resourceName,
            },
            after: null,
            filesystem: {
              deleteFile: input.deleteFile === true,
              fileDeletion: dryRunResult.fileDeletion || null,
            },
          },
        ],
        referenceRewrites,
      };
    }

    return empty;
  };

  const collectDiagnostics = (dryRunResult: any, impact: ?any): any => {
    const blockers = [
      ...((dryRunResult && dryRunResult.plan && dryRunResult.plan.blockers) ||
        []),
      ...(dryRunResult && dryRunResult.blocked
        ? [
            {
              code: dryRunResult.blockReason || 'mutation_blocked',
              details: dryRunResult.usages || null,
            },
          ]
        : []),
      ...((impact && impact.blockers) || []),
    ];
    const warnings = [
      ...((dryRunResult && dryRunResult.plan && dryRunResult.plan.warnings) ||
        []),
      ...((impact && impact.unresolvedWarnings) || []),
    ];
    return {
      validationErrors: [],
      blockers,
      warnings,
      unresolvedDynamicReferences: warnings.filter(
        warning =>
          warning &&
          (warning.code === 'reference_graph_dynamic_reference' ||
            warning.code ===
              'object_definition_has_potential_dynamic_references')
      ),
    };
  };

  const makeFingerprintPayload = (plan: any): any => ({
    command: plan.command,
    input: plan.input,
    preconditions: plan.preconditions,
    changeSet: plan.changeSet,
    diagnostics: plan.diagnostics,
    impact: plan.impact
      ? {
          graphRevision: plan.impact.graphRevision,
          operation: plan.impact.operation,
          target: plan.impact.target,
          affectedReferenceCount: plan.impact.affectedReferenceCount,
          safelyRewritableCount: plan.impact.safelyRewritableCount,
          blockerCount: plan.impact.blockerCount,
          unresolvedWarnings: plan.impact.unresolvedWarnings,
        }
      : null,
  });

  const buildPlan = (
    request: any,
    { issueToken = true }: {| issueToken?: boolean |} = {}
  ): any => {
    const command = requireEligibleCommand(request && request.command);
    const input =
      request && request.input && typeof request.input === 'object'
        ? { ...request.input }
        : {};
    const projectRevision = getProjectRevision();
    const createdAt = now();
    const ttlMs = clampInteger(
      request && request.ttlMs,
      DEFAULT_PLAN_TTL_MS,
      1000,
      MAX_PLAN_TTL_MS
    );

    let dryRunResult = null;
    let impact = null;
    let validationErrors = [];
    try {
      dryRunResult = dryRunCommand(command, input);
      impact = getImpact(command, input, dryRunResult);
    } catch (error) {
      validationErrors = [normalizeError(error)];
    }

    const changeSet =
      validationErrors.length === 0
        ? buildChangeSet(command, input, dryRunResult, impact)
        : {
            creates: [],
            updates: [],
            deletes: [],
            moves: [],
            renames: [],
            referenceRewrites: [],
          };
    const diagnostics =
      validationErrors.length === 0
        ? collectDiagnostics(dryRunResult, impact)
        : {
            validationErrors,
            blockers: [],
            warnings: [],
            unresolvedDynamicReferences: [],
          };

    const preconditions = {
      projectRevision,
      graphRevision: impact && impact.graphRevision,
      eventRevisions: uniqueEventRevisions(impact),
      command,
    };

    const basePlan = {
      valid: validationErrors.length === 0,
      dryRun: true,
      sideEffects: {
        projectModified: false,
        filesystemModified: false,
        runtimeModified: false,
      },
      command,
      input,
      changeSet,
      diagnostics,
      impact,
      preconditions,
      createdAt,
      expiresAt: createdAt + ttlMs,
      ttlMs,
    };
    const planHash =
      'mutation-plan:' +
      hashString(stableStringify(makeFingerprintPayload(basePlan)));
    let planToken = null;

    if (issueToken && basePlan.valid) {
      persistentState.sequence++;
      planToken =
        planHash +
        ':' +
        persistentState.sequence.toString(36) +
        ':' +
        Math.max(0, createdAt).toString(36);
      plans.set(planToken, {
        ...basePlan,
        planHash,
        planToken,
      });
    }

    return {
      ...basePlan,
      planHash,
      planToken,
      commitAllowed:
        basePlan.valid &&
        diagnostics.blockers.length === 0 &&
        diagnostics.unresolvedDynamicReferences.length === 0,
      projectModified: false,
    };
  };

  const executeCommand = (command: string, input: any): any => {
    if (command === 'objects.definitions.rename') {
      return objectDefinitionService.rename({ ...input, dryRun: false });
    }
    if (command === 'objects.definitions.delete') {
      return objectDefinitionService.remove({ ...input, dryRun: false });
    }
    if (command === 'objects.definitions.move-scope') {
      return objectDefinitionService.moveScope({ ...input, dryRun: false });
    }
    if (command === 'resources.visual.delete') {
      return assetTools.deleteVisualResource({ ...input, dryRun: false });
    }
    throw new AgentError({
      code: 'mutation_plan_command_not_supported',
      details: { command },
    });
  };

  const commit = (request: any = {}): any => {
    const planToken =
      request && typeof request.planToken === 'string' ? request.planToken : '';
    const stored = plans.get(planToken);
    if (!stored) {
      throw new AgentError({
        code: 'mutation_plan_not_found',
        field: 'planToken',
        details: { planToken },
      });
    }
    const currentTime = now();
    if (currentTime > stored.expiresAt) {
      plans.delete(planToken);
      throw new AgentError({
        code: 'mutation_plan_expired',
        field: 'planToken',
        details: {
          planToken,
          expiresAt: stored.expiresAt,
          currentTime,
        },
      });
    }

    const actualRevision = getProjectRevision();
    const staleReasons = [];
    if (actualRevision !== stored.preconditions.projectRevision) {
      staleReasons.push({
        code: 'project_revision_changed',
        expected: stored.preconditions.projectRevision,
        actual: actualRevision,
      });
    }

    let refreshed = null;
    if (!staleReasons.length) {
      refreshed = buildPlan(
        {
          command: stored.command,
          input: stored.input,
          ttlMs: stored.ttlMs,
        },
        { issueToken: false }
      );
      if (refreshed.planHash !== stored.planHash) {
        staleReasons.push({
          code: 'mutation_plan_hash_changed',
          expectedPlanHash: stored.planHash,
          actualPlanHash: refreshed.planHash,
          expectedGraphRevision: stored.preconditions.graphRevision,
          actualGraphRevision: refreshed.preconditions.graphRevision,
        });
      }
    }

    if (staleReasons.length) {
      throw new AgentError({
        code: 'mutation_plan_stale',
        field: 'planToken',
        details: {
          planToken,
          staleReasons,
          expectedPreconditions: stored.preconditions,
          actualProjectRevision: actualRevision,
        },
        hint:
          'Run mutations.plan again against the current project state and review the new diff before committing.',
      });
    }

    if (
      stored.diagnostics.blockers.length ||
      stored.diagnostics.unresolvedDynamicReferences.length
    ) {
      throw new AgentError({
        code: 'mutation_plan_commit_blocked',
        details: {
          planToken,
          diagnostics: stored.diagnostics,
        },
      });
    }

    const result = executeCommand(stored.command, stored.input);
    plans.delete(planToken);
    return {
      committed: true,
      command: stored.command,
      planToken,
      planHash: stored.planHash,
      preconditions: stored.preconditions,
      plannedChangeSet: stored.changeSet,
      committedDiff: stored.changeSet,
      committedDiffMatchesPlan: true,
      result,
    };
  };

  const capabilities = (): any => ({
    eligibleCommands: ELIGIBLE_MUTATION_COMMANDS,
    planCommand: 'mutations.plan',
    commitCommand: 'mutations.commit',
    token: {
      shortLived: true,
      defaultTtlMs: DEFAULT_PLAN_TTL_MS,
      maxTtlMs: MAX_PLAN_TTL_MS,
      staleOnProjectRevisionChange: true,
      staleOnPlanHashChange: true,
      singleUse: true,
    },
    structuredChangeKinds: [
      'creates',
      'updates',
      'deletes',
      'moves',
      'renames',
      'referenceRewrites',
    ],
    referenceImpact: 'DX-37',
    safetyAndOwnership: 'DX-19 AgentHost mutation envelope',
    responseEnvelope: 'DX-21',
    projectModified: false,
  });

  return {
    capabilities,
    plan: buildPlan,
    commit,
  };
};
