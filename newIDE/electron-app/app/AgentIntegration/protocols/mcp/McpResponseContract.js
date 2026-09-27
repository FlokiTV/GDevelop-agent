const RESPONSE_CONTRACT_VERSION = 1;

const ERROR_CATEGORIES = Object.freeze([
  'validation',
  'not-found',
  'conflict',
  'availability',
  'permission',
  'cancelled',
  'timeout',
  'safety',
  'internal',
  'execution',
]);

const inferErrorCategory = code => {
  const normalized = typeof code === 'string' && code ? code.toLowerCase() : '';
  if (!normalized || normalized === 'agent_internal_error') return 'internal';
  if (normalized.includes('cancel')) return 'cancelled';
  if (normalized.includes('timeout')) return 'timeout';
  if (
    normalized.includes('human_confirmation') ||
    normalized.includes('destructive_confirmation') ||
    normalized.includes('safety_')
  ) {
    return 'safety';
  }
  if (
    normalized.includes('forbidden') ||
    normalized.includes('unauthorized') ||
    normalized.includes('permission') ||
    normalized.includes('ownership') ||
    normalized.includes('owner_identity')
  ) {
    return 'permission';
  }
  if (
    normalized.includes('conflict') ||
    normalized.includes('mismatch') ||
    normalized.includes('stale') ||
    normalized.includes('locked') ||
    normalized.includes('_taken') ||
    normalized.includes('already_exists')
  ) {
    return 'conflict';
  }
  if (normalized.includes('not_found')) return 'not-found';
  if (
    normalized === 'no_project_open' ||
    normalized.includes('unavailable') ||
    normalized.includes('not_ready') ||
    normalized.includes('project_required')
  ) {
    return 'availability';
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
    return 'validation';
  }
  return 'execution';
};

const normalizeErrorField = value => {
  if (value && typeof value.field === 'string' && value.field) {
    return value.field;
  }
  const details = value && value.details;
  return details && typeof details.field === 'string' && details.field
    ? details.field
    : null;
};

const normalizeErrorPath = value => {
  if (value && value.path !== undefined && value.path !== null) {
    return value.path;
  }
  const details = value && value.details;
  return details && details.path !== undefined && details.path !== null
    ? details.path
    : null;
};

const normalizeIssuePath = issue => {
  const explicitPath = issue && issue.path;
  if (Array.isArray(explicitPath)) {
    return explicitPath
      .map(part => {
        if (
          part &&
          typeof part === 'object' &&
          Object.prototype.hasOwnProperty.call(part, 'key')
        ) {
          return part.key;
        }
        return part;
      })
      .filter(part => typeof part === 'string' || Number.isInteger(part));
  }
  if (typeof explicitPath === 'string' && explicitPath) {
    return explicitPath
      .replace(/^data\/?/, '')
      .split(/[/.]/)
      .filter(Boolean);
  }
  const message =
    issue && typeof issue.message === 'string' ? issue.message : '';
  const match = message.match(/(?:^|\s|,)data\/([^\s,]+)/);
  if (!match) return [];
  return match[1]
    .replace(/\.$/, '')
    .split('/')
    .filter(Boolean);
};

const normalizeValidationIssue = issue => {
  const message =
    issue && typeof issue.message === 'string' && issue.message
      ? issue.message
      : 'Invalid tool input.';
  const path = normalizeIssuePath(issue);
  return {
    message,
    ...(path.length ? { path } : {}),
  };
};

const makeInputValidationError = (toolName, issues) => {
  const normalizedIssues = Array.isArray(issues)
    ? issues.map(normalizeValidationIssue)
    : [];
  const firstPath =
    normalizedIssues.length && Array.isArray(normalizedIssues[0].path)
      ? normalizedIssues[0].path
      : [];
  const error = new Error(
    normalizedIssues.length
      ? `Invalid arguments for tool ${toolName}: ${normalizedIssues
          .map(issue => issue.message)
          .join('; ')}`
      : `Invalid arguments for tool ${toolName}.`
  );
  error.code = 'invalid_command_input';
  error.category = 'validation';
  error.retryable = false;
  if (firstPath.length) {
    error.path = firstPath;
    error.field = String(firstPath[firstPath.length - 1]);
  }
  error.details = {
    tool: toolName,
    issues: normalizedIssues,
  };
  return error;
};

