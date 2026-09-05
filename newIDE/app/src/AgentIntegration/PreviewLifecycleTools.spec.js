// @flow
import { closeAllPreviewWindowsForAgent } from './PreviewLifecycleTools';

describe('AgentApi PreviewLifecycleTools', () => {
  it('closes native preview windows without touching the debugger server', async () => {
    const ipcRenderer = { invoke: jest.fn(() => Promise.resolve()) };

    await expect(closeAllPreviewWindowsForAgent(ipcRenderer)).resolves.toEqual({
      closed: true,
    });
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('preview-close-all');
  });

  it('fails explicitly when Electron IPC is unavailable', async () => {
    await expect(closeAllPreviewWindowsForAgent(null)).rejects.toMatchObject({
      code: 'preview_close_unavailable',
    });
  });
});
