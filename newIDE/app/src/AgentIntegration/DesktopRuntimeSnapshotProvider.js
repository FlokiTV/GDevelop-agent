// @flow

export const PREVIEW_RUNTIME_SNAPSHOT_CHANNEL: string =
  'gdevelop-agent-integration:preview-runtime-snapshot';

const makeError = (payload: any): Error => {
  const error: any = new Error(
    (payload && payload.message) || 'preview_runtime_snapshot_failed'
  );
  error.code = (payload && payload.code) || 'preview_runtime_snapshot_failed';
  if (payload && payload.details !== undefined) {
    error.details = payload.details;
  }
  return error;
};

export const createDesktopRuntimeSnapshotProvider = (ipcRenderer: any): any => {
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') {
    throw makeError({
      code: 'preview_runtime_snapshot_ipc_unavailable',
      message: 'preview_runtime_snapshot_ipc_unavailable',
    });
  }
  return async (request: any = {}): Promise<any> => {
    const response = await ipcRenderer.invoke(
      PREVIEW_RUNTIME_SNAPSHOT_CHANNEL,
      request
    );
    if (!response || response.ok !== true) {
      throw makeError(response && response.error);
    }
    return response.data;
  };
};
