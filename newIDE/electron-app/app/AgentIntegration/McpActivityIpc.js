const CHANNEL = 'gdevelop-agent-activity:snapshot';

const emptySnapshot = () => ({
  serverOnline: false,
  observedAt: Date.now(),
  recentAgentMs: 90000,
  activeCalls: 0,
  clients: [],
  entries: [],
});

// Only a fixed, sanitized read-only snapshot crosses from Electron to renderer.
const registerMcpActivityIpc = ({ ipcMain, getSnapshot }) => {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return () => {};
  ipcMain.handle(CHANNEL, () => {
    try {
      return (
        (typeof getSnapshot === 'function' && getSnapshot()) || emptySnapshot()
      );
    } catch (error) {
      return emptySnapshot();
    }
  });
  return () => {
    if (typeof ipcMain.removeHandler === 'function') {
      ipcMain.removeHandler(CHANNEL);
    }
  };
};

module.exports = { CHANNEL, registerMcpActivityIpc };
