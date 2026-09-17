const { createWindowRegistry } = require('./WindowRegistry');
const { createRendererBridge } = require('./RendererBridge');
const {
  createPreviewInteractionService,
} = require('./PreviewInteractionService');
const { createWindowCaptureService } = require('./WindowCaptureService');
const { createPreviewQaService } = require('./PreviewQaService');
const { createDesktopCommandRegistry } = require('./DesktopCommandRegistry');

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
  const desktopCommandRegistry = createDesktopCommandRegistry({
    windowCaptureService,
    previewInteractionService,
    previewQaService,
  });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    rendererBridge.dispose();
    removeWindowRegistrationHandlers();
    windowRegistry.clear();
  };

  return {
    windowRegistry,
    rendererBridge,
    previewInteractionService,
    previewQaService,
    windowCaptureService,
    desktopCommandRegistry,
    dispose,
  };
};

module.exports = { createDesktopIntegrationHost };
