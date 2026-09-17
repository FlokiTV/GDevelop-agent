const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  redactUrl,
  redactHeaders,
  createPreviewNetworkDiagnosticsService,
} = require('./PreviewNetworkDiagnosticsService');

class FakeDebugger extends EventEmitter {
  constructor() {
    super();
    this.attached = false;
    this.commands = [];
  }
  attach() {
    this.attached = true;
  }
  detach() {
    this.attached = false;
  }
  isAttached() {
    return this.attached;
  }
  async sendCommand(command) {
    this.commands.push(command);
  }
}

const makeService = () => {
  const debuggerApi = new FakeDebugger();
  const window = {
    id: 2,
    isDestroyed: () => false,
    webContents: { debugger: debuggerApi },
  };
  const service = createPreviewNetworkDiagnosticsService({
    BrowserWindow: { fromId: id => (id === 2 ? window : null) },
    isRegisteredPreviewWindow: id => id === 2,
    multiplayerPreviewService: {
      resolveAlias: alias => {
        if (alias !== 'host') throw new Error('preview_alias_not_found');
        return { alias: 'host', previewWindowId: 2 };
      },
    },
  });
  return { service, debuggerApi };
};

test('redacts credentials from URLs and headers', () => {
  assert.equal(
    redactUrl('https://user:pass@example.com/a?token=secret&safe=yes'),
    'https://%5BREDACTED%5D:%5BREDACTED%5D@example.com/a?token=%5BREDACTED%5D&safe=yes'
  );
  assert.deepEqual(
    redactHeaders({ Authorization: 'Bearer secret', Accept: 'json' }),
    {
      Authorization: '[REDACTED]',
      Accept: 'json',
    }
  );
});

test('captures bounded HTTP and WebSocket metadata without bodies or frames', async () => {
  const { service, debuggerApi } = makeService();
  const capabilities = service.capabilities();
  assert.equal(capabilities.supported, true);
  assert.equal(capabilities.responseBodies, false);
  assert.equal(capabilities.networkShaping.supported, false);

  await service.start({ alias: 'host', maxEvents: 3 });
  assert.deepEqual(debuggerApi.commands, ['Network.enable']);
  debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
    requestId: '1',
    request: {
      method: 'GET',
      url: 'https://example.com/a?api_key=secret',
      headers: { Cookie: 'private' },
    },
  });
  debuggerApi.emit('message', {}, 'Network.responseReceived', {
    requestId: '1',
    response: {
      url: 'https://example.com/a',
      status: 200,
      mimeType: 'application/json',
      protocol: 'h2',
      headers: {},
    },
  });
  debuggerApi.emit('message', {}, 'Network.webSocketCreated', {
    requestId: 'ws1',
    url: 'wss://example.com/socket?token=secret',
  });
  debuggerApi.emit('message', {}, 'Network.webSocketClosed', {
    requestId: 'ws1',
  });

  const read = service.read({ alias: 'host', limit: 10 });
  assert.equal(read.events.length, 3);
  assert.equal(read.droppedEvents, 1);
  assert.equal(read.events[1].url.includes('secret'), false);
  assert.equal(
    read.events.some(event => Object.hasOwn(event, 'payloadData')),
    false
  );

  const stopped = service.stop({ alias: 'host' });
  assert.equal(stopped.active, false);
  assert.equal(debuggerApi.isAttached(), false);
});

test('rejects debugger conflicts instead of hijacking another debugger client', async () => {
  const { service, debuggerApi } = makeService();
  debuggerApi.attach();
  await assert.rejects(
    service.start({ alias: 'host' }),
    /network_debugger_in_use/
  );
});
