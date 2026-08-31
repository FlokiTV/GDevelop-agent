const path = require('path');

const REGISTER_CHANNEL = 'gdevelop-agent-integration:register';
const LEGACY_REGISTER_CHANNEL = 'gdevelop-agent-api:register';

const normalizeFileIdentifier = fileIdentifier => {
  if (!fileIdentifier || typeof fileIdentifier !== 'string') return null;
  try {
    const resolved = path.resolve(fileIdentifier);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch (error) {
    return null;
  }
};

const createWindowRegistry = ({ BrowserWindow }) => {
  const windowProjects = new Map();
  let installedIpc = null;

  const prune = () => {
    for (const windowId of windowProjects.keys()) {
      const window = BrowserWindow.fromId(windowId);
      if (!window || window.isDestroyed()) windowProjects.delete(windowId);
    }
  };

  const register = (window, fileIdentifier) => {
    if (!window || window.isDestroyed()) return false;
    windowProjects.set(window.id, normalizeFileIdentifier(fileIdentifier));
    return true;
  };

  const unregister = windowId => windowProjects.delete(Number(windowId));

  const isRegistered = windowId => windowProjects.has(Number(windowId));

  const getProjectPath = windowId =>
    windowProjects.has(Number(windowId))
      ? windowProjects.get(Number(windowId))
      : null;

  const listRegistered = () => {
    prune();
    return Array.from(windowProjects.entries()).map(([windowId, projectPath]) => ({
      windowId,
      projectPath,
    }));
  };

  const select = ({ projectPath, windowId } = {}) => {
    prune();

    if (windowId != null && windowId !== '') {
      const numericWindowId = Number(windowId);
      const window = BrowserWindow.fromId(numericWindowId);
      if (window && !window.isDestroyed() && windowProjects.has(window.id)) {
        return window;
      }
      return null;
    }

    const normalizedProjectPath = normalizeFileIdentifier(projectPath);
    if (normalizedProjectPath) {
      for (const [registeredWindowId, registeredProjectPath] of windowProjects) {
        if (registeredProjectPath !== normalizedProjectPath) continue;
        const window = BrowserWindow.fromId(registeredWindowId);
        if (window && !window.isDestroyed()) return window;
      }
      return null;
    }

    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (
      focusedWindow &&
      !focusedWindow.isDestroyed() &&
      windowProjects.has(focusedWindow.id)
    ) {
      return focusedWindow;
    }

    const availableWindows = Array.from(windowProjects.keys())
      .map(registeredWindowId => BrowserWindow.fromId(registeredWindowId))
      .filter(window => window && !window.isDestroyed());
    return availableWindows.length === 1 ? availableWindows[0] : null;
  };

  const installIpc = ipcMain => {
    if (installedIpc) return installedIpc.cleanup;
    const onRegister = (event, payload = {}) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return;
      if (payload.active === false) {
        unregister(window.id);
        return;
      }
      register(window, payload.fileIdentifier);
    };
    ipcMain.on(REGISTER_CHANNEL, onRegister);
    // Transitional compatibility while the old REST adapter still exists.
    ipcMain.on(LEGACY_REGISTER_CHANNEL, onRegister);
    const cleanup = () => {
      if (!installedIpc) return;
      ipcMain.removeListener(REGISTER_CHANNEL, onRegister);
      ipcMain.removeListener(LEGACY_REGISTER_CHANNEL, onRegister);
      installedIpc = null;
    };
    installedIpc = { ipcMain, onRegister, cleanup };
    return cleanup;
  };

  const clear = () => windowProjects.clear();

  return {
    register,
    unregister,
    isRegistered,
    getProjectPath,
    listRegistered,
    select,
    prune,
    installIpc,
    clear,
    get size() {
      prune();
      return windowProjects.size;
    },
  };
};

module.exports = {
  REGISTER_CHANNEL,
  LEGACY_REGISTER_CHANNEL,
  normalizeFileIdentifier,
  createWindowRegistry,
};
