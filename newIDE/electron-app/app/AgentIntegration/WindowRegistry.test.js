const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
  REGISTER_CHANNEL,
  LEGACY_REGISTER_CHANNEL,
  createWindowRegistry,
  normalizeFileIdentifier,
} = require('./WindowRegistry');

const makeWindowFixture = () => {
  const windows = new Map();
  let focusedWindow = null;
  const BrowserWindow = {
    fromId: id => windows.get(Number(id)) || null,
    fromWebContents: sender =>
      Array.from(windows.values()).find(window => window.webContents === sender) ||
      null,
    getFocusedWindow: () => focusedWindow,
  };
  const addWindow = (id, { destroyed = false } = {}) => {
    const window = {
      id,
      webContents: {},
      isDestroyed: () => destroyed,
    };
    windows.set(id, window);
    return window;
  };
  return {
    BrowserWindow,
    addWindow,
    setFocused: window => {
      focusedWindow = window;
    },
    removeWindow: id => windows.delete(id),
  };
};

test('normalizes project paths and selects by explicit project/window targeting', () => {
  const fixture = makeWindowFixture();
  const first = fixture.addWindow(1);
  const second = fixture.addWindow(2);
  const registry = createWindowRegistry({ BrowserWindow: fixture.BrowserWindow });
  registry.register(first, 'C:/Games/Foo/game.json');
  registry.register(second, 'C:/Games/Bar/game.json');

  assert.equal(registry.select({ windowId: 2 }), second);
  assert.equal(
    registry.select({ projectPath: 'C:/Games/Foo/game.json' }),
    first
  );
  assert.equal(registry.select({ projectPath: 'C:/missing.json' }), null);
  assert.equal(typeof normalizeFileIdentifier('C:/Games/Foo/game.json'), 'string');
});

test('uses focused registered window, otherwise requires an unambiguous target', () => {
  const fixture = makeWindowFixture();
  const first = fixture.addWindow(1);
  const second = fixture.addWindow(2);
  const registry = createWindowRegistry({ BrowserWindow: fixture.BrowserWindow });
  registry.register(first, null);
  registry.register(second, null);
  assert.equal(registry.select(), null);
  fixture.setFocused(second);
  assert.equal(registry.select(), second);
  registry.unregister(2);
  fixture.setFocused(null);
  assert.equal(registry.select(), first);
});

test('prunes destroyed or missing windows', () => {
  const fixture = makeWindowFixture();
  const first = fixture.addWindow(1);
  const second = fixture.addWindow(2);
  const registry = createWindowRegistry({ BrowserWindow: fixture.BrowserWindow });
  registry.register(first, null);
  registry.register(second, null);
  fixture.removeWindow(2);
  registry.prune();
  assert.deepEqual(registry.listRegistered(), [{ windowId: 1, projectPath: null }]);
});

test('installs new and legacy registration channels and cleans both up', () => {
  const fixture = makeWindowFixture();
  const window = fixture.addWindow(1);
  const ipcMain = new EventEmitter();
  const registry = createWindowRegistry({ BrowserWindow: fixture.BrowserWindow });
  const cleanup = registry.installIpc(ipcMain);

  ipcMain.emit(REGISTER_CHANNEL, { sender: window.webContents }, {
    active: true,
    fileIdentifier: 'C:/game.json',
  });
  assert.equal(registry.isRegistered(1), true);
  ipcMain.emit(LEGACY_REGISTER_CHANNEL, { sender: window.webContents }, {
    active: false,
  });
  assert.equal(registry.isRegistered(1), false);

  cleanup();
  assert.equal(ipcMain.listenerCount(REGISTER_CHANNEL), 0);
  assert.equal(ipcMain.listenerCount(LEGACY_REGISTER_CHANNEL), 0);
});
