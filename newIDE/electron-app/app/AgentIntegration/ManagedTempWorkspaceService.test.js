const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createManagedTempWorkspaceService,
} = require('./ManagedTempWorkspaceService');

const makeIdentity = (agentId, sessionId, taskId) => ({
  clientId: `${agentId}-client`,
  agentId,
  sessionId,
  ...(taskId ? { taskId } : {}),
  ownerKey: `${agentId}::${sessionId}`,
});

test('creates owner/task scoped namespaces and rejects cross-agent access', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx19-temp-service-'));
  const service = createManagedTempWorkspaceService({ rootDir });
  const a = { identity: makeIdentity('agent-a', 'session-a', 'task-a') };
  const b = { identity: makeIdentity('agent-b', 'session-b', 'task-b') };
  try {
    const created = service.create({ purpose: 'helper script' }, a);
    assert.equal(created.namespace.taskId, 'task-a');
    assert.equal(created.namespace.ownerKey, 'agent-a::session-a');

    const written = service.write(
      {
        namespaceId: created.namespace.namespaceId,
        relativePath: 'scripts/helper.js',
        content: 'console.log("a");',
      },
      a
    );
    assert.ok(fs.existsSync(written.absolutePath));

    assert.throws(
      () =>
        service.read(
          {
            namespaceId: created.namespace.namespaceId,
            relativePath: 'scripts/helper.js',
          },
          b
        ),
      error => error && error.code === 'managed_temp_namespace_owner_mismatch'
    );
    assert.throws(
      () =>
        service.write(
          {
            namespaceId: created.namespace.namespaceId,
            relativePath: 'scripts/helper.js',
            content: 'console.log("b");',
          },
          b
        ),
      error => error && error.code === 'managed_temp_namespace_owner_mismatch'
    );
  } finally {
    service.dispose();
  }
});

test('requires explicit overwrite even for the owning agent', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx19-temp-service-'));
  const service = createManagedTempWorkspaceService({ rootDir });
  const owner = { identity: makeIdentity('agent-a', 'session-a', 'task-a') };
  try {
    const { namespace } = service.create({}, owner);
    service.write(
      {
        namespaceId: namespace.namespaceId,
        relativePath: 'helper.txt',
        content: 'first',
      },
      owner
    );
    assert.throws(
      () =>
        service.write(
          {
            namespaceId: namespace.namespaceId,
            relativePath: 'helper.txt',
            content: 'second',
          },
          owner
        ),
      error => error && error.code === 'managed_temp_artifact_exists'
    );
    service.write(
      {
        namespaceId: namespace.namespaceId,
        relativePath: 'helper.txt',
        content: 'second',
        overwrite: true,
      },
      owner
    );
    assert.equal(
      service.read(
        {
          namespaceId: namespace.namespaceId,
          relativePath: 'helper.txt',
        },
        owner
      ).content,
      'second'
    );
  } finally {
    service.dispose();
  }
});

test('rejects traversal and cleans namespaces deterministically on ttl/release/dispose', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx19-temp-service-'));
  let currentTime = 1000;
  let sequence = 0;
  const service = createManagedTempWorkspaceService({
    rootDir,
    now: () => currentTime,
    makeNamespaceId: () => `ns-test-${++sequence}`,
  });
  const owner = { identity: makeIdentity('agent-a', 'session-a', 'task-a') };
  try {
    const first = service.create({ ttlMs: 1000 }, owner).namespace;
    assert.throws(
      () =>
        service.write(
          {
            namespaceId: first.namespaceId,
            relativePath: '../escape.js',
            content: 'bad',
          },
          owner
        ),
      error => error && error.code === 'managed_temp_path_escape_rejected'
    );

    service.heartbeat({ namespaceId: first.namespaceId, ttlMs: 2000 }, owner);
    currentTime = 2500;
    assert.equal(service.cleanupExpired().length, 0);
    currentTime = 3501;
    const expired = service.cleanupExpired();
    assert.equal(expired.length, 1);
    assert.equal(expired[0].reason, 'ttl-expired');
    assert.equal(fs.existsSync(first.rootPath), false);

    const second = service.create({}, owner).namespace;
    assert.equal(
      service.release({ namespaceId: second.namespaceId }, owner).reason,
      'explicit-release'
    );
    assert.equal(fs.existsSync(second.rootPath), false);

    const third = service.create({}, owner).namespace;
    assert.equal(fs.existsSync(third.rootPath), true);
    service.dispose();
    assert.equal(fs.existsSync(third.rootPath), false);
    assert.equal(fs.existsSync(rootDir), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
