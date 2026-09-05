// @flow

const GAMEPLAY_TEST_FRAME_SELECTOR = 'iframe[title="Gameplay Test"]';
const RAF_FALLBACK_MARKER = '__gdevelopAgentRafFallbackInstalled';
const DEFAULT_RAF_FALLBACK_MS = 16;

const waitForReactCommit = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, 0);
  });

/**
 * Ensure a gameplay test launched by the Agent API never reuses an iframe
 * left mounted by a previous run. The native runner also clears the frame,
 * but it immediately relaunches afterwards; React may not have committed the
 * unmount yet. Pre-clearing and yielding two macrotasks lets the cleanup
 * effect unregister the old gameplay-test-frame before the runner starts.
 */
export const prepareGameplayTestRunForAgent = async ({
  clearPreview,
  waitForCommit = waitForReactCommit,
}: {|
  clearPreview: () => void,
  waitForCommit?: () => Promise<void>,
|}): Promise<void> => {
  clearPreview();
  await waitForCommit();
  await waitForCommit();
};

/**
 * Patch requestAnimationFrame only inside the dedicated gameplay-test iframe.
 * Electron/Chromium can suspend RAF for an occluded iframe indefinitely. The
 * gameplay harness manually steps frames and only needs RAF as an occasional
 * browser yield, so a MessageChannel fallback keeps the test deterministic
 * without changing GDJS or the normal preview runtime.
 */
export const installAnimationFrameFallbackOnWindowForAgent = ({
  windowObject,
  fallbackAfterMs = DEFAULT_RAF_FALLBACK_MS,
}: {|
  windowObject: any,
  fallbackAfterMs?: number,
|}): boolean => {
  if (!windowObject) return false;
  const currentDocument = windowObject.document || null;
  const existingMarker = windowObject[RAF_FALLBACK_MARKER];
  if (existingMarker && existingMarker.document === currentDocument)
    return false;
  const nativeRequestAnimationFrame = windowObject.requestAnimationFrame;
  if (typeof nativeRequestAnimationFrame !== 'function') return false;
  const nativeCancelAnimationFrame = windowObject.cancelAnimationFrame;
  const NativeMessageChannel = windowObject.MessageChannel;
  const pending = new Map();
  let nextRequestId = 1000000000;

  windowObject.requestAnimationFrame = callback => {
    const requestId = nextRequestId++;
    const startedAt = Date.now();
    let settled = false;
    let nativeRequestId = null;
    let channel = null;

    const closeChannel = () => {
      if (!channel) return;
      try {
        channel.port1.close();
        channel.port2.close();
      } catch (error) {}
      channel = null;
    };
    const finish = timestamp => {
      if (settled) return;
      settled = true;
      pending.delete(requestId);
      closeChannel();
      callback(timestamp);
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      pending.delete(requestId);
      closeChannel();
      if (
        nativeRequestId !== null &&
        typeof nativeCancelAnimationFrame === 'function'
      ) {
        nativeCancelAnimationFrame.call(windowObject, nativeRequestId);
      }
    };
    const fallback = () => {
      if (settled) return;
      if (Date.now() - startedAt >= fallbackAfterMs) {
        if (
          nativeRequestId !== null &&
          typeof nativeCancelAnimationFrame === 'function'
        ) {
          nativeCancelAnimationFrame.call(windowObject, nativeRequestId);
        }
        const timestamp =
          windowObject.performance &&
          typeof windowObject.performance.now === 'function'
            ? windowObject.performance.now()
            : Date.now();
        finish(timestamp);
        return;
      }
      if (channel) channel.port2.postMessage(null);
    };

    pending.set(requestId, cancel);
    nativeRequestId = nativeRequestAnimationFrame.call(windowObject, finish);
    if (typeof NativeMessageChannel === 'function') {
      channel = new NativeMessageChannel();
      channel.port1.onmessage = fallback;
      channel.port2.postMessage(null);
    } else {
      setTimeout(fallback, fallbackAfterMs);
    }
    return requestId;
  };

  windowObject.cancelAnimationFrame = requestId => {
    const cancel = pending.get(requestId);
    if (cancel) cancel();
    else if (typeof nativeCancelAnimationFrame === 'function') {
      nativeCancelAnimationFrame.call(windowObject, requestId);
    }
  };
  windowObject[RAF_FALLBACK_MARKER] = { document: currentDocument };
  return true;
};

/**
 * Watch for the gameplay-test iframe created by the native runner and install
 * the RAF fallback after each navigation. Returns a cleanup for the observer;
 * the patch itself lives only as long as that disposable iframe window.
 */
export const watchGameplayTestFrameForAgent = ({
  documentObject,
}: {|
  documentObject: any,
|}): (() => void) => {
  if (!documentObject || !documentObject.querySelectorAll) return () => {};
  const observedFrames = new Set();

  const patchFrame = frame => {
    if (!frame || observedFrames.has(frame)) return;
    observedFrames.add(frame);
    const patch = () => {
      try {
        installAnimationFrameFallbackOnWindowForAgent({
          windowObject: frame.contentWindow,
        });
      } catch (error) {}
    };
    if (frame.addEventListener) frame.addEventListener('load', patch);
    patch();
  };
  const scan = () => {
    const frames = documentObject.querySelectorAll(
      GAMEPLAY_TEST_FRAME_SELECTOR
    );
    for (let index = 0; index < frames.length; index++) {
      patchFrame(frames[index]);
    }
  };

  scan();
  const documentWindow = documentObject.defaultView;
  const MutationObserverClass = documentWindow
    ? documentWindow.MutationObserver
    : null;
  if (typeof MutationObserverClass !== 'function') return () => {};
  const observer = new MutationObserverClass(scan);
  observer.observe(documentObject.documentElement || documentObject.body, {
    childList: true,
    subtree: true,
  });
  return () => observer.disconnect();
};
