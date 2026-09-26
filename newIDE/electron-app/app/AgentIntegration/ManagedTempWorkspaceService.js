const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TTL_MS = 60000;
const MIN_TTL_MS = 1000;
const MAX_TTL_MS = 300000;
const MAX_NAMESPACES = 128;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LIST_ENTRIES = 512;

const makeError = (code, details) => {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const normalizeTtl = value => {
  if (value == null) return DEFAULT_TTL_MS;
  const ttlMs = Number(value);
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw makeError('invalid_managed_temp_ttl', {
      value,
      minimum: MIN_TTL_MS,
      maximum: MAX_TTL_MS,
    });
  }
  return ttlMs;
};

const getIdentity = requestContext => {
  const identity =
    requestContext &&
    requestContext.identity &&
    typeof requestContext.identity === 'object'
      ? requestContext.identity
      : null;
  if (
    !identity ||
    typeof identity.ownerKey !== 'string' ||
    !identity.ownerKey
  ) {
    throw makeError('managed_temp_identity_required');
  }
  return identity;
};

const sanitizeRelativePath = relativePath => {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw makeError('invalid_managed_temp_relative_path');
  }
  const normalized = relativePath.replace(/\\/g, '/');
  if (
    path.isAbsolute(relativePath) ||
    normalized.startsWith('/') ||
    normalized.split('/').some(part => part === '..' || part === '')
  ) {
    throw makeError('managed_temp_path_escape_rejected', { relativePath });
  }
  return normalized;
};

