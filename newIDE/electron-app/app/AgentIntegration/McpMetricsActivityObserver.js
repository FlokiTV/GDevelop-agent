// Subscribe to the existing MCP metrics without changing the tool dispatcher.
// Only completed command name, outcome and latency are exposed; client identities
// and active/in-flight requests are not available in the current metrics contract.
const observeMcpMetrics = ({ metrics, activity }) => {
  if (!metrics || typeof metrics.record !== 'function' || !activity) {
    return () => {};
  }
  const originalRecord = metrics.record;
  metrics.record = entry => {
    // Preserve the original metrics semantics and allow exceptions to propagate.
    const result = originalRecord(entry);
    try {
      const id = activity.start({
        command: entry && entry.command,
        identity: { agentId: 'mcp-client', clientId: 'unidentified' },
      });
      activity.finish(id, {
        status: entry && entry.ok ? 'success' : 'error',
        errorCode: entry && entry.ok ? null : 'mcp_command_failed',
        durationMs: entry && entry.durationMs,
      });
    } catch (error) {
      // Observability must not affect MCP command execution.
    }
    return result;
  };
  return () => {
    if (metrics.record !== originalRecord) metrics.record = originalRecord;
  };
};

module.exports = { observeMcpMetrics };
