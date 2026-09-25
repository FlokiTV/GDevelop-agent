// @flow

const PREVIEW_LIFECYCLE_CHANNEL =
  'gdevelop-agent-integration:preview-lifecycle';

const makeError = (code: string, message?: string): Error => {
  const error: any = new Error(message || code);
  error.code = code;
  return error;
};

export const listPreviewWindowsForAgent = async (
  ipcRenderer: any
): Promise<any> => {
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') {
    throw makeError('preview_lifecycle_unavailable');
  }
  const response = await ipcRenderer.invoke(PREVIEW_LIFECYCLE_CHANNEL);
  if (!response || response.ok !== true) {
    const payload = response && response.error ? response.error : {};
    throw makeError(
      payload.code || 'preview_lifecycle_failed',
      payload.message || payload.code || 'preview_lifecycle_failed'
    );
  }
  return response.data || { windows: [], activated: [] };
};

export const closeAllPreviewWindowsForAgent = async (
  ipcRenderer: any
): Promise<any> => {
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') {
    const error: any = new Error('preview_close_unavailable');
    error.code = 'preview_close_unavailable';
    throw error;
  }

  await ipcRenderer.invoke('preview-close-all');
  return { closed: true };
};