const createManagedTempWorkspaceService = ({
  rootDir = path.join(os.tmpdir(), 'gdevelop-agent-workspaces'),
  now = () => Date.now(),
  makeNamespaceId = () => `ns-${crypto.randomUUID()}`,
  cleanupIntervalMs = 1000,
} = {}) => {
  const namespaces = new Map();
  fs.mkdirSync(rootDir, { recursive: true });

  const removeNamespace = (namespace, reason) => {
    fs.rmSync(namespace.rootPath, { recursive: true, force: true });
    namespaces.delete(namespace.namespaceId);
    return {
      released: true,
      namespaceId: namespace.namespaceId,
      reason,
      ownerKey: namespace.ownerKey,
      taskId: namespace.taskId,
    };
  };

  const cleanupExpired = () => {
    const currentTime = now();
    const released = [];
    for (const namespace of namespaces.values()) {
      if (namespace.expiresAt <= currentTime) {
        released.push(removeNamespace(namespace, 'ttl-expired'));
      }
    }
    return released;
  };

  const getOwnedNamespace = (namespaceId, requestContext) => {
    cleanupExpired();
    const identity = getIdentity(requestContext);
    if (typeof namespaceId !== 'string' || !namespaceId) {
      throw makeError('managed_temp_namespace_id_required');
    }
    const namespace = namespaces.get(namespaceId);
    if (!namespace) {
      throw makeError('managed_temp_namespace_not_found', { namespaceId });
    }
    if (namespace.ownerKey !== identity.ownerKey) {
      throw makeError('managed_temp_namespace_owner_mismatch', {
        namespaceId,
        owner: namespace.identity,
        callerIdentity: identity,
      });
    }
    return { namespace, identity };
  };

  const touch = (namespace, ttlMs = namespace.ttlMs) => {
    const currentTime = now();
    namespace.heartbeatAt = currentTime;
    namespace.ttlMs = ttlMs;
    namespace.expiresAt = currentTime + ttlMs;
  };

  const publicNamespace = namespace => ({
    namespaceId: namespace.namespaceId,
    ownerKey: namespace.ownerKey,
    identity: namespace.identity,
    taskId: namespace.taskId,
    purpose: namespace.purpose,
    rootPath: namespace.rootPath,
    createdAt: namespace.createdAt,
    heartbeatAt: namespace.heartbeatAt,
    ttlMs: namespace.ttlMs,
    expiresAt: namespace.expiresAt,
  });

  const create = (input = {}, requestContext = {}) => {
    cleanupExpired();
    if (namespaces.size >= MAX_NAMESPACES) {
      throw makeError('managed_temp_namespace_limit_reached', {
        maximum: MAX_NAMESPACES,
      });
    }
    const identity = getIdentity(requestContext);
    const ttlMs = normalizeTtl(input.ttlMs);
    const namespaceId = makeNamespaceId();
    const rootPath = path.join(rootDir, namespaceId);
    fs.mkdirSync(rootPath, { recursive: false });
    const currentTime = now();
    const namespace = {
      namespaceId,
      ownerKey: identity.ownerKey,
      identity: { ...identity },
      taskId:
        (typeof identity.taskId === 'string' && identity.taskId) ||
        (typeof input.taskId === 'string' && input.taskId) ||
        null,
      purpose:
        typeof input.purpose === 'string' && input.purpose
          ? input.purpose
          : null,
      rootPath,
      createdAt: currentTime,
      heartbeatAt: currentTime,
      ttlMs,
      expiresAt: currentTime + ttlMs,
    };
    namespaces.set(namespaceId, namespace);
    return {
      created: true,
      namespace: publicNamespace(namespace),
      cleanup: {
        explicitRelease: true,
        ttlExpiry: true,
        hostDispose: true,
        disconnectPolicy: 'autonomous-ttl-expiry-after-last-heartbeat',
      },
    };
  };

  const status = (input = {}, requestContext = {}) => {
    cleanupExpired();
    const identity = getIdentity(requestContext);
    if (input.namespaceId) {
      const { namespace } = getOwnedNamespace(input.namespaceId, requestContext);
      return { namespace: publicNamespace(namespace) };
    }
    return {
      namespaces: Array.from(namespaces.values())
        .filter(namespace => namespace.ownerKey === identity.ownerKey)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(publicNamespace),
    };
  };

  const heartbeat = (input = {}, requestContext = {}) => {
    const { namespace } = getOwnedNamespace(input.namespaceId, requestContext);
    const ttlMs = normalizeTtl(input.ttlMs == null ? namespace.ttlMs : input.ttlMs);
    touch(namespace, ttlMs);
    return { namespace: publicNamespace(namespace) };
  };

  const resolveArtifact = (namespace, relativePath) => {
    const normalized = sanitizeRelativePath(relativePath);
    const resolved = path.resolve(namespace.rootPath, ...normalized.split('/'));
    const rootResolved = path.resolve(namespace.rootPath);
    if (
      resolved !== rootResolved &&
      !resolved.startsWith(rootResolved + path.sep)
    ) {
      throw makeError('managed_temp_path_escape_rejected', { relativePath });
    }
    return { normalized, resolved };
  };

  const write = (input = {}, requestContext = {}) => {
    const { namespace } = getOwnedNamespace(input.namespaceId, requestContext);
    const { normalized, resolved } = resolveArtifact(
      namespace,
      input.relativePath
    );
    const encoding = input.encoding === 'base64' ? 'base64' : 'utf8';
    if (typeof input.content !== 'string') {
      throw makeError('managed_temp_content_required');
    }
    const data =
      encoding === 'base64'
        ? Buffer.from(input.content, 'base64')
        : Buffer.from(input.content, 'utf8');
    if (data.length > MAX_FILE_BYTES) {
      throw makeError('managed_temp_artifact_too_large', {
        bytes: data.length,
        maximum: MAX_FILE_BYTES,
      });
    }
    if (fs.existsSync(resolved) && input.overwrite !== true) {
      throw makeError('managed_temp_artifact_exists', {
        namespaceId: namespace.namespaceId,
        relativePath: normalized,
      });
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const tempPath = `${resolved}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tempPath, data);
      if (fs.existsSync(resolved)) fs.rmSync(resolved, { force: true });
      fs.renameSync(tempPath, resolved);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
    touch(namespace);
    return {
      written: true,
      namespaceId: namespace.namespaceId,
      relativePath: normalized,
      absolutePath: resolved,
      encoding,
      bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      ownerKey: namespace.ownerKey,
      taskId: namespace.taskId,
      heartbeatAt: namespace.heartbeatAt,
      expiresAt: namespace.expiresAt,
    };
  };

  const read = (input = {}, requestContext = {}) => {
    const { namespace } = getOwnedNamespace(input.namespaceId, requestContext);
    const { normalized, resolved } = resolveArtifact(
      namespace,
      input.relativePath
    );
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw makeError('managed_temp_artifact_not_found', {
        namespaceId: namespace.namespaceId,
        relativePath: normalized,
      });
    }
    const data = fs.readFileSync(resolved);
    if (data.length > MAX_FILE_BYTES) {
      throw makeError('managed_temp_artifact_too_large', {
        bytes: data.length,
        maximum: MAX_FILE_BYTES,
      });
    }
    const encoding = input.encoding === 'base64' ? 'base64' : 'utf8';
    touch(namespace);
    return {
      namespaceId: namespace.namespaceId,
      relativePath: normalized,
      encoding,
      bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      content: data.toString(encoding),
      ownerKey: namespace.ownerKey,
      taskId: namespace.taskId,
    };
  };

  const list = (input = {}, requestContext = {}) => {
    const { namespace } = getOwnedNamespace(input.namespaceId, requestContext);
    const entries = [];
    const walk = (directory, prefix) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entries.length >= MAX_LIST_ENTRIES) break;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(absolutePath, relativePath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(absolutePath);
          entries.push({
            relativePath,
            bytes: stat.size,
            modifiedAt: stat.mtimeMs,
          });
        }
      }
    };
    walk(namespace.rootPath, '');
    touch(namespace);
    return {
      namespaceId: namespace.namespaceId,
      ownerKey: namespace.ownerKey,
      taskId: namespace.taskId,
      entries,
      truncated: entries.length >= MAX_LIST_ENTRIES,
    };
  };

  const release = (input = {}, requestContext = {}) => {
    const { namespace } = getOwnedNamespace(input.namespaceId, requestContext);
    return removeNamespace(namespace, 'explicit-release');
  };

  const cleanupTimer = setInterval(
    () => cleanupExpired(),
    Math.max(250, Number(cleanupIntervalMs) || 1000)
  );
  if (cleanupTimer && typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  const capabilities = () => ({
    supported: true,
    rootManagedByHost: true,
    ownerBoundToCallerIdentity: true,
    taskAssociation: true,
    crossAgentAccessRejected: true,
    overwriteRequiresExplicitFlag: true,
    cleanup: {
      explicitRelease: true,
      ttlExpiry: true,
      hostDispose: true,
      disconnectPolicy: 'autonomous-ttl-expiry-after-last-heartbeat',
    },
    ttlMs: {
      default: DEFAULT_TTL_MS,
      minimum: MIN_TTL_MS,
      maximum: MAX_TTL_MS,
    },
    maxFileBytes: MAX_FILE_BYTES,
    maxNamespaces: MAX_NAMESPACES,
  });

  const dispose = () => {
    clearInterval(cleanupTimer);
    for (const namespace of Array.from(namespaces.values())) {
      removeNamespace(namespace, 'host-dispose');
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  };

  return {
    capabilities,
    create,
    status,
    heartbeat,
    write,
    read,
    list,
    release,
    cleanupExpired,
    dispose,
  };
};

module.exports = {
  DEFAULT_TTL_MS,
  MAX_FILE_BYTES,
  MAX_NAMESPACES,
  MAX_TTL_MS,
  MIN_TTL_MS,
  createManagedTempWorkspaceService,
};
