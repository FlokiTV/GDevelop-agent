// @flow
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';
import { ELIGIBLE_MUTATION_COMMANDS } from './MutationPlanningService';

const PLAN_METADATA = makeCommandMetadata({
  readOnly: true,
  requiresProject: true,
});

const COMMIT_METADATA = makeCommandMetadata({
  readOnly: false,
  destructive: true,
  idempotent: false,
  requiresProject: true,
  modifiesProject: true,
});

export const createMutationPlanningCommandDescriptors = ({
  mutationPlanningService,
}: {|
  mutationPlanningService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'mutations.capabilities',
    description:
      'Describe the cross-tool dry-run/plan contract, eligible mutation commands, structured change kinds and short-lived stale-safe plan token semantics.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    metadata: PLAN_METADATA,
    execute: () => mutationPlanningService.capabilities(),
  },
  {
    name: 'mutations.plan',
    description:
      'Validate and dry-run one eligible mutation without persistent project/filesystem/runtime side effects. Returns a localized structured change set, DX-37 reference impact, blockers/warnings, revision preconditions and an optional short-lived commit token.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'input'],
      properties: {
        command: {
          type: 'string',
          enum: ELIGIBLE_MUTATION_COMMANDS,
        },
        input: {
          type: 'object',
          additionalProperties: true,
        },
        ttlMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 600000,
          default: 120000,
        },
      },
    },
    metadata: PLAN_METADATA,
    execute: ({ input }) => mutationPlanningService.plan(input),
  },
  {
    name: 'mutations.commit',
    description:
      'Commit a previously reviewed short-lived mutation plan exactly once. Revalidates project revision and plan hash before applying; stale, expired or blocked plans fail with structured diagnostics.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['planToken'],
      properties: {
        planToken: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    metadata: COMMIT_METADATA,
    execute: ({ input }) => mutationPlanningService.commit(input),
  },
];
