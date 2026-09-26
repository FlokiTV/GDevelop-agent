const { createWindowRegistry } = require('./WindowRegistry');
const { createRendererBridge } = require('./RendererBridge');
const {
  createPreviewInteractionService,
} = require('./PreviewInteractionService');
const { createWindowCaptureService } = require('./WindowCaptureService');
const {
  createManagedTempWorkspaceService,
} = require('./ManagedTempWorkspaceService');
const { createPreviewQaService } = require('./PreviewQaService');
const { createPreviewViewportService } = require('./PreviewViewportService');
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
const { createPreviewLifecycleIpc } = require('./PreviewLifecycleIpc');

const createDesktopIntegrationHost = ({
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  isRegisteredPreviewWindow,
  getPreviewWindowParentId,
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
  const previewLifecycleIpc = createPreviewLifecycleIpc({
    BrowserWindow,
    ipcMain,
    windowRegistry,
    isRegisteredPreviewWindow,
    getPreviewWindowParentId,
    previewInteractionService,
  });
  const windowCaptureService = createWindowCaptureService({
    BrowserWindow,
    desktopCapturer,
    windowRegistry,
    isRegisteredPreviewWindow,
    getPreviewWindowParentId,
  });
  const managedTempWorkspaceService = createManagedTempWorkspaceService();
  const previewViewportService = createPreviewViewportService({
    BrowserWindow,
    windowRegistry,
    isRegisteredPreviewWindow,
  });
  const previewQaService = createPreviewQaService({
    windowCaptureService,
    previewInteractionService,
    previewViewportService,
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
    managedTempWorkspaceService,
    previewInteractionService,
    previewViewportService,
    previewQaService,
    multiplayerPreviewService,
    previewNetworkDiagnosticsService,
  });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    previewNetworkDiagnosticsService.dispose();
    managedTempWorkspaceService.dispose();
    previewLifecycleIpc.dispose();
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
    previewLifecycleIpc,
    previewQaService,
    previewViewportService,
    multiplayerPreviewService,
    previewNetworkDiagnosticsService,
    windowCaptureService,
    managedTempWorkspaceService,
    desktopCommandRegistry,
    dispose,
  };
};

module.exports = { createDesktopIntegrationHost };
