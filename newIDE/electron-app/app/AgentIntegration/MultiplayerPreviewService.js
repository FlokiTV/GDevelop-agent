const MAX_CLIENTS = 8;
const MAX_BATCH_ACTIONS = 200;

const makeError = code => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const normalizeAlias = alias => {
  const value = String(alias || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw makeError('invalid_preview_alias');
  return value;
};

const createMultiplayerPreviewService = ({
  BrowserWindow,
  isRegisteredPreviewWindow,
  previewInteractionService,
}) => {
  const aliases = new Map();

  const listPreviewWindows = () =>
    BrowserWindow.getAllWindows()
      .filter(
        window =>
          window &&
          !window.isDestroyed() &&
          isRegisteredPreviewWindow(window.id)
      )
      .map(window => ({
        windowId: window.id,
        title: window.getTitle(),
        url: window.webContents.getURL(),
        focused: window.isFocused(),
        visible: window.isVisible(),
      }))
      .sort((left, right) => left.windowId - right.windowId);

  const pruneAliases = () => {
    const liveIds = new Set(
      listPreviewWindows().map(window => window.windowId)
    );
    for (const [alias, windowId] of aliases) {
      if (!liveIds.has(windowId)) aliases.delete(alias);
    }
  };

  const capabilities = () => ({
    multiPreview: {
      supported: true,
      maxClients: MAX_CLIENTS,
      stableAliases: true,
      coordinatedInput: true,
      crossClientRuntimeStatus: true,
    },
    networkObservability: {
      supported: true,
      transport: 'electron-webcontents-debugger-cdp',
      protocols: { http: true, webSocket: true },
      bounded: true,
      redactionByDefault: true,
      responseBodies: false,
    },
    networkShaping: {
      supported: false,
      reason: 'network_shaping_not_exposed',
    },
  });

  const listClients = () => {
    pruneAliases();
    const aliasByWindowId = new Map(
      Array.from(aliases.entries()).map(([alias, windowId]) => [
        windowId,
        alias,
      ])
    );
    return listPreviewWindows().map(window => ({
      ...window,
      alias: aliasByWindowId.get(window.windowId) || null,
    }));
  };

  const assignAliases = ({ clients } = {}) => {
    if (
      !Array.isArray(clients) ||
      clients.length < 1 ||
      clients.length > MAX_CLIENTS
    ) {
      throw makeError('invalid_preview_clients');
    }
    const liveIds = new Set(
      listPreviewWindows().map(window => window.windowId)
    );
    const nextAliases = new Map();
    const usedWindowIds = new Set();
    for (const client of clients) {
      const alias = normalizeAlias(client && client.alias);
      const windowId = Number(client && client.previewWindowId);
      if (!Number.isInteger(windowId) || !liveIds.has(windowId)) {
        throw makeError('preview_window_not_found');
      }
      if (nextAliases.has(alias) || usedWindowIds.has(windowId)) {
        throw makeError('duplicate_preview_client');
      }
      nextAliases.set(alias, windowId);
      usedWindowIds.add(windowId);
    }
    aliases.clear();
    for (const entry of nextAliases) aliases.set(...entry);
    return { clients: listClients().filter(client => client.alias) };
  };

  const resolveAlias = alias => {
    pruneAliases();
    const normalizedAlias = normalizeAlias(alias);
    const windowId = aliases.get(normalizedAlias);
    if (!windowId) throw makeError('preview_alias_not_found');
    return { alias: normalizedAlias, previewWindowId: windowId };
  };

  const runBatch = async ({ actions } = {}) => {
    if (
      !Array.isArray(actions) ||
      actions.length < 1 ||
      actions.length > MAX_BATCH_ACTIONS
    ) {
      throw makeError('invalid_preview_actions');
    }
    const results = [];
    for (const action of actions) {
      const client = resolveAlias(action && action.alias);
      const operation = action && action.operation;
      if (operation === 'input') {
        results.push({
          ...client,
          operation,
          result: await previewInteractionService.sendInput({
            previewWindowId: client.previewWindowId,
            event: action.event,
          }),
        });
      } else if (operation === 'sequence') {
        results.push({
          ...client,
          operation,
          result: await previewInteractionService.sendSequence({
            previewWindowId: client.previewWindowId,
            steps: action.steps,
          }),
        });
      } else if (operation === 'runtime-status') {
        results.push({
          ...client,
          operation,
          result: await previewInteractionService.getRuntimeStatus({
            previewWindowId: client.previewWindowId,
          }),
        });
      } else if (operation === 'runtime-reset') {
        results.push({
          ...client,
          operation,
          result: await previewInteractionService.resetRuntime({
            previewWindowId: client.previewWindowId,
          }),
        });
      } else {
        throw makeError('unsupported_preview_batch_operation');
      }
    }
    return { results };
  };

  const runtimeStatus = async ({ aliases: requestedAliases } = {}) => {
    pruneAliases();
    const selected =
      requestedAliases == null
        ? Array.from(aliases.keys())
        : requestedAliases.map(normalizeAlias);
    const clients = [];
    for (const alias of selected) {
      const client = resolveAlias(alias);
      clients.push({
        ...client,
        runtime: await previewInteractionService.getRuntimeStatus({
          previewWindowId: client.previewWindowId,
        }),
      });
    }
    return { clients };
  };

  return {
    capabilities,
    listClients,
    assignAliases,
    resolveAlias,
    runBatch,
    runtimeStatus,
  };
};

module.exports = {
  MAX_CLIENTS,
  MAX_BATCH_ACTIONS,
  createMultiplayerPreviewService,
};