const normalizeError = (error, fallbackTraceId = null) => {
  const value = error && typeof error === 'object' ? error : {};
  const code =
    typeof value.code === 'string' && value.code
      ? value.code
      : 'agent_internal_error';
  const message =
    typeof value.message === 'string' && value.message ? value.message : code;
  const category =
    typeof value.category === 'string' &&
    ERROR_CATEGORIES.includes(value.category)
      ? value.category
      : inferErrorCategory(code);
  const field = normalizeErrorField(value);
  const path = normalizeErrorPath(value);
  return {
    code,
    category,
    message,
    retryable: !!value.retryable,
    ...(typeof value.hint === 'string' && value.hint
      ? { hint: value.hint }
      : {}),
    ...(typeof value.recovery === 'string' && value.recovery
      ? { recovery: value.recovery }
      : {}),
    ...(field ? { field } : {}),
    ...(path !== null ? { path } : {}),
    ...(value.currentRevision !== undefined && value.currentRevision !== null
      ? { currentRevision: value.currentRevision }
      : {}),
    ...(value.details !== undefined ? { details: value.details } : {}),
    traceId:
      typeof value.traceId === 'string' && value.traceId
        ? value.traceId
        : fallbackTraceId,
  };
};

const readTransactionId = ({ input, data } = {}) => {
  if (data && typeof data.transactionId === 'string' && data.transactionId) {
    return data.transactionId;
  }
  if (input && typeof input.transactionId === 'string' && input.transactionId) {
    return input.transactionId;
  }
  return null;
};

const readLeaseId = ({ input, data } = {}) => {
  if (
    data &&
    data.lease &&
    typeof data.lease.leaseId === 'string' &&
    data.lease.leaseId
  ) {
    return data.lease.leaseId;
  }
  if (data && typeof data.leaseId === 'string' && data.leaseId) {
    return data.leaseId;
  }
  if (input && typeof input.leaseId === 'string' && input.leaseId) {
    return input.leaseId;
  }
  return null;
};

const normalizeSuccessMeta = (
  meta,
  { input, data, semanticLeaseOwner } = {}
) => {
  const source = meta && typeof meta === 'object' ? meta : {};
  const transactionId = readTransactionId({ input, data });
  const derivedLeaseId = readLeaseId({ input, data });
  const sourceLeaseIds = Array.isArray(source.leaseIds)
    ? source.leaseIds.filter(leaseId => typeof leaseId === 'string' && leaseId)
    : [];
  const leaseIds = sourceLeaseIds.length
    ? Array.from(new Set(sourceLeaseIds))
    : derivedLeaseId
    ? [derivedLeaseId]
    : [];
  const leaseId =
    typeof source.leaseId === 'string' && source.leaseId
      ? source.leaseId
      : leaseIds.length === 1
      ? leaseIds[0]
      : derivedLeaseId;
  return {
    ...source,
    traceId:
      typeof source.traceId === 'string' && source.traceId
        ? source.traceId
        : null,
    readOnly: !!source.readOnly,
    modifiesProject: !!source.modifiesProject,
    projectRevision: Number.isInteger(source.projectRevision)
      ? source.projectRevision
      : null,
    semanticRevisions: Array.isArray(source.semanticRevisions)
      ? source.semanticRevisions
      : [],
    durationMs: Number.isFinite(source.durationMs) ? source.durationMs : null,
    idempotencyReplayed: !!source.idempotencyReplayed,
    ...(transactionId ? { transactionId } : {}),
    ...(leaseId ? { leaseId } : {}),
    ...(leaseIds.length ? { leaseIds } : {}),
    ...(typeof semanticLeaseOwner === 'string' && semanticLeaseOwner
      ? { semanticLeaseOwner }
      : {}),
  };
};

