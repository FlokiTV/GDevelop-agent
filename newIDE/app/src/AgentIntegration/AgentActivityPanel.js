// @flow
import * as React from 'react';
import optionalRequire from '../Utils/OptionalRequire';
import './AgentActivityPanel.css';

const electron = optionalRequire('electron');
const ipcRenderer = electron ? electron.ipcRenderer : null;
const CHANNEL = 'gdevelop-agent-activity:snapshot';

const formatTime = (timestamp: any): string =>
  Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString() : '—';

const formatDuration = (durationMs: any): string =>
  Number.isFinite(durationMs) ? `${durationMs} ms` : 'in progress';

const getStatusLabel = (status: string, saved: boolean): string => {
  if (saved) return 'Saved';
  if (status === 'running') return 'Running';
  if (status === 'success') return 'Responded';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'attention') return 'Awaiting confirmation';
  if (status === 'interrupted') return 'Interrupted';
  return 'Error';
};

const getStatusTone = (status: string): string => {
  if (status === 'success') return 'success';
  if (status === 'running') return 'running';
  if (status === 'error' || status === 'interrupted') return 'error';
  return 'attention';
};

const ActivityIcon = (): React.Node => (
  <svg
    aria-hidden="true"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 12h4l3-7 4 14 3-7h4" />
  </svg>
);

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

  // The MCP overlay is an Electron-only inspector, not part of the web editor.
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') return null;

  const online = !!(snapshot && snapshot.serverOnline && !unavailable);
  const activeCalls = online ? snapshot.activeCalls || 0 : 0;
  const clients =
    online && Array.isArray(snapshot.clients) ? snapshot.clients : [];
  const allEvents =
    snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
  const errorCount = allEvents.filter(entry =>
    ['error', 'interrupted'].includes(entry.status)
  ).length;
  const events = errorsOnly
    ? allEvents.filter(entry => ['error', 'interrupted'].includes(entry.status))
    : allEvents;

  const statusDetail = !online
    ? 'Not responding'
    : activeCalls
    ? `${activeCalls} request(s) running`
    : clients.length
    ? 'Activity observed recently'
    : 'No recent activity';
  const indicatorClass = activeCalls
    ? 'gdmcp-dot gdmcp-dot--busy'
    : online
    ? 'gdmcp-dot gdmcp-dot--online'
    : 'gdmcp-dot';

  return (
    <div className="gdmcp-root">
      {open && (
        <section
          id="gdmcp-activity-panel"
          className="gdmcp-panel"
          role="region"
          aria-label="MCP agent activity"
        >
          <header className="gdmcp-header">
            <div className="gdmcp-header-main">
              <span className="gdmcp-logo">
                <ActivityIcon />
              </span>
              <div className="gdmcp-heading">
                <h2 className="gdmcp-title">MCP Activity</h2>
                <span className="gdmcp-subtitle">Local activity monitor</span>
              </div>
              <button
                className="gdmcp-close"
                type="button"
                onClick={() => setOpen(false)}
                title="Close panel"
                aria-label="Close MCP activity panel"
              >
                <svg
                  aria-hidden="true"
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="gdmcp-health" role="status">
              <span className={indicatorClass} aria-hidden="true" />
              <span className="gdmcp-health-label">
                {online ? 'Server available' : 'Server offline'}
              </span>
              <span className="gdmcp-health-detail">{statusDetail}</span>
            </div>
            {unavailable && (
              <div className="gdmcp-health-error">
                Unable to retrieve MCP activity.
              </div>
            )}
          </header>

          <div className="gdmcp-toolbar">
            <div className="gdmcp-section-heading">
              <span className="gdmcp-section-title">Recent activity</span>
              <span
                className="gdmcp-count"
                aria-label={`${allEvents.length} operations`}
              >
                {allEvents.length}
              </span>
            </div>
            <button
              className="gdmcp-filter"
              type="button"
              aria-label="Filter errors only"
              aria-pressed={errorsOnly}
              onClick={() => setErrorsOnly(!errorsOnly)}
            >
              <svg
                aria-hidden="true"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 7h16M7 12h10m-7 5h4" />
              </svg>
              Errors only
              {errorCount > 0 && (
                <span className="gdmcp-filter-count">{errorCount}</span>
              )}
            </button>
          </div>

          <div className="gdmcp-list">
            {events.length === 0 ? (
              <div className="gdmcp-empty">
                {errorsOnly
                  ? 'No errors in this session.'
                  : 'No activity recorded yet.'}
              </div>
            ) : (
              events.map(entry => (
                <article className="gdmcp-item" key={entry.id}>
                  <div className="gdmcp-item-top">
                    <code className="gdmcp-command">{entry.command}</code>
                    <span
                      className={`gdmcp-result gdmcp-result--${getStatusTone(
                        entry.status
                      )}`}
                    >
                      {getStatusLabel(entry.status, entry.saved)}
                    </span>
                  </div>
                  <div className="gdmcp-meta">
                    <span>{entry.agentId}</span>
                    <span className="gdmcp-meta-separator" aria-hidden="true">
                      ·
                    </span>
                    <span>{formatTime(entry.startedAt)}</span>
                    <span className="gdmcp-meta-separator" aria-hidden="true">
                      ·
                    </span>
                    <span>{formatDuration(entry.durationMs)}</span>
                    {entry.modifiesProject && <span>· modifies project</span>}
                    {entry.errorCode && <span>· {entry.errorCode}</span>}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      )}
      <button
        className="gdmcp-launcher"
        type="button"
        onClick={() => setOpen(!open)}
        title="Show recent MCP operations"
        aria-label={
          open ? 'Hide MCP activity panel' : 'Open MCP activity panel'
        }
        aria-expanded={open}
        aria-controls="gdmcp-activity-panel"
      >
        <span className={indicatorClass} aria-hidden="true" />
        <span>MCP</span>
        <span className="gdmcp-launcher-divider" aria-hidden="true" />
        <span className="gdmcp-launcher-status">
          {activeCalls
            ? `${activeCalls} running`
            : online
            ? 'Online'
            : 'Offline'}
        </span>
        <svg
          className="gdmcp-chevron"
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m7 14 5-5 5 5" />
        </svg>
      </button>
    </div>
  );
}
