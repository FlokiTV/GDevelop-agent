const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreviewInteractionService,
} = require('./PreviewInteractionService');

const makeAcceptanceHarness = () => {
  const model = {
    Tab: 'Main',
    Language: 'en',
    Coins: 10,
    Purchases: 0,
    UpgradeLevel: 0,
    Locked: true,
    ReplacementHits: 0,
    LegacyHits: 0,
  };
  const events = [];
  const controls = {
    TabShop: { x: 100, y: 80, width: 100, height: 40, cursor: 'pointer' },
    LanguageButton: {
      x: 220,
      y: 80,
      width: 100,
      height: 40,
      cursor: 'pointer',
    },
    BuyButton: { x: 340, y: 80, width: 100, height: 40, cursor: 'pointer' },
    UpgradeButton: {
      x: 460,
      y: 80,
      width: 100,
      height: 40,
      cursor: () => (model.Locked ? 'default' : 'pointer'),
    },
    VisibleReplacement: {
      x: 580,
      y: 80,
      width: 100,
      height: 40,
      cursor: 'pointer',
      zOrder: 2,
    },
    LegacyHidden: {
      x: 580,
      y: 80,
      width: 100,
      height: 40,
      cursor: 'default',
      hidden: true,
      zOrder: 99,
    },
  };

  const contains = (control, x, y) =>
    x >= control.x - control.width / 2 &&
    x <= control.x + control.width / 2 &&
    y >= control.y - control.height / 2 &&
    y <= control.y + control.height / 2;

  const identity = name => ({
    objectName: name,
    instanceId: Object.keys(controls).indexOf(name) + 1,
    instanceIndex: 0,
    type: 'Sprite',
    layer: '',
    zOrder: controls[name].zOrder || 1,
  });

  const stateFor = name => {
    const control = controls[name];
    const hidden = !!control.hidden;
    return {
      hidden,
      layerVisible: true,
      livingOnScene: true,
      visible: !hidden,
      hitTestable: true,
      blockedReasons: hidden ? ['hidden'] : [],
    };
  };

  const ownerAt = (x, y) => {
    const candidates = Object.entries(controls)
      .filter(([, control]) => !control.hidden && contains(control, x, y))
      .sort((a, b) => (b[1].zOrder || 1) - (a[1].zOrder || 1));
    return candidates.length ? candidates[0][0] : null;
  };

  const excludedAt = (x, y) =>
    Object.entries(controls)
      .filter(([, control]) => control.hidden && contains(control, x, y))
      .map(([name]) => ({
        identity: identity(name),
        state: stateFor(name),
      }));

  const inspection = payload => {
    const targetName =
      payload && payload.target && payload.target.objectName
        ? payload.target.objectName
        : null;
    const targetControl = targetName ? controls[targetName] : null;
    let x =
      payload && Number.isFinite(Number(payload.x))
        ? Number(payload.x)
        : targetControl
        ? targetControl.x
        : 0;
    let y =
      payload && Number.isFinite(Number(payload.y))
        ? Number(payload.y)
        : targetControl
        ? targetControl.y
        : 0;
    const target =
      targetName && targetControl
        ? {
            identity: identity(targetName),
            size: {
              width: targetControl.width,
              height: targetControl.height,
            },
            scene: {
              center: { x, y },
              bounds: {
                left: x - targetControl.width / 2,
                top: y - targetControl.height / 2,
                right: x + targetControl.width / 2,
                bottom: y + targetControl.height / 2,
                width: targetControl.width,
                height: targetControl.height,
              },
              hitBoxes: [],
            },
            viewport: {
              center: { x, y },
              bounds: {
                left: x - targetControl.width / 2,
                top: y - targetControl.height / 2,
                right: x + targetControl.width / 2,
                bottom: y + targetControl.height / 2,
                width: targetControl.width,
                height: targetControl.height,
              },
              hitBoxes: [],
              insideViewport: true,
            },
            state: stateFor(targetName),
            classification: {
              presentationSurface: targetControl.hidden ? 'hidden' : 'visible',
              interactionControl: targetControl.hidden
                ? 'blocked'
                : 'candidate',
              disabled: null,
              legacy: null,
              semanticStateAuthority:
                'game-specific-disabled-and-legacy-state-is-not-inferred',
            },
          }
        : null;
    const ownerName = ownerAt(x, y);
    const owner = ownerName
      ? {
          identity: identity(ownerName),
          state: stateFor(ownerName),
        }
      : null;
    const diagnostics = [];
    if (targetName && !targetControl) {
      diagnostics.push({
        code: 'preview_target_not_found',
        message: 'No runtime object instance matched the target selector.',
      });
    }
    if (target && target.state.hidden) {
      diagnostics.push({
        code: 'preview_target_hidden',
        message: 'The target runtime object is hidden.',
      });
    }
    if (
      target &&
      target.state.visible &&
      owner &&
      owner.identity.objectName !== target.identity.objectName
    ) {
      diagnostics.push({
        code: 'preview_target_occluded',
        message:
          'A different visible runtime object owns the hit-test coordinate.',
        owner: owner.identity,
      });
    }
    const cursorControl = ownerName ? controls[ownerName] : null;
    const cursorValue =
      cursorControl && typeof cursorControl.cursor === 'function'
        ? cursorControl.cursor()
        : cursorControl
        ? cursorControl.cursor
        : 'default';
    return {
      runtimeSource: 'acceptance-runtime-model',
      viewport: {
        width: 800,
        height: 600,
        devicePixelRatio: 1.5,
        gameResolution: { width: 800, height: 600 },
        canvas: { x: 0, y: 0, width: 800, height: 600 },
      },
      requested: {
        target: payload && payload.target ? payload.target : null,
        coordinateSpace: 'viewport',
        x: payload && payload.x != null ? Number(payload.x) : null,
        y: payload && payload.y != null ? Number(payload.y) : null,
        layer: null,
      },
      point: {
        x,
        y,
        coordinateSpace: 'viewport-css-px',
        insideViewport: x >= 0 && x < 800 && y >= 0 && y < 600,
        insideCanvas: x >= 0 && x < 800 && y >= 0 && y < 600,
      },
      target,
      hitTest: {
        owner,
        candidates: owner ? [owner] : [],
        excluded: excludedAt(x, y),
      },
      pointer: {
        cursor: cursorValue,
        elementTag: 'canvas',
        canvasCursor: cursorValue,
        bodyCursor: null,
      },
      diagnostics,
    };
  };

  const evaluate = payload => {
    const actual = model[payload.variable];
    const expected = payload.value;
    const operator = payload.operator || 'equals';
    let matched;
    if (operator === 'equals') matched = actual === expected;
    else if (operator === 'not-equals') matched = actual !== expected;
    else if (operator === 'gt') matched = Number(actual) > Number(expected);
    else if (operator === 'gte') matched = Number(actual) >= Number(expected);
    else if (operator === 'lt') matched = Number(actual) < Number(expected);
    else if (operator === 'lte') matched = Number(actual) <= Number(expected);
    else if (operator === 'truthy') matched = !!actual;
    else if (operator === 'falsy') matched = !actual;
    else matched = false;
    return {
      matched,
      scope: payload.scope || 'scene',
      variable: payload.variable,
      operator,
      expected,
      actual,
      frame: {
        sceneName: 'CoinIdleAcceptance',
        timeFromStartMs: events.length * 16,
      },
    };
  };

  const activate = name => {
    if (name === 'TabShop') model.Tab = 'Shop';
    else if (name === 'LanguageButton') {
      model.Language = model.Language === 'en' ? 'pt' : 'en';
    } else if (name === 'BuyButton') {
      if (model.Coins >= 5) {
        model.Coins -= 5;
        model.Purchases += 1;
      }
    } else if (name === 'UpgradeButton') {
      if (!model.Locked && model.Coins >= 0) model.UpgradeLevel += 1;
    } else if (name === 'VisibleReplacement') {
      model.ReplacementHits += 1;
    } else if (name === 'LegacyHidden') {
      model.LegacyHits += 1;
    }
  };

  const runtimeCalls = [];
  const previewWindow = {
    id: 42,
    isDestroyed: () => false,
    getTitle: () => 'Preview of CoinIdleAcceptance',
    focus: () => {},
    webContents: {
      getURL: () => 'file:///C:/Temp/GDevelop/preview/index.html',
      focus: () => {},
      sendInputEvent: event => {
        events.push(event);
        if (event.type === 'mouseUp') {
          const ownerName = ownerAt(event.x, event.y);
          if (ownerName) activate(ownerName);
        }
      },
      executeJavaScript: async source => {
        if (source.startsWith('(() => {')) {
          return { installed: true, version: 4 };
        }
        const match = source.match(
          /^window\["__GDevelopAgentPreviewRuntime"\]\["([^"]+)"\]\((.*)\)$/
        );
        if (!match) return null;
        const method = match[1];
        const payload = JSON.parse(match[2]);
        runtimeCalls.push({ method, payload });
        if (method === 'announceIdentity') {
          return { announced: true, windowId: 42 };
        }
        if (method === 'inspect') return inspection(payload);
        if (method === 'synchronize') {
          return {
            processed: true,
            animationFrames: 1,
            before: {
              sceneName: 'CoinIdleAcceptance',
              timeFromStartMs: Math.max(0, (events.length - 1) * 16),
            },
            after: {
              sceneName: 'CoinIdleAcceptance',
              timeFromStartMs: events.length * 16,
            },
          };
        }
        if (method === 'evaluateState') return evaluate(payload);
        if (method === 'waitForState') {
          const evaluation = evaluate(payload);
          return {
            matched: evaluation.matched,
            stableFrames: evaluation.matched ? payload.stableFrames || 1 : 0,
            elapsedMs: 16,
            evaluation,
            ...(evaluation.matched
              ? {}
              : { reason: 'preview_state_wait_timeout' }),
          };
        }
        return { installed: true, version: 4 };
      },
    },
  };

  const service = createPreviewInteractionService({
    BrowserWindow: {
      fromId: id => (Number(id) === 42 ? previewWindow : null),
    },
    windowRegistry: { isRegistered: () => false },
    isRegisteredPreviewWindow: id => Number(id) === 42,
  });

  return { service, model, events, runtimeCalls, controls };
};

