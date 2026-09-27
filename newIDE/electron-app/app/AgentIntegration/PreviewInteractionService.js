const { createPreviewInputTools } = require('./PreviewInputTools');
const {
  createAgentPreviewRuntime,
  validateTouch,
  validateGamepad,
  validateSnapshot,
} = require('./AgentPreviewRuntime');

const POINTER_ACTIONS = new Set([
  'move',
  'hover',
  'press',
  'release',
  'click',
  'double-click',
  'drag',
]);
const MOUSE_BUTTONS = new Set(['left', 'middle', 'right']);
const STATE_OPERATORS = new Set([
  'equals',
  'not-equals',
  'gt',
  'gte',
  'lt',
  'lte',
  'truthy',
  'falsy',
]);

const makeError = (code, message = code, details) => {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const requireFiniteNumber = (value, field) => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw makeError(
      'invalid_preview_interaction_input',
      `Invalid finite number for ${field}.`,
      { field, value }
    );
  }
  return number;
};

const normalizeSelector = selector => {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
    throw makeError('invalid_preview_target_selector');
  }
  const objectName =
    typeof selector.objectName === 'string' && selector.objectName.trim()
      ? selector.objectName.trim()
      : null;
  const hasInstanceId =
    selector.instanceId !== undefined && selector.instanceId !== null;
  const instanceId = hasInstanceId ? Number(selector.instanceId) : null;
  if (hasInstanceId && (!Number.isInteger(instanceId) || instanceId < 0)) {
    throw makeError('invalid_preview_target_selector', undefined, {
      field: 'target.instanceId',
      value: selector.instanceId,
    });
  }
  if (!objectName && !hasInstanceId) {
    throw makeError('invalid_preview_target_selector', undefined, {
      reason: 'objectName_or_instanceId_required',
    });
  }
  const instanceIndex =
    selector.instanceIndex == null ? 0 : Number(selector.instanceIndex);
  if (!Number.isInteger(instanceIndex) || instanceIndex < 0) {
    throw makeError('invalid_preview_target_selector', undefined, {
      field: 'target.instanceIndex',
      value: selector.instanceIndex,
    });
  }
  return {
    ...(objectName ? { objectName } : {}),
    ...(hasInstanceId ? { instanceId } : {}),
    instanceIndex,
  };
};

const normalizePointRequest = ({
  target,
  x,
  y,
  coordinateSpace,
  layer,
  prefix = '',
  required = true,
}) => {
  const hasTarget = target != null;
  const hasX = x != null;
  const hasY = y != null;
  if (hasX !== hasY) {
    throw makeError('invalid_preview_interaction_input', undefined, {
      reason: 'x_and_y_must_be_provided_together',
      prefix,
    });
  }
  if (!hasTarget && !hasX) {
    if (!required) return null;
    throw makeError('missing_preview_interaction_target', undefined, {
      prefix,
    });
  }
  const space = coordinateSpace === 'scene' ? 'scene' : 'viewport';
  return {
    ...(hasTarget ? { target: normalizeSelector(target) } : {}),
    ...(hasX
      ? {
          x: requireFiniteNumber(x, `${prefix}x`),
          y: requireFiniteNumber(y, `${prefix}y`),
        }
      : {}),
    coordinateSpace: space,
    ...(typeof layer === 'string' ? { layer } : {}),
  };
};

const normalizeStateCondition = (condition, { wait = false } = {}) => {
  if (
    !condition ||
    typeof condition !== 'object' ||
    Array.isArray(condition) ||
    typeof condition.variable !== 'string' ||
    !condition.variable.trim()
  ) {
    throw makeError('invalid_preview_state_condition');
  }
  const scope = condition.scope === 'global' ? 'global' : 'scene';
  const operator =
    typeof condition.operator === 'string' && condition.operator
      ? condition.operator
      : 'equals';
  if (!STATE_OPERATORS.has(operator)) {
    throw makeError('invalid_preview_state_condition', undefined, {
      field: 'operator',
      value: operator,
    });
  }
  const normalized = {
    scope,
    variable: condition.variable.trim(),
    operator,
    ...(Object.prototype.hasOwnProperty.call(condition, 'value')
      ? { value: condition.value }
      : {}),
  };
  if (wait) {
    const timeoutMs =
      condition.timeoutMs == null ? 3000 : Number(condition.timeoutMs);
    const stableFrames =
      condition.stableFrames == null ? 1 : Number(condition.stableFrames);
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 10000 ||
      !Number.isInteger(stableFrames) ||
      stableFrames < 1 ||
      stableFrames > 10
    ) {
      throw makeError('invalid_preview_state_condition', undefined, {
        timeoutMs,
        stableFrames,
      });
    }
    normalized.timeoutMs = timeoutMs;
    normalized.stableFrames = stableFrames;
  }
  return normalized;
};

