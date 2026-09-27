const MAX_LAYOUT_TARGETS = 200;
const MAX_LAYOUT_ASSERTIONS = 200;
const MAX_RUNTIME_INSTANCES = 1000;

const makeError = (code, message = code, details) => {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
};

const finite = (value, field) => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw makeError(
      'invalid_preview_layout_input',
      `Invalid finite number for ${field}.`,
      {
        field,
        value,
      }
    );
  }
  return number;
};

const normalizeRect = (value, field = 'region') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw makeError('invalid_preview_layout_region', undefined, { field });
  }
  const x = finite(value.x, `${field}.x`);
  const y = finite(value.y, `${field}.y`);
  const width = finite(value.width, `${field}.width`);
  const height = finite(value.height, `${field}.height`);
  if (width <= 0 || height <= 0) {
    throw makeError('invalid_preview_layout_region', undefined, {
      field,
      reason: 'width_and_height_must_be_positive',
      width,
      height,
    });
  }
  return {
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
  };
};

const rectFromBounds = bounds => {
  if (!bounds || typeof bounds !== 'object') return null;
  const left = Number(bounds.left);
  const top = Number(bounds.top);
  const right = Number(bounds.right);
  const bottom = Number(bounds.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
};

const rectToRegion = rect => ({
  x: rect.left,
  y: rect.top,
  width: rect.width,
  height: rect.height,
});

const intersection = (a, b) => {
  if (!a || !b) return null;
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
};

const contains = (container, child, padding = 0) =>
  !!container &&
  !!child &&
  child.left >= container.left + padding &&
  child.top >= container.top + padding &&
  child.right <= container.right - padding &&
  child.bottom <= container.bottom - padding;

const sameRect = (a, b, epsilon = 0.001) =>
  !!a &&
  !!b &&
  Math.abs(a.left - b.left) <= epsilon &&
  Math.abs(a.top - b.top) <= epsilon &&
  Math.abs(a.right - b.right) <= epsilon &&
  Math.abs(a.bottom - b.bottom) <= epsilon;

const classifyClipping = (bounds, container) => {
  if (!bounds || !container) {
    return {
      status: 'unknown',
      intersection: null,
      clippedEdges: [],
      visibleRatio: null,
    };
  }
  const clipped = intersection(bounds, container);
  if (!clipped) {
    return {
      status: 'offscreen',
      intersection: null,
      clippedEdges: ['left', 'top', 'right', 'bottom'],
      visibleRatio: 0,
    };
  }
  const area = Math.max(0, bounds.width) * Math.max(0, bounds.height);
  const visibleArea = clipped.width * clipped.height;
  const clippedEdges = [];
  if (bounds.left < container.left) clippedEdges.push('left');
  if (bounds.top < container.top) clippedEdges.push('top');
  if (bounds.right > container.right) clippedEdges.push('right');
  if (bounds.bottom > container.bottom) clippedEdges.push('bottom');
  return {
    status: sameRect(bounds, clipped) ? 'inside' : 'partial',
    intersection: clipped,
    clippedEdges,
    visibleRatio:
      area > 0 ? visibleArea / area : sameRect(bounds, clipped) ? 1 : 0,
  };
};

const normalizeRegions = regions => {
  const map = new Map();
  (Array.isArray(regions) ? regions : []).forEach((region, index) => {
    if (
      !region ||
      typeof region.name !== 'string' ||
      !region.name.trim() ||
      map.has(region.name.trim())
    ) {
      throw makeError('invalid_preview_layout_region', undefined, {
        field: `regions[${index}].name`,
        reason: map.has(region && region.name && region.name.trim())
          ? 'duplicate_name'
          : 'name_required',
      });
    }
    const name = region.name.trim();
    map.set(name, {
      name,
      bounds: normalizeRect(region, `regions[${index}]`),
    });
  });
  return map;
};

const normalizeTarget = (target, index) => {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw makeError('invalid_preview_layout_target', undefined, { index });
  }
  const id =
    typeof target.id === 'string' && target.id.trim()
      ? target.id.trim()
      : `target-${index + 1}`;
  const kind =
    target.kind === 'layer' || target.kind === 'region'
      ? target.kind
      : 'object';
  if (kind === 'object') {
    const objectName =
      typeof target.objectName === 'string' && target.objectName.trim()
        ? target.objectName.trim()
        : null;
    const hasInstanceId =
      target.instanceId !== undefined && target.instanceId !== null;
    const instanceId = hasInstanceId ? Number(target.instanceId) : null;
    const instanceIndex =
      target.instanceIndex == null ? 0 : Number(target.instanceIndex);
    if (!objectName && !hasInstanceId) {
      throw makeError('invalid_preview_layout_target', undefined, {
        index,
        id,
        reason: 'objectName_or_instanceId_required',
      });
    }
    if (hasInstanceId && (!Number.isInteger(instanceId) || instanceId < 0)) {
      throw makeError('invalid_preview_layout_target', undefined, {
        index,
        id,
        field: 'instanceId',
      });
    }
    if (!Number.isInteger(instanceIndex) || instanceIndex < 0) {
      throw makeError('invalid_preview_layout_target', undefined, {
        index,
        id,
        field: 'instanceIndex',
      });
    }
    return {
      id,
      kind,
      ...(objectName ? { objectName } : {}),
      ...(hasInstanceId ? { instanceId } : {}),
      instanceIndex,
    };
  }
  if (kind === 'layer') {
    if (typeof target.layer !== 'string' || !target.layer.trim()) {
      throw makeError('invalid_preview_layout_target', undefined, {
        index,
        id,
        reason: 'layer_required',
      });
    }
    return {
      id,
      kind,
      layer: target.layer.trim(),
      includeHidden: target.includeHidden !== false,
    };
  }
  if (typeof target.region !== 'string' || !target.region.trim()) {
    throw makeError('invalid_preview_layout_target', undefined, {
      index,
      id,
      reason: 'region_required',
    });
  }
  return { id, kind, region: target.region.trim() };
};