test('acceptance: tabs, language, buy and locked/unlocked upgrade are state-synchronized', async () => {
  const { service, model } = makeAcceptanceHarness();

  const tab = await service.interact({
    previewWindowId: 42,
    action: 'click',
    target: { objectName: 'TabShop' },
    waitFor: {
      variable: 'Tab',
      operator: 'equals',
      value: 'Shop',
      timeoutMs: 1000,
    },
    assertAfter: { variable: 'Tab', operator: 'equals', value: 'Shop' },
  });
  assert.equal(model.Tab, 'Shop');
  assert.equal(tab.observation.waitFor.matched, true);
  assert.equal(tab.after.pointer.cursor, 'pointer');

  await service.interact({
    previewWindowId: 42,
    action: 'click',
    target: { objectName: 'LanguageButton' },
    waitFor: {
      variable: 'Language',
      operator: 'equals',
      value: 'pt',
      timeoutMs: 1000,
    },
  });
  assert.equal(model.Language, 'pt');

  await service.interact({
    previewWindowId: 42,
    action: 'click',
    target: { objectName: 'BuyButton' },
    waitFor: {
      variable: 'Purchases',
      operator: 'equals',
      value: 1,
      timeoutMs: 1000,
    },
    assertAfter: {
      variable: 'Purchases',
      operator: 'equals',
      value: 1,
    },
  });
  assert.equal(model.Purchases, 1);
  assert.equal(model.Coins, 5);

  const locked = await service.interact({
    previewWindowId: 42,
    action: 'click',
    target: { objectName: 'UpgradeButton' },
    controlState: {
      disabledWhen: {
        variable: 'Locked',
        operator: 'truthy',
      },
    },
    assertAfter: {
      variable: 'UpgradeLevel',
      operator: 'equals',
      value: 0,
    },
  });
  assert.equal(model.UpgradeLevel, 0);
  assert.equal(locked.source.target.classification.disabled, true);
  assert.equal(locked.after.pointer.cursor, 'default');
  assert.equal(
    locked.after.diagnostics.some(
      diagnostic => diagnostic.code === 'preview_target_disabled'
    ),
    true
  );

  model.Locked = false;
  const upgraded = await service.interact({
    previewWindowId: 42,
    action: 'click',
    target: { objectName: 'UpgradeButton' },
    controlState: {
      disabledWhen: {
        variable: 'Locked',
        operator: 'truthy',
      },
    },
    waitFor: {
      variable: 'UpgradeLevel',
      operator: 'equals',
      value: 1,
      timeoutMs: 1000,
    },
  });
  assert.equal(model.UpgradeLevel, 1);
  assert.equal(upgraded.source.target.classification.disabled, false);
  assert.equal(upgraded.after.pointer.cursor, 'pointer');
});

