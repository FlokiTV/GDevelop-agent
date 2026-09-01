const { startMcpHttpServer } = require('./protocols/mcp/McpHttpServer');
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
  let serverInfo = null;
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
        const discovery = publishMcpDiscovery({
          runtimeConfig,
          serverInfo: startedServer,
        });
        serverInfo = { ...startedServer, discovery };
        if (log) {
          log.info(
            `[AgentIntegration:MCP] Listening on ${startedServer.url}; discovery=${runtimeConfig.discoveryPath}`
          );
        }
        return serverInfo;
      } catch (error) {
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
    get serverInfo() {
      return serverInfo;
    },
  };
};

module.exports = { createMcpIntegrationHost };
