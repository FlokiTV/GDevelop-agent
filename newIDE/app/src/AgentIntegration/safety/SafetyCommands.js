// @flow
import { AgentError } from '../core/AgentError';
import {
  makeCommandMetadata,
  type CommandDescriptor,
} from '../core/CommandRegistry';

const EMPTY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const CHECKPOINT_ID_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checkpointId'],
  properties: { checkpointId: { type: 'string', minLength: 1 } },
};

const LABEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { label: { type: 'string' } },
};

const assertCheckpointId = input => {
  if (!input.checkpointId || typeof input.checkpointId !== 'string') {
    throw new AgentError({ code: 'missing_checkpoint_id' });
  }
};

export const createSafetyCommandDescriptors = ({
  safetyService,
}: {|
  safetyService: any,
|}): Array<CommandDescriptor> => [
  {
    name: 'safety.checkpoints.create',
    description:
      'Create an in-memory checkpoint of the live project for later diff or rollback.',
    inputSchema: LABEL_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
    }),
    execute: ({ input }) => safetyService.createCheckpoint(input),
  },
  {
    name: 'safety.checkpoints.list',
    description: 'List checkpoints for the current live project.',
    inputSchema: EMPTY_SCHEMA,
    metadata: makeCommandMetadata({ requiresProject: true }),
    execute: () => safetyService.listCheckpoints(),
  },
  {
    name: 'safety.checkpoints.diff',
    description:
      'Diff a checkpoint against the current live project without modifying it.',
    inputSchema: CHECKPOINT_ID_SCHEMA,
    metadata: makeCommandMetadata({ requiresProject: true }),
    validateInput: assertCheckpointId,
    execute: ({ input }) => safetyService.diffCheckpoint(input),
  },
  {
    name: 'safety.checkpoints.delete',
    description: 'Delete an in-memory checkpoint.',
    inputSchema: CHECKPOINT_ID_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
    }),
    validateInput: assertCheckpointId,
    execute: ({ input }) => safetyService.deleteCheckpoint(input),
  },
  {
    name: 'safety.checkpoints.restore',
    description:
      'Restore a checkpoint using the safe project replacement path and restore editor scene context.',
    inputSchema: CHECKPOINT_ID_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    validateInput: assertCheckpointId,
    execute: ({ input }) => safetyService.restoreCheckpoint(input),
  },
  {
    name: 'safety.transactions.status',
    description: 'Return the active AgentIntegration transaction state.',
    inputSchema: EMPTY_SCHEMA,
    metadata: makeCommandMetadata({ requiresProject: true }),
    execute: () => safetyService.getTransactionStatus(),
  },
  {
    name: 'safety.transactions.begin',
    description:
      'Begin a transaction by creating an implicit rollback checkpoint.',
    inputSchema: LABEL_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
    }),
    execute: ({ input }) => safetyService.beginTransaction(input),
  },
  {
    name: 'safety.transactions.commit',
    description: 'Commit the active transaction and discard its rollback checkpoint.',
    inputSchema: EMPTY_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      idempotent: false,
      requiresProject: true,
    }),
    execute: () => safetyService.commitTransaction(),
  },
  {
    name: 'safety.transactions.rollback',
    description:
      'Rollback the active transaction and restore the previous editor context.',
    inputSchema: EMPTY_SCHEMA,
    metadata: makeCommandMetadata({
      readOnly: false,
      destructive: true,
      idempotent: false,
      requiresProject: true,
      modifiesProject: true,
    }),
    execute: () => safetyService.rollbackTransaction(),
  },
];
