const installAgentRuntimeGameCapture = globalObject => {
  if (!globalObject || typeof globalObject !== 'object') return false;
  if (globalObject.__GDevelopAgentRuntimeGameCaptureInstalled) return true;

  const gdjs = globalObject.gdjs || (globalObject.gdjs = {});
  let currentRuntimeGame = gdjs.RuntimeGame;

  const wrapRuntimeGame = RuntimeGame => {
    if (
      typeof RuntimeGame !== 'function' ||
      RuntimeGame.__gdevelopAgentRuntimeGameWrapper
    ) {
      return RuntimeGame;
    }

    class AgentRuntimeGame extends RuntimeGame {
      constructor(...args) {
        super(...args);
        globalObject.__GDevelopAgentRuntimeGame = this;
      }
    }

    Object.defineProperty(
      AgentRuntimeGame,
      '__gdevelopAgentRuntimeGameWrapper',
      {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false,
      }
    );
    return AgentRuntimeGame;
  };

  Object.defineProperty(gdjs, 'RuntimeGame', {
    configurable: true,
    enumerable: true,
    get: () => currentRuntimeGame,
    set: RuntimeGame => {
      currentRuntimeGame = wrapRuntimeGame(RuntimeGame);
    },
  });

  if (typeof currentRuntimeGame === 'function') {
    currentRuntimeGame = wrapRuntimeGame(currentRuntimeGame);
  }

  globalObject.__GDevelopAgentRuntimeGameCaptureInstalled = true;
  return true;
};

if (typeof window !== 'undefined') {
  installAgentRuntimeGameCapture(window);
}

module.exports = {
  installAgentRuntimeGameCapture,
};
