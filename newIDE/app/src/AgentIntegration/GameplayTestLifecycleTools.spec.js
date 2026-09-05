// @flow
import {
  installAnimationFrameFallbackOnWindowForAgent,
  prepareGameplayTestRunForAgent,
} from './GameplayTestLifecycleTools';

describe('GameplayTestLifecycleTools', () => {
  test('clears the old gameplay frame and waits for two React commit turns', async () => {
    const calls = [];
    const clearPreview = jest.fn(() => calls.push('clear'));
    const waitForCommit = jest.fn(async () => {
      calls.push('wait');
    });

    await prepareGameplayTestRunForAgent({ clearPreview, waitForCommit });

    expect(clearPreview).toHaveBeenCalledTimes(1);
    expect(waitForCommit).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['clear', 'wait', 'wait']);
  });

  test('falls back when requestAnimationFrame never fires', async () => {
    class FakeMessageChannel {
      constructor() {
        const port1 = {
          onmessage: null,
          close: jest.fn(),
        };
        this.port1 = port1;
        this.port2 = {
          close: jest.fn(),
          postMessage: () => {
            Promise.resolve().then(() => {
              if (port1.onmessage) port1.onmessage();
            });
          },
        };
      }
      port1: any;
      port2: any;
    }

    const nativeRequestAnimationFrame = jest.fn(() => 42);
    const nativeCancelAnimationFrame = jest.fn();
    const windowObject = {
      requestAnimationFrame: nativeRequestAnimationFrame,
      cancelAnimationFrame: nativeCancelAnimationFrame,
      MessageChannel: FakeMessageChannel,
      performance: { now: () => 123 },
    };

    expect(
      installAnimationFrameFallbackOnWindowForAgent({
        windowObject,
        fallbackAfterMs: 0,
      })
    ).toBe(true);

    const timestamp = await new Promise(resolve => {
      windowObject.requestAnimationFrame(resolve);
    });

    expect(timestamp).toBe(123);
    expect(nativeRequestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(nativeCancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(
      installAnimationFrameFallbackOnWindowForAgent({ windowObject })
    ).toBe(false);
  });
});