const snapshotEntries = snapshot => {
  const entries = [];
  const objects =
    snapshot && snapshot.objects && typeof snapshot.objects === 'object'
      ? snapshot.objects
      : {};
  Object.keys(objects).forEach(objectName => {
    const item = objects[objectName];
    const instances =
      item && Array.isArray(item.instances) ? item.instances : [];
    instances.forEach((instance, instanceIndex) => {
      entries.push({ objectName, instanceIndex, instance });
    });
  });
  return entries;
};

const snapshotEntryForIdentity = (entries, identity) => {
  if (!identity) return null;
  return (
    entries.find(
      entry =>
        entry.objectName === identity.objectName &&
        identity.instanceId != null &&
        Number(entry.instance && entry.instance.id) ===
          Number(identity.instanceId)
    ) ||
    entries.find(
      entry =>
        entry.objectName === identity.objectName &&
        entry.instanceIndex === identity.instanceIndex
    ) ||
    null
  );
};

const viewportRectFromMetrics = viewport =>
  viewport &&
  Number.isFinite(Number(viewport.width)) &&
  Number.isFinite(Number(viewport.height))
    ? {
        left: 0,
        top: 0,
        right: Number(viewport.width),
        bottom: Number(viewport.height),
        width: Number(viewport.width),
        height: Number(viewport.height),
      }
    : null;

const canvasRectFromMetrics = viewport => {
  if (!viewport || !viewport.canvas) return null;
  const width = Number(viewport.canvas.width);
  const height = Number(viewport.canvas.height);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return null;
  return normalizeRect(
    {
      x: viewport.canvas.x,
      y: viewport.canvas.y,
      width,
      height,
    },
    'viewport.canvas'
  );
};

const targetSummary = target => ({
  targetId: target.targetId,
  selectorId: target.selectorId,
  kind: target.kind,
  identity: target.identity || null,
  bounds: target.bounds ? target.bounds.viewport : null,
  visible:
    target.visibility && typeof target.visibility.visible === 'boolean'
      ? target.visibility.visible
      : true,
});

const createViolation = ({
  assertion,
  code,
  message,
  targets = [],
  intersectionRect = null,
  expected = null,
  actual = null,
  details = null,
}) => ({
  assertionId: assertion.id,
  type: assertion.type,
  code,
  severity:
    assertion.severity === 'warning' || assertion.severity === 'info'
      ? assertion.severity
      : 'error',
  message,
  targets: targets.map(targetSummary),
  intersection: intersectionRect,
  expected,
  actual,
  details,
});

