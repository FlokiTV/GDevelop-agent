const { createDesktopIntegrationHost } = require('./DesktopIntegrationHost');
const { startAgentApi, stopAgentApi } = require('../AgentApi');

let desktopIntegrationHost = null;
let installed = false;

const startAgentIntegration = dependencies => {
  if (installed) return desktopIntegrationHost;
  installed = true;
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

  // Transitional transport only. MCP will replace this call once the first
  // end-to-end protocol smoke is green. Desktop services are already owned by
  // AgentIntegration and are injected into the legacy adapter.
  startAgentApi({
    app,
    BrowserWindow,
    log,
    desktopIntegrationHost,
  });
  return desktopIntegrationHost;
};

const stopAgentIntegration = () => {
  stopAgentApi();
  if (desktopIntegrationHost) desktopIntegrationHost.dispose();
  desktopIntegrationHost = null;
  installed = false;
};

const installAgentIntegration = dependencies => {
  const { app } = dependencies;
  const start = () => startAgentIntegration(dependencies);
  const stop = () => stopAgentIntegration();

  if (app.isReady()) start();
  else app.once('ready', start);
  app.once('before-quit', stop);

  return () => {
    app.removeListener('ready', start);
    app.removeListener('before-quit', stop);
    stop();
  };
};

module.exports = {
  installAgentIntegration,
  startAgentIntegration,
  stopAgentIntegration,
};