const identityMatches = (a, b) =>
  !!a && !!b && a.objectName === b.objectName && a.instanceId === b.instanceId;

const createPreviewInteractionService = ({
  BrowserWindow,
  windowRegistry,
  isRegisteredPreviewWindow,
}) => {
  const isEditorWindow = windowId => windowRegistry.isRegistered(windowId);
  const inputTools = createPreviewInputTools({
    BrowserWindow,
    isEditorWindow,
    isRegisteredPreviewWindow,
  });
  const previewRuntime = createAgentPreviewRuntime({
    BrowserWindow,
    isEditorWindow,
    isRegisteredPreviewWindow,
  });

  const getWindowId = input =>
    input && input.previewWindowId != null
      ? input.previewWindowId
      : input && input.windowId;

  const sendInput = input =>
    inputTools.sendInput({
      windowId: getWindowId(input),
      inputEvent: input && (input.event || input.inputEvent),
    });

  const sendSequence = input =>
    inputTools.sendSequence({
      windowId: getWindowId(input),
      steps: input && input.steps,
    });

  const resetInput = input =>
    inputTools.resetInput({ windowId: getWindowId(input) });

  const getRuntimeStatus = input =>
    previewRuntime.ensureInstalled(getWindowId(input), { focus: false });

  const resetRuntime = input =>
    previewRuntime.call(getWindowId(input), 'reset', {});

  const getRuntimeSnapshot = input =>
    previewRuntime
      .call(getWindowId(input), 'snapshot', validateSnapshot(input || {}))
      .then(response => ({
        previewWindowId: response.windowId,
        ...response.result,
      }));

  const sendTouch = input =>
    previewRuntime.call(
      getWindowId(input),
      'touch',
      validateTouch(input || {})
    );

  const sendGamepad = input =>
    previewRuntime.call(
      getWindowId(input),
      'gamepad',
      validateGamepad(input || {})
    );

  const evaluateCondition = async (windowId, condition) => {
    if (!condition) return null;
    const response = await previewRuntime.call(
      windowId,
      'evaluateState',
      normalizeStateCondition(condition)
    );
    return response.result;
  };

  const applyControlClassification = async (
    windowId,
    inspection,
    controlState
  ) => {
    if (!inspection || !inspection.target || !controlState) return inspection;
    const disabled = controlState.disabledWhen
      ? await evaluateCondition(windowId, controlState.disabledWhen)
      : null;
    const legacy = controlState.legacyWhen
      ? await evaluateCondition(windowId, controlState.legacyWhen)
      : null;
    const diagnostics = Array.isArray(inspection.diagnostics)
      ? inspection.diagnostics.slice()
      : [];
    if (disabled && disabled.matched) {
      diagnostics.push({
        code: 'preview_target_disabled',
        message:
          'The explicit runtime-state predicate classifies this target as disabled.',
        state: disabled,
      });
    }
    if (legacy && legacy.matched) {
      diagnostics.push({
        code: 'preview_target_legacy',
        message:
          'The explicit runtime-state predicate classifies this target as legacy.',
        state: legacy,
      });
    }
    return {
      ...inspection,
      diagnostics,
      target: {
        ...inspection.target,
        classification: {
          ...inspection.target.classification,
          disabled: disabled ? disabled.matched : null,
          legacy: legacy ? legacy.matched : null,
          semanticStateAuthority:
            disabled || legacy
              ? 'explicit-runtime-state-condition'
              : inspection.target.classification.semanticStateAuthority,
        },
      },
      controlState: {
        disabled,
        legacy,
      },
    };
  };

  const inspect = async input => {
    const windowId = getWindowId(input);
    const pointRequest = normalizePointRequest({
      target: input && input.target,
      x: input && input.x,
      y: input && input.y,
      coordinateSpace: input && input.coordinateSpace,
      layer: input && input.layer,
    });
    const response = await previewRuntime.call(
      windowId,
      'inspect',
      pointRequest
    );
    const classified = await applyControlClassification(
      response.windowId,
      response.result,
      input && input.controlState
    );
    return {
      previewWindowId: response.windowId,
      ...classified,
    };
  };

  const makeBlockingDiagnosticError = (inspection, { allowOccluded }) => {
    const blockingCodes = new Set([
      'preview_target_not_found',
      'preview_target_hidden',
      'preview_target_layer_hidden',
      'preview_target_not_living',
      'preview_target_not_hit_testable',
      'preview_target_outside_viewport',
      'preview_target_outside_canvas',
    ]);
    const diagnostics = Array.isArray(inspection.diagnostics)
      ? inspection.diagnostics
      : [];
    const blocking = diagnostics.find(
      diagnostic =>
        blockingCodes.has(diagnostic.code) ||
        (!allowOccluded && diagnostic.code === 'preview_target_occluded')
    );
    if (blocking) {
      return makeError(blocking.code, blocking.message || blocking.code, {
        diagnostics,
        target: inspection.target,
        point: inspection.point,
        hitTest: inspection.hitTest,
      });
    }
    if (
      inspection.target &&
      !allowOccluded &&
      (!inspection.hitTest ||
        !inspection.hitTest.owner ||
        !identityMatches(
          inspection.target.identity,
          inspection.hitTest.owner.identity
        ))
    ) {
      return makeError(
        'preview_target_not_hit_owner',
        'The resolved target does not own the dispatched coordinate.',
        {
          target: inspection.target,
          point: inspection.point,
          hitTest: inspection.hitTest,
        }
      );
    }
    return null;
  };

  const inspectAtDispatchedPoint = async (
    windowId,
    initial,
    { controlState } = {}
  ) => {
    if (!initial.point) return initial;
    const response = await previewRuntime.call(windowId, 'inspect', {
      ...(initial.requested && initial.requested.target
        ? { target: initial.requested.target }
        : {}),
      x: Math.round(initial.point.x),
      y: Math.round(initial.point.y),
      coordinateSpace: 'viewport',
    });
    return applyControlClassification(
      response.windowId,
      response.result,
      controlState
    );
  };

  const interact = async input => {
    const windowId = getWindowId(input);
    const action = input && input.action;
    if (!POINTER_ACTIONS.has(action)) {
      throw makeError('invalid_preview_interaction_action', undefined, {
        action,
      });
    }
    const button =
      input && input.button != null ? String(input.button) : 'left';
    if (!MOUSE_BUTTONS.has(button)) {
      throw makeError('invalid_preview_interaction_button', undefined, {
        button,
      });
    }
    const frameTimeoutMs =
      input && input.frameTimeoutMs != null
        ? Number(input.frameTimeoutMs)
        : 1500;
    const frameMaxAnimationFrames =
      input && input.frameMaxAnimationFrames != null
        ? Number(input.frameMaxAnimationFrames)
        : 8;
    if (
      !Number.isInteger(frameTimeoutMs) ||
      frameTimeoutMs < 1 ||
      frameTimeoutMs > 10000 ||
      !Number.isInteger(frameMaxAnimationFrames) ||
      frameMaxAnimationFrames < 1 ||
      frameMaxAnimationFrames > 120
    ) {
      throw makeError('invalid_preview_interaction_frame_sync');
    }

    const sourceRequest = normalizePointRequest({
      target: input && input.target,
      x: input && input.x,
      y: input && input.y,
      coordinateSpace: input && input.coordinateSpace,
      layer: input && input.layer,
    });
    const initialResponse = await previewRuntime.call(
      windowId,
      'inspect',
      sourceRequest
    );
    let before = await applyControlClassification(
      initialResponse.windowId,
      initialResponse.result,
      input && input.controlState
    );
    before = await inspectAtDispatchedPoint(initialResponse.windowId, before, {
      controlState: input && input.controlState,
    });
    const sourceError = makeBlockingDiagnosticError(before, {
      allowOccluded: input && input.allowOccluded === true,
    });
    if (sourceError) throw sourceError;

    const sourcePoint = {
      x: Math.round(before.point.x),
      y: Math.round(before.point.y),
    };
    let destination = null;
    let destinationPoint = null;
    if (action === 'drag') {
      const destinationRequest = normalizePointRequest({
        target: input && input.toTarget,
        x: input && input.toX,
        y: input && input.toY,
        coordinateSpace: input && input.toCoordinateSpace,
        layer: input && input.toLayer,
        prefix: 'to',
      });
      const destinationResponse = await previewRuntime.call(
        windowId,
        'inspect',
        destinationRequest
      );
      destination = await applyControlClassification(
        destinationResponse.windowId,
        destinationResponse.result,
        input && input.toControlState
      );
      destination = await inspectAtDispatchedPoint(
        destinationResponse.windowId,
        destination,
        { controlState: input && input.toControlState }
      );
      const destinationError = makeBlockingDiagnosticError(destination, {
        allowOccluded: input && input.allowDestinationOccluded === true,
      });
      if (destinationError) throw destinationError;
      destinationPoint = {
        x: Math.round(destination.point.x),
        y: Math.round(destination.point.y),
      };
    }

    const dispatched = [];
    const dispatchAndSync = async (phase, event) => {
      const sent = inputTools.sendInput({
        windowId,
        inputEvent: event,
      });
      const synchronized = await previewRuntime.call(windowId, 'synchronize', {
        timeoutMs: frameTimeoutMs,
        maxFrames: frameMaxAnimationFrames,
      });
      if (!synchronized.result.processed) {
        throw makeError(
          'preview_input_frame_timeout',
          'Input was delivered but no processed runtime frame was observed.',
          {
            phase,
            event: sent.event,
            synchronization: synchronized.result,
          }
        );
      }
      const record = {
        phase,
        event: sent.event,
        synchronization: synchronized.result,
      };
      dispatched.push(record);
      return record;
    };

    const moveEvent = point => ({
      type: 'mouseMove',
      x: point.x,
      y: point.y,
    });
    const downEvent = (point, clickCount) => ({
      type: 'mouseDown',
      x: point.x,
      y: point.y,
      button,
      clickCount,
    });
    const upEvent = (point, clickCount) => ({
      type: 'mouseUp',
      x: point.x,
      y: point.y,
      button,
      clickCount,
    });

    await dispatchAndSync('move', moveEvent(sourcePoint));

    if (action === 'press') {
      await dispatchAndSync('press', downEvent(sourcePoint, 1));
    } else if (action === 'release') {
      await dispatchAndSync('release', upEvent(sourcePoint, 1));
    } else if (action === 'click') {
      await dispatchAndSync('press', downEvent(sourcePoint, 1));
      await dispatchAndSync('release', upEvent(sourcePoint, 1));
    } else if (action === 'double-click') {
      await dispatchAndSync('press-1', downEvent(sourcePoint, 1));
      await dispatchAndSync('release-1', upEvent(sourcePoint, 1));
      await dispatchAndSync('press-2', downEvent(sourcePoint, 2));
      await dispatchAndSync('release-2', upEvent(sourcePoint, 2));
    } else if (action === 'drag') {
      await dispatchAndSync('press', downEvent(sourcePoint, 1));
      const dragSteps =
        input && input.dragSteps != null ? Number(input.dragSteps) : 4;
      if (!Number.isInteger(dragSteps) || dragSteps < 1 || dragSteps > 20) {
        throw makeError('invalid_preview_drag_steps', undefined, {
          dragSteps,
        });
      }
      const heldModifier =
        button === 'left'
          ? 'leftButtonDown'
          : button === 'right'
          ? 'rightButtonDown'
          : 'middleButtonDown';
      for (let step = 1; step <= dragSteps; step += 1) {
        const ratio = step / dragSteps;
        await dispatchAndSync(`drag-${step}`, {
          type: 'mouseMove',
          x: Math.round(
            sourcePoint.x + (destinationPoint.x - sourcePoint.x) * ratio
          ),
          y: Math.round(
            sourcePoint.y + (destinationPoint.y - sourcePoint.y) * ratio
          ),
          button,
          modifiers: [heldModifier],
        });
      }
      await dispatchAndSync('release', upEvent(destinationPoint, 1));
    }

    let waitedState = null;
    if (input && input.waitFor) {
      const waitFor = normalizeStateCondition(input.waitFor, { wait: true });
      const response = await previewRuntime.call(
        windowId,
        'waitForState',
        waitFor
      );
      waitedState = response.result;
      if (!waitedState.matched) {
        throw makeError(
          'preview_input_wait_timeout',
          'The requested state was not observed after input.',
          {
            action,
            target: before.target && before.target.identity,
            waitFor,
            result: waitedState,
            dispatched,
          }
        );
      }
    }

    let assertedState = null;
    if (input && input.assertAfter) {
      const assertAfter = normalizeStateCondition(input.assertAfter);
      const response = await previewRuntime.call(
        windowId,
        'evaluateState',
        assertAfter
      );
      assertedState = response.result;
      if (!assertedState.matched) {
        throw makeError(
          'preview_input_assertion_failed',
          'The post-input state assertion failed.',
          {
            action,
            target: before.target && before.target.identity,
            assertAfter,
            result: assertedState,
            dispatched,
          }
        );
      }
    }

    const finalPoint = destinationPoint || sourcePoint;
    const finalTarget =
      destination && destination.requested && destination.requested.target
        ? destination.requested.target
        : before.requested && before.requested.target
        ? before.requested.target
        : null;
    const finalResponse = await previewRuntime.call(windowId, 'inspect', {
      ...(finalTarget ? { target: finalTarget } : {}),
      x: finalPoint.x,
      y: finalPoint.y,
      coordinateSpace: 'viewport',
    });
    const after = await applyControlClassification(
      finalResponse.windowId,
      finalResponse.result,
      destination ? input && input.toControlState : input && input.controlState
    );
    const inputState = inputTools.getInputState({ windowId });

    return {
      action,
      previewWindowId: Number(windowId),
      source: {
        coordinates: {
          x: sourcePoint.x,
          y: sourcePoint.y,
          coordinateSpace: 'viewport-css-px',
        },
        target: before.target,
        hitTest: before.hitTest,
      },
      ...(destination
        ? {
            destination: {
              coordinates: {
                x: destinationPoint.x,
                y: destinationPoint.y,
                coordinateSpace: 'viewport-css-px',
              },
              target: destination.target,
              hitTest: destination.hitTest,
            },
          }
        : {}),
      dispatched,
      inputState,
      observation: {
        hoverOwner: after.hitTest ? after.hitTest.owner : null,
        pressedButtons: inputState.pressedButtons,
        click: {
          dispatched: action === 'click' || action === 'double-click',
          clickCount:
            action === 'double-click' ? 2 : action === 'click' ? 1 : 0,
          effectAuthority:
            waitedState || assertedState
              ? 'runtime-state-observation'
              : 'input-delivery-only',
        },
        waitFor: waitedState,
        assertAfter: assertedState,
      },
      after: {
        hitTest: after.hitTest,
        pointer: after.pointer,
        target: after.target,
        diagnostics: after.diagnostics,
      },
      viewport: after.viewport,
    };
  };

  return {
    sendInput,
    sendSequence,
    resetInput,
    inspect,
    interact,
    getRuntimeStatus,
    getRuntimeSnapshot,
    resetRuntime,
    sendTouch,
    sendGamepad,
  };
};

module.exports = {
  createPreviewInteractionService,
  normalizeSelector,
  normalizeStateCondition,
};