const makeSuccessEnvelope = (result, { input, semanticLeaseOwner } = {}) => {
  if (
    !result ||
    typeof result !== 'object' ||
    typeof result.command !== 'string' ||
    !result.command
  ) {
    const error = new Error('Invalid AgentIntegration success envelope.');
    error.code = 'invalid_success_envelope';
    error.category = 'internal';
    throw error;
  }
  const data = result.data === undefined ? null : result.data;
  return {
    contractVersion: RESPONSE_CONTRACT_VERSION,
    command: result.command,
    data,
    meta: normalizeSuccessMeta(result.meta, {
      input,
      data,
      semanticLeaseOwner,
    }),
  };
};

const makeErrorEnvelope = error => ({
  contractVersion: RESPONSE_CONTRACT_VERSION,
  error,
});

const RESPONSE_CONTRACT_GUIDE = [
  '# GDevelop MCP response contract',
  '',
  `Contract version: ${RESPONSE_CONTRACT_VERSION}`,
  '',
  '## Success',
  '',
  'Every tools/call success exposes structuredContent as:',
  '',
  '{ "contractVersion": 1, "command": "<tool-name>", "data": <typed-result>, "meta": { ... } }',
  '',
  'Read result data only from structuredContent.data. Do not probe structuredContent itself, textual content or tool-specific fallback locations.',
  '',
  'meta always contains traceId, readOnly, modifiesProject, projectRevision, semanticRevisions, durationMs and idempotencyReplayed. Identity/target identity and transactionId/leaseId/semanticLeaseOwner are present when applicable.',
  '',
  'The MCP content array remains available for backward compatibility and for non-text content such as images; structuredContent is the authoritative machine-readable result.',
  '',
  '## Errors',
  '',
  'Tool failures set isError=true and expose structuredContent.error with code, category, message, retryable and traceId. Optional hint, recovery, field, path, details and currentRevision preserve actionable diagnostics.',
  '',
  'Stable categories are validation, not-found, conflict, availability, permission, cancelled, timeout, safety, internal and execution.',
  '',
  'Use field/path for precise invalid-input targeting when present. Use details for domain-specific context. Retry only when retryable=true and follow hint/recovery when supplied.',
  '',
  '## Pagination and bounded results',
  '',
  'Offset-paginated surfaces expose pagination with mode="offset", offset, limit, total, returned, hasMore, truncated and nextOffset. nextOffset is null when hasMore=false.',
  '',
  'Bounded list/search surfaces that support a limit but no continuation expose pagination with mode="bounded", limit, total, returned, hasMore, truncated and nextCursor:null. hasMore/truncated can be true even though no continuation exists; clients must not invent a cursor or sequence.',
  '',
  'Other bounded non-page responses may expose top-level truncated=true without pagination when there is no meaningful list continuation contract.',
  '',
  '## Concurrency metadata',
  '',
  'Mutating results report projectRevision and semanticRevisions in meta. Mutations executed inside an active safety transaction report transactionId. Mutations covered by semantic leases report semanticLeaseOwner plus leaseId/leaseIds. The transaction/lease control commands also mirror their own identifiers into meta. Existing tool-specific data fields remain for compatibility.',
  '',
  '## Compatibility',
  '',
  'Version 1 is additive over the pre-DX-21 shape: command/data/meta and error remain in their existing locations. New clients should require contractVersion=1; legacy clients can continue reading the existing fields.',
].join('\n');

module.exports = {
  RESPONSE_CONTRACT_VERSION,
  ERROR_CATEGORIES,
  RESPONSE_CONTRACT_GUIDE,
  inferErrorCategory,
  normalizeIssuePath,
  normalizeValidationIssue,
  makeInputValidationError,
  normalizeError,
  normalizeSuccessMeta,
  makeSuccessEnvelope,
  makeErrorEnvelope,
  readTransactionId,
  readLeaseId,
};
