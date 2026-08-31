// @flow

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
