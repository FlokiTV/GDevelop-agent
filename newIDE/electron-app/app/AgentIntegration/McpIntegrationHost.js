const { startMcpHttpServer } = require('./protocols/mcp/McpHttpServer');
const { createMcpActivityStore } = require('./McpActivityStore');
const { observeMcpMetrics } = require('./McpMetricsActivityObserver');
const {
  createMcpRuntimeConfig,
  publishMcpDiscovery,
  removeMcpDiscovery,
} = require('./protocols/mcp/McpDiscovery');

const createMcpIntegrationHost = ({
  app,
  rendererBridge,
  desktopCommandRegistry = null,
  log = null,
  startServer = startMcpHttpServer,
}) => {
  const runtimeConfig = createMcpRuntimeConfig(app);
  const activity = createMcpActivityStore();
  let serverInfo = null;
  let stopObservingMetrics = null;
  let startPromise = null;
  let disposed = false;

  const start = async () => {
    if (disposed) throw new Error('mcp_integration_host_disposed');
    if (serverInfo) return serverInfo;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      try {
        const startedServer = await startServer({
          rendererBridge,
          desktopCommandRegistry,
          token: runtimeConfig.token,
          host: runtimeConfig.host,
          port: runtimeConfig.port,
          log,
        });
        if (disposed) {
          await startedServer.stop();
          throw new Error('mcp_integration_host_disposed');
        }
        stopObservingMetrics = observeMcpMetrics({
          metrics: startedServer.metrics,
          activity,
        });
        const discovery = publishMcpDiscovery({
          runtimeConfig,
          serverInfo: startedServer,
        });
        serverInfo = { ...startedServer, discovery };
        activity.setServerOnline(true);
        if (log) {
          log.info(
            `[AgentIntegration:MCP] Listening on ${
              startedServer.url
            }; discovery=${runtimeConfig.discoveryPath}`
          );
        }
        return serverInfo;
      } catch (error) {
        activity.setServerOnline(false);
        removeMcpDiscovery(runtimeConfig);
        throw error;
      } finally {
        startPromise = null;
      }
    })();

    return startPromise;
  };

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    activity.setServerOnline(false);
    removeMcpDiscovery(runtimeConfig);
    const pendingStart = startPromise;
    if (pendingStart) {
      try {
        await pendingStart;
      } catch (error) {}
    }
    if (serverInfo) {
      try {
        await serverInfo.stop();
      } finally {
        serverInfo = null;
      }
    }
    removeMcpDiscovery(runtimeConfig);
  };

  return {
    start,
    dispose,
    runtimeConfig,
    activity,
    get serverInfo() {
      return serverInfo;
    },
  };
};

module.exports = { createMcpIntegrationHost };
