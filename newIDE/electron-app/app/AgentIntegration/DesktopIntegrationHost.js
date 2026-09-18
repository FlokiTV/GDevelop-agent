const { createWindowRegistry } = require('./WindowRegistry');
const { createRendererBridge } = require('./RendererBridge');
const {
  createPreviewInteractionService,
} = require('./PreviewInteractionService');
const { createWindowCaptureService } = require('./WindowCaptureService');
const { createPreviewQaService } = require('./PreviewQaService');
const {
  createMultiplayerPreviewService,
} = require('./MultiplayerPreviewService');
const {
  createPreviewNetworkDiagnosticsService,
} = require('./PreviewNetworkDiagnosticsService');
const { createDesktopCommandRegistry } = require('./DesktopCommandRegistry');
const {
  createPreviewRuntimeSnapshotIpc,
} = require('./PreviewRuntimeSnapshotIpc');

const createDesktopIntegrationHost = ({
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  isRegisteredPreviewWindow,
}) => {
  const windowRegistry = createWindowRegistry({ BrowserWindow });
  const removeWindowRegistrationHandlers = windowRegistry.installIpc(ipcMain);
  const rendererBridge = createRendererBridge({
    BrowserWindow,
    ipcMain,
    windowRegistry,
  });
  const previewInteractionService = createPreviewInteractionService({
    BrowserWindow,
    windowRegistry,
    isRegisteredPreviewWindow,
  });
  const previewRuntimeSnapshotIpc = createPreviewRuntimeSnapshotIpc({
    BrowserWindow,
    ipcMain,
    windowRegistry,
    isRegisteredPreviewWindow,
    previewInteractionService,
  });
  const windowCaptureService = createWindowCaptureService({
    BrowserWindow,
    desktopCapturer,
    windowRegistry,
    isRegisteredPreviewWindow,
  });
  const previewQaService = createPreviewQaService({
    windowCaptureService,
    previewInteractionService,
  });
  const multiplayerPreviewService = createMultiplayerPreviewService({
    BrowserWindow,
    isRegisteredPreviewWindow,
    previewInteractionService,
  });
  const previewNetworkDiagnosticsService = createPreviewNetworkDiagnosticsService(
    {
      BrowserWindow,
      isRegisteredPreviewWindow,
      multiplayerPreviewService,
    }
  );
  const desktopCommandRegistry = createDesktopCommandRegistry({
    windowCaptureService,
    previewInteractionService,
    previewQaService,
    multiplayerPreviewService,
    previewNetworkDiagnosticsService,
  });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    previewNetworkDiagnosticsService.dispose();
    previewRuntimeSnapshotIpc.dispose();
    rendererBridge.dispose();
    removeWindowRegistrationHandlers();
    windowRegistry.clear();
  };

  return {
    windowRegistry,
    rendererBridge,
    previewInteractionService,
    previewRuntimeSnapshotIpc,
    previewQaService,
    multiplayerPreviewService,
    previewNetworkDiagnosticsService,
    windowCaptureService,
    desktopCommandRegistry,
    dispose,
  };
};

module.exports = { createDesktopIntegrationHost };