const createPreviewLayoutService = ({
  previewInteractionService,
  windowCaptureService,
}) => {
  const capabilities = () => ({
    version: 1,
    coordinateSpace: 'viewport-css-px',
    selectors: {
      object: {
        supported: true,
        fields: ['objectName', 'instanceId', 'instanceIndex'],
        authority: 'preview.input.inspect',
      },
      layer: {
        supported: true,
        authority: 'runtime.snapshot + preview.input.inspect',
      },
      namedRegion: {
        supported: true,
        authority: 'caller-declared-region',
      },
    },
    geometry: {
      transformedBounds: true,
      sceneBounds: true,
      viewportBounds: true,
      hitBoxes: true,
      visibility: true,
      viewportClipping: true,
      canvasClipping: true,
    },
    assertions: [
      'visible',
      'not-clipped',
      'within',
      'no-overlap',
      'min-gap',
      'align',
      'safe-area',
      'text-fit',
    ],
    hiddenObjects: {
      exposed: true,
      overlapAssertionsExcludeByDefault: true,
    },
    textFit: {
      supported: true,
      authority:
        'runtime text object visual/transformed bounds compared with target/container bounds',
      requiresRuntimeTextGetter: true,
    },
    capture: {
      command: 'preview.capture.region',
      explicitRectangle: true,
      runtimeObjectBounds: true,
      returnsActualRegion: true,
    },
    visualQaIntegration: {
      complements: [
        'preview.visual.baseline.capture',
        'preview.visual.baseline.compare',
      ],
      replacesPerceptualReview: false,
    },
  });

  const resolveLayout = async input => {
    const previewWindowId = Number(input && input.previewWindowId);
    if (!Number.isInteger(previewWindowId) || previewWindowId <= 0) {
      throw makeError('invalid_preview_layout_input', undefined, {
        field: 'previewWindowId',
      });
    }
    const rawTargets = Array.isArray(input && input.targets)
      ? input.targets
      : [];
    if (!rawTargets.length || rawTargets.length > MAX_LAYOUT_TARGETS) {
      throw makeError('invalid_preview_layout_input', undefined, {
        field: 'targets',
        minItems: 1,
        maxItems: MAX_LAYOUT_TARGETS,
      });
    }
    const targets = rawTargets.map(normalizeTarget);
    const ids = new Set();
    targets.forEach(target => {
      if (ids.has(target.id)) {
        throw makeError('invalid_preview_layout_target', undefined, {
          id: target.id,
          reason: 'duplicate_id',
        });
      }
      ids.add(target.id);
    });
    const regions = normalizeRegions(input && input.regions);
    const maxInstances =
      input && input.maxInstances != null
        ? Number(input.maxInstances)
        : MAX_RUNTIME_INSTANCES;
    if (
      !Number.isInteger(maxInstances) ||
      maxInstances < 1 ||
      maxInstances > MAX_RUNTIME_INSTANCES
    ) {
      throw makeError('invalid_preview_layout_input', undefined, {
        field: 'maxInstances',
        value: input && input.maxInstances,
      });
    }

    const needsSnapshot = targets.some(
      target => target.kind === 'object' || target.kind === 'layer'
    );
    const snapshot = needsSnapshot
      ? await previewInteractionService.getRuntimeSnapshot({
          previewWindowId,
          maxInstances,
        })
      : null;
    const entries = snapshotEntries(snapshot);
    const resolved = [];
    const unresolved = [];
    let viewport = null;

    const addInspected = async (selectorTarget, objectSelector, targetId) => {
      const inspection = await previewInteractionService.inspect({
        previewWindowId,
        target: objectSelector,
      });
      viewport = viewport || inspection.viewport || null;
      if (!inspection.target) {
        unresolved.push({
          targetId,
          selectorId: selectorTarget.id,
          selector: selectorTarget,
          code: 'preview_layout_target_not_found',
        });
        return;
      }
      const geometry = inspection.target;
      const snap = snapshotEntryForIdentity(entries, geometry.identity);
      const viewportBounds = rectFromBounds(
        geometry.viewport && geometry.viewport.bounds
      );
      const sceneBounds = rectFromBounds(
        geometry.scene && geometry.scene.bounds
      );
      const viewportRect = viewportRectFromMetrics(inspection.viewport);
      const canvasRect = canvasRectFromMetrics(inspection.viewport);
      resolved.push({
        targetId,
        selectorId: selectorTarget.id,
        kind: 'object',
        selector: selectorTarget,
        identity: geometry.identity,
        bounds: {
          scene: sceneBounds,
          viewport: viewportBounds,
          transformedViewport: viewportBounds,
        },
        hitBoxes: {
          scene:
            geometry.scene && Array.isArray(geometry.scene.hitBoxes)
              ? geometry.scene.hitBoxes
              : [],
          viewport:
            geometry.viewport && Array.isArray(geometry.viewport.hitBoxes)
              ? geometry.viewport.hitBoxes
              : [],
        },
        visibility: geometry.state || null,
        classification: geometry.classification || null,
        clipping: {
          viewport: classifyClipping(viewportBounds, viewportRect),
          canvas: classifyClipping(viewportBounds, canvasRect || viewportRect),
        },
        runtime: snap
          ? {
              type:
                snap.instance && snap.instance.type != null
                  ? snap.instance.type
                  : geometry.identity.type || null,
              ...(snap.instance &&
              Object.prototype.hasOwnProperty.call(snap.instance, 'text')
                ? { text: snap.instance.text }
                : {}),
              hidden: !!(snap.instance && snap.instance.hidden),
              livingOnScene:
                !snap.instance || snap.instance.livingOnScene !== false,
            }
          : {
              type: geometry.identity.type || null,
            },
      });
    };

    for (const target of targets) {
      if (target.kind === 'region') {
        const region = regions.get(target.region);
        if (!region) {
          unresolved.push({
            targetId: target.id,
            selectorId: target.id,
            selector: target,
            code: 'preview_layout_region_not_found',
          });
          continue;
        }
        resolved.push({
          targetId: target.id,
          selectorId: target.id,
          kind: 'region',
          selector: target,
          identity: { region: region.name },
          bounds: {
            scene: null,
            viewport: region.bounds,
            transformedViewport: region.bounds,
          },
          hitBoxes: { scene: [], viewport: [] },
          visibility: { visible: true },
          classification: { presentationSurface: 'declared-region' },
          clipping: {
            viewport: {
              status: 'unknown',
              intersection: null,
              clippedEdges: [],
            },
            canvas: { status: 'unknown', intersection: null, clippedEdges: [] },
          },
          runtime: null,
        });
        continue;
      }

      if (target.kind === 'object') {
        await addInspected(
          target,
          {
            ...(target.objectName ? { objectName: target.objectName } : {}),
            ...(target.instanceId != null
              ? { instanceId: target.instanceId }
              : {}),
            instanceIndex: target.instanceIndex,
          },
          target.id
        );
        continue;
      }

      const matches = entries.filter(entry => {
        if (!entry.instance || entry.instance.layer !== target.layer)
          return false;
        if (!target.includeHidden && entry.instance.hidden) return false;
        return entry.instance.livingOnScene !== false;
      });
      if (!matches.length) {
        unresolved.push({
          targetId: target.id,
          selectorId: target.id,
          selector: target,
          code: 'preview_layout_layer_empty',
        });
        continue;
      }
      let member = 0;
      for (const match of matches) {
        member += 1;
        await addInspected(
          target,
          {
            objectName: match.objectName,
            instanceId: match.instance && match.instance.id,
            instanceIndex: match.instanceIndex,
          },
          `${target.id}[${member}]`
        );
      }
    }

    if (!viewport) {
      const firstObject = resolved.find(target => target.kind === 'object');
      const inspection = await previewInteractionService.inspect({
        previewWindowId,
        ...(firstObject
          ? {
              target: {
                objectName: firstObject.identity.objectName,
                instanceId: firstObject.identity.instanceId,
              },
            }
          : {}),
      });
      viewport = inspection.viewport || null;
    }

    if (viewport) {
      const viewportRect = viewportRectFromMetrics(viewport);
      const canvasRect = canvasRectFromMetrics(viewport);
      resolved
        .filter(target => target.kind === 'region')
        .forEach(target => {
          target.clipping = {
            viewport: classifyClipping(target.bounds.viewport, viewportRect),
            canvas: classifyClipping(
              target.bounds.viewport,
              canvasRect || viewportRect
            ),
          };
        });
    }

    const diagnostics = [];
    if (snapshot && Number(snapshot.truncatedInstances) > 0) {
      diagnostics.push({
        code: 'preview_layout_snapshot_truncated',
        truncatedInstances: Number(snapshot.truncatedInstances),
        includedInstances: Number(snapshot.includedInstances) || 0,
        maxInstances,
      });
    }
    unresolved.forEach(item => diagnostics.push({ ...item }));

    return {
      previewWindowId,
      coordinateSpace: 'viewport-css-px',
      viewport,
      scene:
        snapshot && snapshot.scene
          ? {
              name: snapshot.scene.name || null,
              elapsedTimeMs: snapshot.scene.elapsedTimeMs,
              timeFromStartMs: snapshot.scene.timeFromStartMs,
            }
          : null,
      snapshotComplete: !(snapshot && Number(snapshot.truncatedInstances) > 0),
      targets: resolved,
      unresolved,
      diagnostics,
    };
  };

  const inspect = async input => ({
    ...(await resolveLayout(input || {})),
    capabilities: {
      clippingStatuses: ['inside', 'partial', 'offscreen', 'unknown'],
      transformedBoundsAuthority: 'runtime-hitbox-aabb-in-viewport-css-px',
    },
  });

  const assert = async input => {
    const assertions = Array.isArray(input && input.assertions)
      ? input.assertions
      : [];
    if (!assertions.length || assertions.length > MAX_LAYOUT_ASSERTIONS) {
      throw makeError('invalid_preview_layout_input', undefined, {
        field: 'assertions',
        minItems: 1,
        maxItems: MAX_LAYOUT_ASSERTIONS,
      });
    }
    const layout = await resolveLayout(input || {});
    const violations = [];
    const results = [];
    const regions = normalizeRegions(input && input.regions);

    const matchingTargets = refs => {
      const wanted = Array.isArray(refs)
        ? refs.filter(value => typeof value === 'string' && value)
        : [];
      const items = wanted.length
        ? layout.targets.filter(
            target =>
              wanted.includes(target.targetId) ||
              wanted.includes(target.selectorId)
          )
        : layout.targets.filter(target => target.kind === 'object');
      return items;
    };

    const rectForContainer = assertion => {
      if (
        typeof assertion.region === 'string' &&
        regions.has(assertion.region)
      ) {
        return {
          rect: regions.get(assertion.region).bounds,
          target: null,
          identity: { region: assertion.region },
        };
      }
      if (typeof assertion.container === 'string') {
        const matches = matchingTargets([assertion.container]);
        if (matches.length === 1) {
          return {
            rect: matches[0].bounds.viewport,
            target: matches[0],
            identity: matches[0].identity,
          };
        }
      }
      return null;
    };

    const allowedPair = (assertion, a, b) => {
      const pairs = Array.isArray(assertion.allowPairs)
        ? assertion.allowPairs
        : [];
      const aliasesA = new Set([a.targetId, a.selectorId]);
      const aliasesB = new Set([b.targetId, b.selectorId]);
      return pairs.some(pair => {
        if (!Array.isArray(pair) || pair.length !== 2) return false;
        return (
          (aliasesA.has(pair[0]) && aliasesB.has(pair[1])) ||
          (aliasesA.has(pair[1]) && aliasesB.has(pair[0]))
        );
      });
    };

    assertions.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw makeError('invalid_preview_layout_assertion', undefined, {
          index,
        });
      }
      const assertion = {
        ...raw,
        id:
          typeof raw.id === 'string' && raw.id.trim()
            ? raw.id.trim()
            : `assertion-${index + 1}`,
        type: typeof raw.type === 'string' ? raw.type : '',
      };
      const ownViolations = [];
      const selected = matchingTargets(raw.targets);
      const visibleSelected =
        raw.includeHidden === true
          ? selected
          : selected.filter(
              target =>
                !target.visibility || target.visibility.visible !== false
            );

      if (assertion.type === 'visible') {
        selected.forEach(target => {
          if (!target.visibility || target.visibility.visible !== true) {
            ownViolations.push(
              createViolation({
                assertion,
                code: 'preview_layout_not_visible',
                message: 'Runtime target is not visibly presented.',
                targets: [target],
                expected: { visible: true },
                actual: target.visibility || null,
              })
            );
          }
        });
      } else if (assertion.type === 'not-clipped') {
        const scope = assertion.scope === 'canvas' ? 'canvas' : 'viewport';
        selected.forEach(target => {
          const clipping = target.clipping && target.clipping[scope];
          if (!clipping || clipping.status !== 'inside') {
            ownViolations.push(
              createViolation({
                assertion,
                code:
                  clipping && clipping.status === 'offscreen'
                    ? 'preview_layout_offscreen'
                    : 'preview_layout_clipped',
                message:
                  clipping && clipping.status === 'offscreen'
                    ? `Runtime target is outside the ${scope}.`
                    : `Runtime target is clipped by the ${scope}.`,
                targets: [target],
                expected: { clipping: 'inside', scope },
                actual: clipping || null,
              })
            );
          }
        });
      } else if (assertion.type === 'within') {
        const container = rectForContainer(assertion);
        const padding =
          assertion.padding == null ? 0 : finite(assertion.padding, 'padding');
        if (!container || !container.rect) {
          ownViolations.push(
            createViolation({
              assertion,
              code: 'preview_layout_container_not_found',
              message: 'The requested layout container could not be resolved.',
            })
          );
        } else {
          selected.forEach(target => {
            if (!contains(container.rect, target.bounds.viewport, padding)) {
              ownViolations.push(
                createViolation({
                  assertion,
                  code: 'preview_layout_overflow',
                  message:
                    'Runtime target exceeds the declared container or region boundary.',
                  targets: container.target
                    ? [target, container.target]
                    : [target],
                  intersectionRect: intersection(
                    target.bounds.viewport,
                    container.rect
                  ),
                  expected: {
                    within: container.identity,
                    padding,
                  },
                  actual: { bounds: target.bounds.viewport },
                })
              );
            }
          });
        }
      } else if (assertion.type === 'no-overlap') {
        for (let i = 0; i < visibleSelected.length; i++) {
          for (let j = i + 1; j < visibleSelected.length; j++) {
            const a = visibleSelected[i];
            const b = visibleSelected[j];
            if (allowedPair(assertion, a, b)) continue;
            const overlap = intersection(a.bounds.viewport, b.bounds.viewport);
            if (!overlap) continue;
            ownViolations.push(
              createViolation({
                assertion,
                code: 'preview_layout_overlap',
                message: 'Runtime targets overlap.',
                targets: [a, b],
                intersectionRect: overlap,
              })
            );
          }
        }
      } else if (assertion.type === 'min-gap') {
        const axis = assertion.axis === 'vertical' ? 'vertical' : 'horizontal';
        const minimum = finite(assertion.minimum, 'minimum');
        const sorted = visibleSelected
          .slice()
          .sort((a, b) =>
            axis === 'horizontal'
              ? a.bounds.viewport.left - b.bounds.viewport.left
              : a.bounds.viewport.top - b.bounds.viewport.top
          );
        for (let i = 1; i < sorted.length; i++) {
          const before = sorted[i - 1];
          const after = sorted[i];
          const gap =
            axis === 'horizontal'
              ? after.bounds.viewport.left - before.bounds.viewport.right
              : after.bounds.viewport.top - before.bounds.viewport.bottom;
          if (gap >= minimum) continue;
          ownViolations.push(
            createViolation({
              assertion,
              code: 'preview_layout_gap_too_small',
              message: 'Adjacent runtime targets violate the minimum gap.',
              targets: [before, after],
              expected: { minimum, axis },
              actual: { gap },
            })
          );
        }
      } else if (assertion.type === 'align') {
        const edge = [
          'left',
          'right',
          'top',
          'bottom',
          'center-x',
          'center-y',
        ].includes(assertion.edge)
          ? assertion.edge
          : 'left';
        const tolerance =
          assertion.tolerance == null
            ? 0
            : Math.max(0, finite(assertion.tolerance, 'tolerance'));
        const valueFor = target => {
          const bounds = target.bounds.viewport;
          if (edge === 'left') return bounds.left;
          if (edge === 'right') return bounds.right;
          if (edge === 'top') return bounds.top;
          if (edge === 'bottom') return bounds.bottom;
          if (edge === 'center-x') return (bounds.left + bounds.right) / 2;
          return (bounds.top + bounds.bottom) / 2;
        };
        if (visibleSelected.length > 1) {
          const anchor = visibleSelected[0];
          const anchorValue = valueFor(anchor);
          visibleSelected.slice(1).forEach(target => {
            const actual = valueFor(target);
            if (Math.abs(actual - anchorValue) <= tolerance) return;
            ownViolations.push(
              createViolation({
                assertion,
                code: 'preview_layout_alignment_mismatch',
                message: 'Runtime targets are not aligned within tolerance.',
                targets: [anchor, target],
                expected: { edge, value: anchorValue, tolerance },
                actual: { value: actual, delta: actual - anchorValue },
              })
            );
          });
        }
      } else if (assertion.type === 'safe-area') {
        const container = rectForContainer(assertion);
        if (!container || !container.rect) {
          ownViolations.push(
            createViolation({
              assertion,
              code: 'preview_layout_safe_area_not_found',
              message: 'The requested safe area could not be resolved.',
            })
          );
        } else {
          const relation =
            assertion.relation === 'inside' ? 'inside' : 'outside';
          selected.forEach(target => {
            const overlap = intersection(
              target.bounds.viewport,
              container.rect
            );
            const failed =
              relation === 'inside'
                ? !contains(container.rect, target.bounds.viewport, 0)
                : !!overlap;
            if (!failed) return;
            ownViolations.push(
              createViolation({
                assertion,
                code:
                  relation === 'inside'
                    ? 'preview_layout_safe_area_escape'
                    : 'preview_layout_safe_area_intrusion',
                message:
                  relation === 'inside'
                    ? 'Runtime target escapes the required safe area.'
                    : 'Runtime target intrudes into a protected safe area.',
                targets: container.target
                  ? [target, container.target]
                  : [target],
                intersectionRect: overlap,
                expected: { relation, safeArea: container.identity },
              })
            );
          });
        }
      } else if (assertion.type === 'text-fit') {
        const textRefs =
          typeof assertion.textTarget === 'string'
            ? [assertion.textTarget]
            : raw.targets;
        const textTargets = matchingTargets(textRefs);
        const container = rectForContainer(assertion);
        const padding =
          assertion.padding == null ? 0 : finite(assertion.padding, 'padding');
        if (!container || !container.rect) {
          ownViolations.push(
            createViolation({
              assertion,
              code: 'preview_layout_container_not_found',
              message: 'The text-fit container could not be resolved.',
            })
          );
        } else {
          textTargets.forEach(target => {
            const hasRuntimeText =
              target.runtime &&
              Object.prototype.hasOwnProperty.call(target.runtime, 'text');
            if (!hasRuntimeText) {
              ownViolations.push(
                createViolation({
                  assertion,
                  code: 'preview_layout_text_measurement_unavailable',
                  message:
                    'The selected runtime object does not expose text content; text-fit cannot be asserted from runtime visual bounds.',
                  targets: [target],
                  details: {
                    authority: 'runtime-object-transformed-bounds',
                  },
                })
              );
              return;
            }
            if (!contains(container.rect, target.bounds.viewport, padding)) {
              ownViolations.push(
                createViolation({
                  assertion,
                  code: 'preview_layout_text_overflow',
                  message:
                    'Rendered runtime text bounds exceed the declared container.',
                  targets: container.target
                    ? [target, container.target]
                    : [target],
                  intersectionRect: intersection(
                    target.bounds.viewport,
                    container.rect
                  ),
                  expected: {
                    within: container.identity,
                    padding,
                  },
                  actual: {
                    bounds: target.bounds.viewport,
                    text: target.runtime.text,
                  },
                  details: {
                    authority: 'runtime-object-transformed-bounds',
                  },
                })
              );
            }
          });
        }
      } else {
        throw makeError('invalid_preview_layout_assertion', undefined, {
          index,
          id: assertion.id,
          type: assertion.type,
        });
      }

      violations.push(...ownViolations);
      results.push({
        id: assertion.id,
        type: assertion.type,
        passed: ownViolations.length === 0,
        violationCount: ownViolations.length,
        violations: ownViolations,
      });
    });

    layout.unresolved.forEach(item => {
      const assertion = {
        id: 'target-resolution',
        type: 'resolve',
        severity: 'error',
      };
      violations.push(
        createViolation({
          assertion,
          code: item.code,
          message: 'A requested runtime layout target could not be resolved.',
          details: item,
        })
      );
    });

    return {
      previewWindowId: layout.previewWindowId,
      passed: violations.length === 0,
      summary: {
        assertions: results.length,
        passed: results.filter(result => result.passed).length,
        failed: results.filter(result => !result.passed).length,
        violations: violations.length,
      },
      viewport: layout.viewport,
      scene: layout.scene,
      snapshotComplete: layout.snapshotComplete,
      targets: layout.targets,
      assertions: results,
      violations,
      diagnostics: layout.diagnostics,
    };
  };

  const captureRegion = async input => {
    const previewWindowId = Number(input && input.previewWindowId);
    if (!Number.isInteger(previewWindowId) || previewWindowId <= 0) {
      throw makeError('invalid_preview_layout_input', undefined, {
        field: 'previewWindowId',
      });
    }
    const hasTarget = !!(input && input.target);
    const hasRegion = !!(input && input.region);
    if (hasTarget === hasRegion) {
      throw makeError('invalid_preview_capture_region', undefined, {
        reason: 'provide_exactly_one_of_target_or_region',
      });
    }

    let requestedBounds;
    let target = null;
    let viewport = null;
    if (hasTarget) {
      const normalized = normalizeTarget(
        {
          id: 'capture-target',
          kind: 'object',
          ...input.target,
        },
        0
      );
      const inspected = await resolveLayout({
        previewWindowId,
        targets: [normalized],
        maxInstances:
          input.maxInstances == null
            ? MAX_RUNTIME_INSTANCES
            : input.maxInstances,
      });
      if (!inspected.targets.length) {
        throw makeError('preview_capture_target_not_found', undefined, {
          target: input.target,
          diagnostics: inspected.diagnostics,
        });
      }
      target = inspected.targets[0];
      requestedBounds = target.bounds.viewport;
      viewport = inspected.viewport;
    } else {
      requestedBounds = normalizeRect(input.region, 'region');
      const probe = await previewInteractionService.inspect({
        previewWindowId,
      });
      viewport = probe.viewport || null;
    }

    const padding =
      input && input.padding != null
        ? Math.max(0, finite(input.padding, 'padding'))
        : 0;
    let padded = {
      left: requestedBounds.left - padding,
      top: requestedBounds.top - padding,
      right: requestedBounds.right + padding,
      bottom: requestedBounds.bottom + padding,
      width: requestedBounds.width + padding * 2,
      height: requestedBounds.height + padding * 2,
    };
    const viewportRect = viewportRectFromMetrics(viewport);
    const clampToViewport = !input || input.clampToViewport !== false;
    if (clampToViewport && viewportRect) {
      const clipped = intersection(padded, viewportRect);
      if (!clipped) {
        throw makeError('preview_capture_region_offscreen', undefined, {
          requestedRegion: rectToRegion(padded),
          viewport: rectToRegion(viewportRect),
        });
      }
      padded = clipped;
    }

    const x = Math.max(0, Math.floor(padded.left));
    const y = Math.max(0, Math.floor(padded.top));
    const right = Math.ceil(padded.right);
    const bottom = Math.ceil(padded.bottom);
    if (right <= x || bottom <= y) {
      throw makeError('preview_capture_region_empty');
    }
    const actualRegion = {
      x,
      y,
      width: right - x,
      height: bottom - y,
    };
    const captured = await windowCaptureService.capture({
      windowId: previewWindowId,
      region: actualRegion,
      maxWidth: input && input.maxWidth,
      maxHeight: input && input.maxHeight,
      captureAttempts: input && input.captureAttempts,
      retryDelayMs: input && input.retryDelayMs,
      readyTimeoutMs: input && input.readyTimeoutMs,
    });

    return {
      previewWindowId,
      mimeType: captured.mimeType || 'image/png',
      coordinateSpace: 'viewport-css-px',
      source: target
        ? {
            kind: 'runtime-object',
            target: targetSummary(target),
          }
        : { kind: 'explicit-region' },
      requestedRegion: rectToRegion(requestedBounds),
      paddedRegion: rectToRegion({
        left: requestedBounds.left - padding,
        top: requestedBounds.top - padding,
        right: requestedBounds.right + padding,
        bottom: requestedBounds.bottom + padding,
        width: requestedBounds.width + padding * 2,
        height: requestedBounds.height + padding * 2,
      }),
      actualRegion,
      clampedToViewport:
        clampToViewport &&
        (actualRegion.x !== Math.floor(requestedBounds.left - padding) ||
          actualRegion.y !== Math.floor(requestedBounds.top - padding) ||
          actualRegion.width !==
            Math.ceil(requestedBounds.right + padding) -
              Math.floor(requestedBounds.left - padding) ||
          actualRegion.height !==
            Math.ceil(requestedBounds.bottom + padding) -
              Math.floor(requestedBounds.top - padding)),
      viewport,
      captureMethod: captured.captureMethod,
      attempts: captured.attempts,
      readiness: captured.readiness,
      outputSize: captured.outputSize || captured.sourceSize || null,
      imageBuffer: captured.data,
    };
  };

  return {
    capabilities,
    inspect,
    assert,
    captureRegion,
  };
};

module.exports = {
  createPreviewLayoutService,
  classifyClipping,
  intersection,
  normalizeRect,
};
