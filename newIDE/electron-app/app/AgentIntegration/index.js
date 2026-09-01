const { createDesktopIntegrationHost } = require('./DesktopIntegrationHost');
const { createMcpIntegrationHost } = require('./McpIntegrationHost');

let desktopIntegrationHost = null;
let mcpIntegrationHost = null;
let startPromise = null;

const logLifecycleError = (log, message, error) => {
  if (log && typeof log.error === 'function') {
    log.error(message, error);
  }
};

const startAgentIntegration = dependencies => {
  if (desktopIntegrationHost && mcpIntegrationHost && mcpIntegrationHost.serverInfo) {
    return Promise.resolve(desktopIntegrationHost);
  }
  if (startPromise) return startPromise;

  const {
    app,
    ipcMain,
    BrowserWindow,
    desktopCapturer,
    isRegisteredPreviewWindow,
    log,
  } = dependencies;

  desktopIntegrationHost = createDesktopIntegrationHost({
    BrowserWindow,
    ipcMain,
    desktopCapturer,
    isRegisteredPreviewWindow,
  });
  mcpIntegrationHost = createMcpIntegrationHost({
    app,
    rendererBridge: desktopIntegrationHost.rendererBridge,
    log,
  });

  startPromise = mcpIntegrationHost
    .start()
    .then(() => desktopIntegrationHost)
    .catch(async error => {
      const failedMcpHost = mcpIntegrationHost;
      const failedDesktopHost = desktopIntegrationHost;
      mcpIntegrationHost = null;
      desktopIntegrationHost = null;
      if (failedMcpHost) {
        try {
          await failedMcpHost.dispose();
        } catch (disposeError) {
          logLifecycleError(
            log,
            '[AgentIntegration] Failed to clean MCP host after startup error:',
            disposeError
          );
        }
      }
      if (failedDesktopHost) failedDesktopHost.dispose();
      throw error;
    })
    .finally(() => {
      startPromise = null;
    });

  return startPromise;
};

const stopAgentIntegration = async () => {
  const pendingStart = startPromise;
  if (pendingStart) {
    try {
      await pendingStart;
    } catch (error) {}
  }

  const currentMcpHost = mcpIntegrationHost;
  const currentDesktopHost = desktopIntegrationHost;
  mcpIntegrationHost = null;
  desktopIntegrationHost = null;
  startPromise = null;

  if (currentMcpHost) await currentMcpHost.dispose();
  if (currentDesktopHost) currentDesktopHost.dispose();
};

const installAgentIntegration = dependencies => {
  const { app, log } = dependencies;
  let disposed = false;

  const start = () => {
    if (disposed) return;
    startAgentIntegration(dependencies).catch(error => {
      logLifecycleError(
        log,
        '[AgentIntegration] MCP startup failed:',
        error
      );
    });
  };
  const stop = () => {
    stopAgentIntegration().catch(error => {
      logLifecycleError(
        log,
        '[AgentIntegration] MCP shutdown failed:',
        error
      );
    });
  };

  if (app.isReady()) start();
  else app.once('ready', start);
  app.once('before-quit', stop);

  return () => {
    if (disposed) return Promise.resolve();
    disposed = true;
    app.removeListener('ready', start);
    app.removeListener('before-quit', stop);
    return stopAgentIntegration();
  };
};

module.exports = {
  installAgentIntegration,
  startAgentIntegration,
  stopAgentIntegration,
};
