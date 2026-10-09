// A bounded, privacy-preserving activity feed for the *local* GDevelop MCP host.
// No command inputs, output payloads, project paths or authentication data are stored.
const DEFAULT_HISTORY_LIMIT = 100;
const RECENT_AGENT_MS = 90000;
const safeIdentifier = value =>
  typeof value === 'string' && /^[a-zA-Z0-9._:@-]{1,160}$/.test(value)
    ? value
    : null;

const safeCommand = value =>
  typeof value === 'string' && /^[a-zA-Z0-9._-]{1,160}$/.test(value)
    ? value
    : 'unknown';

const safeErrorCode = value =>
  typeof value === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(value)
    ? value
    : 'unknown_error';

const createMcpActivityStore = ({
  now = Date.now,
  historyLimit = DEFAULT_HISTORY_LIMIT,
  recentAgentMs = RECENT_AGENT_MS,
} = {}) => {
  const entries = [];
  const clients = new Map();
  let nextId = 1;
  let serverOnline = false;
  const limit = Math.max(1, Math.min(500, historyLimit));

  const setServerOnline = value => {
    serverOnline = !!value;
    if (!serverOnline) {
      entries.forEach(entry => {
        if (entry.status === 'running') {
          entry.status = 'interrupted';
          entry.endedAt = now();
        }
      });
    }
  };

  const start = ({ command, identity, traceId, modifiesProject = false }) => {
    const startedAt = now();
    const agentId = safeIdentifier(identity && identity.agentId) || 'anonymous';
    const clientId =
      safeIdentifier(identity && identity.clientId) || 'anonymous';
    const key = agentId + '::' + clientId;
    clients.set(key, { agentId, clientId, lastSeenAt: startedAt });
    const id = nextId++;
    entries.unshift({
      id,
      command: safeCommand(command),
      agentId,
      clientId,
      traceId: safeIdentifier(traceId),
      modifiesProject: !!modifiesProject,
      startedAt,
      endedAt: null,
      durationMs: null,
      status: 'running',
      errorCode: null,
      saved: false,
    });
    if (entries.length > limit) entries.length = limit;
    return id;
  };

  const finish = (
    id,
    { status = 'success', errorCode, saved = false, durationMs } = {}
  ) => {
    const entry = entries.find(row => row.id === id);
    if (!entry || entry.status !== 'running') return;
    entry.endedAt = now();
    entry.durationMs = Number.isFinite(durationMs)
      ? Math.max(0, durationMs)
      : Math.max(0, entry.endedAt - entry.startedAt);
    entry.startedAt = entry.endedAt - entry.durationMs;
    entry.status = ['success', 'error', 'cancelled', 'attention'].includes(
      status
    )
      ? status
      : 'error';
    entry.errorCode =
      entry.status === 'error' ? safeErrorCode(errorCode) : null;
    entry.saved =
      entry.command === 'project.save' &&
      entry.status === 'success' &&
      saved === true;
  };

  const snapshot = () => {
    const observedAt = now();
    const recent = Array.from(clients.values())
      .filter(
        entry => serverOnline && observedAt - entry.lastSeenAt <= recentAgentMs
      )
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, 20);
    return {
      serverOnline,
      observedAt,
      recentAgentMs,
      activeCalls: serverOnline
        ? entries.filter(entry => entry.status === 'running').length
        : 0,
      clients: recent,
      entries: entries.map(entry => ({ ...entry })),
    };
  };

  return { setServerOnline, start, finish, snapshot };
};

module.exports = { createMcpActivityStore, RECENT_AGENT_MS };