test('acceptance: repeated identical click sequences are deterministic without sleeps', async () => {
  const { service, model, runtimeCalls } = makeAcceptanceHarness();
  const signatures = [];

  for (let iteration = 0; iteration < 20; iteration += 1) {
    model.Tab = 'Main';
    const result = await service.interact({
      previewWindowId: 42,
      action: 'click',
      target: { objectName: 'TabShop' },
      waitFor: {
        variable: 'Tab',
        operator: 'equals',
        value: 'Shop',
        timeoutMs: 1000,
      },
      assertAfter: {
        variable: 'Tab',
        operator: 'equals',
        value: 'Shop',
      },
    });
    signatures.push(
      JSON.stringify({
        coordinates: result.source.coordinates,
        phases: result.dispatched.map(step => step.phase),
        owner: result.after.hitTest.owner.identity,
        tab: model.Tab,
      })
    );
  }

  assert.equal(new Set(signatures).size, 1);
  assert.equal(model.Tab, 'Shop');
  assert.equal(
    runtimeCalls.filter(call => call.method === 'synchronize').length,
    20 * 3
  );
});

test('acceptance: hidden stale control cannot receive input when visible replacement owns the point', async () => {
  const { service, model, events } = makeAcceptanceHarness();

  const inspected = await service.inspect({
    previewWindowId: 42,
    target: { objectName: 'LegacyHidden' },
    controlState: {
      legacyWhen: {
        variable: 'Locked',
        operator: 'truthy',
      },
    },
  });
  assert.equal(inspected.target.state.hidden, true);
  assert.equal(inspected.target.classification.legacy, true);
  assert.equal(
    inspected.hitTest.owner.identity.objectName,
    'VisibleReplacement'
  );
  assert.equal(
    inspected.hitTest.excluded[0].identity.objectName,
    'LegacyHidden'
  );

  const beforeEvents = events.length;
  await assert.rejects(
    service.interact({
      previewWindowId: 42,
      action: 'click',
      target: { objectName: 'LegacyHidden' },
    }),
    error => error && error.code === 'preview_target_hidden'
  );
  assert.equal(events.length, beforeEvents);
  assert.equal(model.LegacyHits, 0);

  const replacement = await service.interact({
    previewWindowId: 42,
    action: 'click',
    target: { objectName: 'VisibleReplacement' },
    waitFor: {
      variable: 'ReplacementHits',
      operator: 'equals',
      value: 1,
      timeoutMs: 1000,
    },
  });
  assert.equal(model.ReplacementHits, 1);
  assert.equal(model.LegacyHits, 0);
  assert.equal(
    replacement.after.hitTest.owner.identity.objectName,
    'VisibleReplacement'
  );
});
