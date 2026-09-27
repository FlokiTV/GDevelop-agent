// @flow

export const AGENT_ERROR_CODES = Object.freeze({
  AGENT_INTERNAL_ERROR: 'agent_internal_error',
  INVALID_COMMAND_INPUT: 'invalid_command_input',
  NO_PROJECT_OPEN: 'no_project_open',
  REVISION_CONFLICT: 'revision_conflict',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
});

export const AGENT_ERROR_CATEGORIES = Object.freeze({
  VALIDATION: 'validation',
  NOT_FOUND: 'not-found',
  CONFLICT: 'conflict',
  AVAILABILITY: 'availability',
  PERMISSION: 'permission',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
  SAFETY: 'safety',
  INTERNAL: 'internal',
  EXECUTION: 'execution',
});

export const inferAgentErrorCategory = (code: any): string => {
  const normalized = typeof code === 'string' && code ? code.toLowerCase() : '';

  if (!normalized || normalized === AGENT_ERROR_CODES.AGENT_INTERNAL_ERROR) {
    return AGENT_ERROR_CATEGORIES.INTERNAL;
  }
  if (normalized.includes('cancel')) {
    return AGENT_ERROR_CATEGORIES.CANCELLED;
  }
  if (normalized.includes('timeout')) {
    return AGENT_ERROR_CATEGORIES.TIMEOUT;
  }
  if (
    normalized.includes('human_confirmation') ||
    normalized.includes('destructive_confirmation') ||
    normalized.includes('safety_')
  ) {
    return AGENT_ERROR_CATEGORIES.SAFETY;
  }
  if (
    normalized.includes('forbidden') ||
    normalized.includes('unauthorized') ||
    normalized.includes('permission') ||
    normalized.includes('ownership') ||
    normalized.includes('owner_identity')
  ) {
    return AGENT_ERROR_CATEGORIES.PERMISSION;
  }
  if (
    normalized.includes('conflict') ||
    normalized.includes('mismatch') ||
    normalized.includes('stale') ||
    normalized.includes('locked') ||
    normalized.includes('_taken') ||
    normalized.includes('already_exists')
  ) {
    return AGENT_ERROR_CATEGORIES.CONFLICT;
  }
  if (normalized.includes('not_found')) {
    return AGENT_ERROR_CATEGORIES.NOT_FOUND;
  }
  if (
    normalized === AGENT_ERROR_CODES.NO_PROJECT_OPEN ||
    normalized.includes('unavailable') ||
    normalized.includes('not_ready') ||
    normalized.includes('project_required')
  ) {
    return AGENT_ERROR_CATEGORIES.AVAILABILITY;
  }
  if (
    normalized.startsWith('invalid_') ||
    normalized.startsWith('missing_') ||
    normalized.startsWith('too_many_') ||
    normalized.startsWith('unsupported_') ||
    normalized.startsWith('unknown_') ||
    normalized.includes('schema') ||
    normalized.includes('malformed')
  ) {
    return AGENT_ERROR_CATEGORIES.VALIDATION;
  }
  return AGENT_ERROR_CATEGORIES.EXECUTION;
};

const inferField = (field: any, details: any): ?string =>
  typeof field === 'string' && field
    ? field
    : details && typeof details.field === 'string' && details.field
    ? details.field
    : null;

const inferPath = (path: any, details: any): any => {
  if (path !== undefined && path !== null) return path;
  if (details && details.path !== undefined && details.path !== null) {
    return details.path;
  }
  return null;
};

export type AgentErrorOptions = {|
  code: string,
  category?: string,
  message?: string,
  retryable?: boolean,
  hint?: string,
  recovery?: string,
  field?: string,
  path?: any,
  details?: any,
  currentRevision?: string | number,
  traceId?: string,
  cause?: any,
|};

export class AgentError extends Error {
  code: string;
  category: string;
  retryable: boolean;
  hint: ?string;
  recovery: ?string;
  field: ?string;
  path: any;
  details: any;
  currentRevision: ?(string | number);
  traceId: ?string;
  cause: any;

  constructor({
    code,
    category,
    message,
    retryable = false,
    hint,
    recovery,
    field,
    path,
    details,
    currentRevision,
    traceId,
    cause,
  }: AgentErrorOptions) {
    super(message || code);
    this.name = 'AgentError';
    this.code = code;
    this.category =
      typeof category === 'string' && category
        ? category
        : inferAgentErrorCategory(code);
    this.retryable = retryable;
    this.hint = hint || null;
    this.recovery = recovery || null;
    this.field = inferField(field, details);
    this.path = inferPath(path, details);
    this.details = details;
    this.currentRevision =
      currentRevision === undefined ? null : currentRevision;
    this.traceId = traceId || null;
    this.cause = cause;
  }
}

export const normalizeAgentError = (
  error: any,
  fallbackCode: string = AGENT_ERROR_CODES.AGENT_INTERNAL_ERROR
): AgentError => {
  if (error instanceof AgentError) return error;

  const code =
    error && typeof error.code === 'string' && error.code
      ? error.code
      : fallbackCode;
  const message =
    error && typeof error.message === 'string' && error.message
      ? error.message
      : String(error || fallbackCode);

  return new AgentError({
    code,
    category:
      error && typeof error.category === 'string' && error.category
        ? error.category
        : undefined,
    message,
    retryable: !!(error && error.retryable),
    hint:
      error && typeof error.hint === 'string' && error.hint
        ? error.hint
        : undefined,
    recovery:
      error && typeof error.recovery === 'string' && error.recovery
        ? error.recovery
        : undefined,
    field:
      error && typeof error.field === 'string' && error.field
        ? error.field
        : undefined,
    path: error && error.path !== undefined ? error.path : undefined,
    details: error && error.details !== undefined ? error.details : undefined,
    currentRevision:
      error && error.currentRevision !== undefined
        ? error.currentRevision
        : undefined,
    traceId:
      error && typeof error.traceId === 'string' && error.traceId
        ? error.traceId
        : undefined,
    cause: error,
  });
};

export const serializeAgentError = (error: any) => {
  const normalized = normalizeAgentError(error);
  return {
    code: normalized.code,
    category: normalized.category,
    message: normalized.message,
    retryable: normalized.retryable,
    ...(normalized.hint ? { hint: normalized.hint } : {}),
    ...(normalized.recovery ? { recovery: normalized.recovery } : {}),
    ...(normalized.field ? { field: normalized.field } : {}),
    ...(normalized.path !== null ? { path: normalized.path } : {}),
    ...(normalized.details !== undefined
      ? { details: normalized.details }
      : {}),
    ...(normalized.currentRevision !== null
      ? { currentRevision: normalized.currentRevision }
      : {}),
    ...(normalized.traceId ? { traceId: normalized.traceId } : {}),
  };
};
