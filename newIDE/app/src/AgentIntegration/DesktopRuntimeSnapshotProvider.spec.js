// @flow
import {
  PREVIEW_RUNTIME_SNAPSHOT_CHANNEL,
  createDesktopRuntimeSnapshotProvider,
} from './DesktopRuntimeSnapshotProvider';

describe('DesktopRuntimeSnapshotProvider', () => {
  it('invokes the bounded preview snapshot IPC channel and returns data', async () => {
    const ipcRenderer = {
      invoke: jest.fn(async () => ({
        ok: true,
        data: {
          previewWindowId: 4,
          snapshotSource: 'bounded-preview-runtime',
          scene: { name: 'Scene' },
        },
      })),
    };
    const provider = createDesktopRuntimeSnapshotProvider(ipcRenderer);
    await expect(provider({ maxInstances: 5 })).resolves.toMatchObject({
      previewWindowId: 4,
      snapshotSource: 'bounded-preview-runtime',
      scene: { name: 'Scene' },
    });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      PREVIEW_RUNTIME_SNAPSHOT_CHANNEL,
      { maxInstances: 5 }
    );
  });

  it('preserves typed errors returned by the main process', async () => {
    const ipcRenderer = {
      invoke: jest.fn(async () => ({
        ok: false,
        error: {
          code: 'preview_window_ambiguous',
          message: 'preview_window_ambiguous',
          details: { previewWindowIds: [2, 3] },
        },
      })),
    };
    const provider = createDesktopRuntimeSnapshotProvider(ipcRenderer);
    await expect(provider({})).rejects.toMatchObject({
      code: 'preview_window_ambiguous',
      details: { previewWindowIds: [2, 3] },
    });
  });
});
