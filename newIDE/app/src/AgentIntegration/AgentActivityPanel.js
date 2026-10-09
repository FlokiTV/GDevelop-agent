// @flow
import * as React from 'react';
import optionalRequire from '../Utils/OptionalRequire';

const electron = optionalRequire('electron');
const ipcRenderer = electron ? electron.ipcRenderer : null;
const CHANNEL = 'gdevelop-agent-activity:snapshot';

const containerStyle = {
  position: 'fixed',
  right: 18,
  bottom: 18,
  zIndex: 1400,
  fontFamily: 'system-ui, sans-serif',
  fontSize: 12,
  color: '#e9edf5',
};

const panelStyle = {
  width: 380,
  maxWidth: 'calc(100vw - 36px)',
  maxHeight: 'min(480px, 75vh)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  marginBottom: 8,
  borderRadius: 10,
  background: '#1d2430',
  border: '1px solid #424d5c',
  boxShadow: '0 8px 28px rgba(0,0,0,.45)',
};

const smallButtonStyle = {
  cursor: 'pointer',
  borderRadius: 6,
  border: '1px solid #59697c',
  padding: '5px 9px',
  color: '#f5f7fc',
  background: '#293646',
};

const formatTime = (timestamp: any): string => {
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleTimeString();
};

const formatDuration = (durationMs: any): string =>
  Number.isFinite(durationMs) ? `${durationMs} ms` : 'in progress';

const getStatusColor = (status: string): string => {
  if (status === 'running') return '#79b5ff';
  if (status === 'success') return '#7bd8a4';
  if (status === 'attention' || status === 'cancelled') return '#e8bc69';
  return '#fc9393';
};

const getStatusLabel = (status: string, saved: boolean): string => {
  if (saved) return 'Saved';
  if (status === 'running') return 'Running';
  if (status === 'success') return 'Responded';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'attention') return 'Awaiting confirmation';
  if (status === 'interrupted') return 'Interrupted';
  return 'Error';
};

export default function AgentActivityPanel(): React.Node {
  const [open, setOpen] = React.useState(false);
  const [errorsOnly, setErrorsOnly] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState<any>(null);
  const [unavailable, setUnavailable] = React.useState(false);

  React.useEffect(() => {
    if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') return;
    let mounted = true;
    const refresh = () =>
      ipcRenderer
        .invoke(CHANNEL)
        .then(data => {
          if (!mounted) return;
          setSnapshot(data);
          setUnavailable(false);
        })
        .catch(() => {
          if (mounted) {
            setUnavailable(true);
            setSnapshot(null);
          }
        });
    refresh();
    const interval = window.setInterval(refresh, 1500);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  // No UI in web builds or detached browser/preview surfaces.
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') return null;

  const online = !!(snapshot && snapshot.serverOnline && !unavailable);
  const activeCalls = online ? snapshot.activeCalls || 0 : 0;
  const clients =
    online && Array.isArray(snapshot.clients) ? snapshot.clients : [];
  const events =
    snapshot && Array.isArray(snapshot.entries)
      ? snapshot.entries.filter(
          entry =>
            !errorsOnly || ['error', 'interrupted'].includes(entry.status)
        )
      : [];
  const dotColor = online ? (activeCalls ? '#80b5ff' : '#65cea2') : '#a7aebb';
  const statusText = !online
    ? 'MCP server unavailable'
    : activeCalls
    ? `${activeCalls} MCP request(s) running`
    : clients.length
    ? `MCP online · ${clients.length} recent client(s)`
    : 'MCP available · no recent activity';

  return (
    <div style={containerStyle}>
      {open && (
        <div style={panelStyle} role="region" aria-label="MCP agent activity">
          <div
            style={{ padding: '13px 14px', borderBottom: '1px solid #424d5c' }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <strong style={{ fontSize: 14 }}>Agents / MCP Activity</strong>
              <button
                type="button"
                style={smallButtonStyle}
                onClick={() => setOpen(false)}
                aria-label="Close MCP activity panel"
              >
                Close
              </button>
            </div>
            <div style={{ marginTop: 10 }}>
              <span
                aria-hidden="true"
                style={{ color: dotColor, marginRight: 7 }}
              >
                ●
              </span>
              {statusText}
            </div>
            {unavailable && (
              <div style={{ color: '#fc9393', marginTop: 6 }}>
                Unable to retrieve MCP activity.
              </div>
            )}
            {clients.length > 0 && (
              <div style={{ marginTop: 8, color: '#b6c2d1' }}>
                {clients.map(client => (
                  <div key={`${client.agentId}:${client.clientId}`}>
                    {client.agentId} · last seen at{' '}
                    {formatTime(client.lastSeenAt)}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div
            style={{
              padding: '9px 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid #424d5c',
            }}
          >
            <strong>Recent operations ({events.length})</strong>
            <label style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={errorsOnly}
                onChange={event => setErrorsOnly(event.target.checked)}
                style={{ verticalAlign: 'middle', marginRight: 5 }}
              />
              Errors only
            </label>
          </div>
          <div style={{ overflowY: 'auto', minHeight: 100, maxHeight: 315 }}>
            {events.length === 0 ? (
              <div style={{ padding: 16, color: '#b6c2d1' }}>
                No operations recorded in this session.
              </div>
            ) : (
              events.map(entry => (
                <div
                  key={entry.id}
                  style={{
                    padding: '10px 14px',
                    borderBottom: '1px solid #333d4b',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 6,
                    }}
                  >
                    <strong style={{ overflowWrap: 'anywhere' }}>
                      {entry.command}
                    </strong>
                    <span
                      style={{
                        color: getStatusColor(entry.status),
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {getStatusLabel(entry.status, entry.saved)}
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: 5,
                      color: '#b6c2d1',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {entry.agentId} · {formatTime(entry.startedAt)} ·{' '}
                    {formatDuration(entry.durationMs)}
                    {entry.modifiesProject ? ' · modifies project' : ''}
                    {entry.errorCode ? ` · ${entry.errorCode}` : ''}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        style={{
          ...smallButtonStyle,
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '8px 12px',
          marginLeft: 'auto',
          boxShadow: '0 4px 12px rgba(0,0,0,.28)',
        }}
        onClick={() => setOpen(!open)}
        title="Show recent MCP connections and operations"
        aria-expanded={open}
        aria-label="Open MCP activity panel"
      >
        <span aria-hidden="true" style={{ color: dotColor }}>
          ●
        </span>
        MCP{' '}
        {activeCalls
          ? `· ${activeCalls} running`
          : online
          ? '· online'
          : '· offline'}
      </button>
    </div>
  );
}
