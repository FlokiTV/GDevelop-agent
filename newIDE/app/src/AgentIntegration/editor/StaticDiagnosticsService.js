// @flow
import { AgentError } from '../core/AgentError';

const STATIC_DOMAIN = 'static-editor-project';
const SEVERITIES = ['error', 'warning', 'info'];

const encodePart = (value: any): string =>
  encodeURIComponent(value == null ? '' : String(value));

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const samePath = (left: any, right: any): boolean =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const asArray = (value: any): Array<any> => (Array.isArray(value) ? value : []);

const makeProjectSelector = (projectUuid: string): string =>
  'project:' + encodePart(projectUuid);

const makeFunctionSelector = ({
  extensionName,
  ownerKind,
  ownerName,
  functionName,
}: any): string =>
  [
    'extension-function',
    encodePart(extensionName),
    encodePart(ownerKind || 'extension'),
    encodePart(ownerName || ''),
    encodePart(functionName),
  ].join(':');

const flattenInstructions = (instructions: Array<any>): Array<any> => {
  const flattened = [];
  const visit = items => {
    asArray(items).forEach(item => {
      flattened.push(item);
      visit(item && item.children);
    });
  };
  visit(instructions);
  return flattened;
};

const findEventByPath = (events: Array<any>, eventPath: any): ?any => {
  let found = null;
  const visit = nodes => {
    asArray(nodes).forEach(node => {
      if (found) return;
      if (samePath(node && node.path, eventPath)) {
        found = node;
        return;
      }
      visit(node && node.children);
    });
  };
  visit(events);
  return found;
};

const summarize = (diagnostics: Array<any>) => {
  const errors = diagnostics.filter(item => item.severity === 'error').length;
  const warnings = diagnostics.filter(item => item.severity === 'warning')
    .length;
  const info = diagnostics.filter(item => item.severity === 'info').length;
  return {
    total: diagnostics.length,
    errors,
    warnings,
    info,
    clean: errors === 0 && warnings === 0,
  };
};

const normalizeSourceRange = (details: any): ?any => {
  if (!details || typeof details !== 'object') return null;
  if (details.sourceRange && typeof details.sourceRange === 'object') {
    return details.sourceRange;
  }
  if (Number.isInteger(details.line) || Number.isInteger(details.column)) {
    return {
      start: {
        line: Number.isInteger(details.line) ? details.line : null,
        column: Number.isInteger(details.column) ? details.column : null,
      },
      end:
        Number.isInteger(details.endLine) || Number.isInteger(details.endColumn)
          ? {
              line: Number.isInteger(details.endLine) ? details.endLine : null,
              column: Number.isInteger(details.endColumn)
                ? details.endColumn
                : null,
            }
          : null,
    };
  }
  return null;
};

const inferOwnerKind = (details: any): string =>
  details && details.behaviorName
    ? 'behavior'
    : details && details.objectName
    ? 'object'
    : 'extension';

const eventTargetFromIssue = (issue: any): ?any => {
  const details = issue.details || {};
  if (details.locationType === 'scene' && details.locationName) {
    return { kind: 'scene', sceneName: details.locationName };
  }
  if (details.locationType === 'external-events' && details.locationName) {
    return {
      kind: 'external-events',
      externalEventsName: details.locationName,
    };
  }
  if (
    details.locationType === 'extension' &&
    details.extensionName &&
    details.functionName
  ) {
    const ownerKind = inferOwnerKind(details);
    return {
      kind: 'extension-function',
      extensionName: details.extensionName,
      ownerKind,
      ...(ownerKind === 'behavior'
        ? { ownerName: details.behaviorName }
        : ownerKind === 'object'
        ? { ownerName: details.objectName }
        : {}),
      functionName: details.functionName,
    };
  }
  return null;
};

const makeScope = ({ issue, projectIdentity }: any): any => {
  const details = issue.details || {};
  const sceneName =
    issue.sceneName ||
    (details.locationType === 'scene' ? details.locationName : null);
  if (sceneName) {
    const scene = asArray(projectIdentity.scenes).find(
      item => item.sceneName === sceneName
    );
    return {
      kind: 'scene',
      name: sceneName,
      selector: scene ? scene.selector : null,
      identity: scene || { sceneName, identityKind: 'name-fallback' },
    };
  }

  if (details.locationType === 'external-events' && details.locationName) {
    const externalEvents = asArray(projectIdentity.externalEvents).find(
      item => item.externalEventsName === details.locationName
    );
    return {
      kind: 'external-events',
      name: details.locationName,
      selector: externalEvents ? externalEvents.selector : null,
      identity: externalEvents || {
        externalEventsName: details.locationName,
        identityKind: 'name-fallback',
      },
    };
  }

  if (
    details.locationType === 'extension' &&
    details.extensionName &&
    details.functionName
  ) {
    const ownerKind = inferOwnerKind(details);
    const ownerName =
      ownerKind === 'behavior'
        ? details.behaviorName
        : ownerKind === 'object'
        ? details.objectName
        : null;
    return {
      kind: 'extension-function',
      name: details.functionName,
      selector: makeFunctionSelector({
        extensionName: details.extensionName,
        ownerKind,
        ownerName,
        functionName: details.functionName,
      }),
      identity: {
        extensionName: details.extensionName,
        ownerKind,
        ownerName,
        functionName: details.functionName,
      },
    };
  }

  return {
    kind: 'project',
    name: projectIdentity.projectName,
    selector: makeProjectSelector(projectIdentity.projectUuid),
    identity: {
      projectUuid: projectIdentity.projectUuid,
      projectName: projectIdentity.projectName,
    },
  };
};

const matchesFilter = (diagnostic: any, request: any): boolean => {
  if (
    Array.isArray(request.severities) &&
    request.severities.length &&
    !request.severities.includes(diagnostic.severity)
  ) {
    return false;
  }
  if (
    Array.isArray(request.codes) &&
    request.codes.length &&
    !request.codes.includes(diagnostic.code)
  ) {
    return false;
  }
  if (
    Array.isArray(request.scopes) &&
    request.scopes.length &&
    !request.scopes.includes(
      diagnostic.primaryLocation &&
        diagnostic.primaryLocation.scope &&
        diagnostic.primaryLocation.scope.kind
    )
  ) {
    return false;
  }
  if (
    typeof request.sceneName === 'string' &&
    request.sceneName &&
    (!diagnostic.primaryLocation ||
      !diagnostic.primaryLocation.scope ||
      diagnostic.primaryLocation.scope.kind !== 'scene' ||
      diagnostic.primaryLocation.scope.name !== request.sceneName)
  ) {
    return false;
  }
  if (Array.isArray(request.entityKinds) && request.entityKinds.length) {
    const entityKinds = [
      diagnostic.primaryLocation &&
        diagnostic.primaryLocation.entity &&
        diagnostic.primaryLocation.entity.kind,
      ...asArray(diagnostic.relatedLocations).map(
        location => location && location.entity && location.entity.kind
      ),
    ].filter(Boolean);
    if (!entityKinds.some(kind => request.entityKinds.includes(kind))) {
      return false;
    }
  }
  return true;
};

export const createStaticDiagnosticsService = ({
  project,
  diagnosticsTools,
  eventTools,
  metadataDiscoveryService,
  referenceGraphService,
  targetIdentityService,
  getProjectRevision,
}: any): any => {
  const eventStateCache = new Map();
  const graphEntityCache = new Map();

  const requireProjectIdentity = () => {
    if (!project || !diagnosticsTools || !targetIdentityService) {
      throw new AgentError({ code: 'no_project_open' });
    }
    return targetIdentityService.requireProjectIdentity();
  };

  const getCurrentProjectRevision = (): ?number => {
    if (typeof getProjectRevision !== 'function') return null;
    const revision = getProjectRevision();
    return Number.isInteger(revision) ? revision : null;
  };

  const getEventState = (target: any): ?any => {
    if (!eventTools || !target) return null;
    const key = JSON.stringify(target);
    if (eventStateCache.has(key)) return eventStateCache.get(key);
    try {
      const state = eventTools.readEventsJson({ target });
      eventStateCache.set(key, state);
      return state;
    } catch (error) {
      eventStateCache.set(key, null);
      return null;
    }
  };

  const resolveGraphEntity = ({ kind, name, sceneName }: any): ?any => {
    if (!referenceGraphService || !kind || !name) return null;
    const key = JSON.stringify({ kind, name, sceneName: sceneName || null });
    if (graphEntityCache.has(key)) return graphEntityCache.get(key);
    try {
      const result = referenceGraphService.query({
        kind,
        name,
        direction: 'both',
        maxDepth: 0,
        maxVisitedNodes: 100,
        offset: 0,
        limit: 20,
        ...(sceneName ? { sceneName } : {}),
      });
      const root = result && result.root ? result.root : null;
      graphEntityCache.set(key, root);
      return root;
    } catch (error) {
      graphEntityCache.set(key, null);
      return null;
    }
  };

  const describeInstructionParameter = ({
    instruction,
    isCondition,
    parameterIndex,
  }: any): ?any => {
    if (
      !metadataDiscoveryService ||
      !instruction ||
      !instruction.type ||
      !Number.isInteger(parameterIndex)
    ) {
      return null;
    }
    try {
      const described = metadataDiscoveryService.describeInstruction({
        id: instruction.type,
        kind: isCondition ? 'condition' : 'action',
        includeHidden: true,
      });
      const parameters =
        described && described.item && Array.isArray(described.item.parameters)
          ? described.item.parameters
          : [];
      return (
        parameters.find(parameter => parameter.index === parameterIndex) ||
        parameters[parameterIndex] ||
        null
      );
    } catch (error) {
      return null;
    }
  };

  const inferReferencedEntity = ({
    parameterMetadata,
    value,
    sceneName,
  }: any): ?any => {
    if (!parameterMetadata || typeof value !== 'string' || !value) return null;
    const valueType = parameterMetadata.valueType || {};
    const typeName = String(parameterMetadata.type || '').toLowerCase();
    let kind = null;
    if (valueType.object) kind = 'object-definition';
    else if (valueType.resource) kind = 'resource';
    else if (valueType.variable) kind = 'variable';
    else if (valueType.behavior) kind = 'behavior';
    else if (typeName.includes('scene')) kind = 'scene';
    else if (typeName.includes('external')) kind = 'external-events';
    if (!kind) return null;

    const resolved = resolveGraphEntity({ kind, name: value, sceneName });
    return resolved
      ? {
          kind: resolved.kind,
          name: resolved.name,
          selector: resolved.selector,
          resolved: true,
          identity: resolved.identity || null,
        }
      : {
          kind,
          name: value,
          selector: null,
          resolved: false,
          identity: { kind: 'unresolved-name', name: value },
        };
  };

  const mapEventIssue = ({ issue, scope }: any): any => {
    const details = issue.details || {};
    const target = eventTargetFromIssue(issue);
    const state = getEventState(target);
    const eventNode =
      state && Array.isArray(details.eventPath)
        ? findEventByPath(state.events, details.eventPath)
        : null;
    const sourceRange = normalizeSourceRange(details);
    const result = {
      scope,
      target,
      eventsRevision: state ? state.eventsRevision : null,
      event: eventNode
        ? {
            handle: eventNode.handle,
            path: eventNode.path,
            type: eventNode.type || null,
          }
        : Array.isArray(details.eventPath)
        ? { handle: null, path: details.eventPath, type: null }
        : null,
      instruction: null,
      field: Number.isInteger(details.parameterIndex)
        ? {
            kind: 'instruction-parameter',
            parameterIndex: details.parameterIndex,
            path: 'parameters[' + String(details.parameterIndex) + ']',
            value:
              details.parameterValue === undefined
                ? null
                : details.parameterValue,
          }
        : null,
      sourceRange,
      mapping: {
        exactInstruction: false,
        candidateCount: 0,
      },
    };

    if (!eventNode) return result;
    const instructionCandidates = (details.isCondition
      ? [
          ...flattenInstructions(eventNode.conditions),
          ...flattenInstructions(eventNode.whileConditions),
        ]
      : flattenInstructions(eventNode.actions)
    ).filter(instruction => {
      if (!instruction || instruction.type !== details.instructionType) {
        return false;
      }
      if (!Number.isInteger(details.parameterIndex)) return true;
      const value = asArray(instruction.parameters)[details.parameterIndex];
      return (
        details.parameterValue === undefined ||
        String(value == null ? '' : value) === String(details.parameterValue)
      );
    });

    result.mapping.candidateCount = instructionCandidates.length;
    if (instructionCandidates.length === 1) {
      const instruction = instructionCandidates[0];
      result.instruction = {
        handle: instruction.handle,
        instructionKind: instruction.instructionKind,
        type: instruction.type,
        path: instruction.path,
        eventHandle: eventNode.handle,
      };
      result.mapping.exactInstruction = true;
    } else if (instructionCandidates.length > 1) {
      result.mapping.candidateInstructionHandles = instructionCandidates.map(
        instruction => instruction.handle
      );
    }
    return result;
  };

  const decorateIssue = (issue: any, projectIdentity: any): any => {
    const details = issue.details || {};
    const scope = makeScope({ issue, projectIdentity });
    const eventLocation =
      issue.category === 'events-validation'
        ? mapEventIssue({ issue, scope })
        : null;

    let entity = null;
    if (issue.category === 'resources') {
      const resourceName = details.resourceName;
      const resolved = resolveGraphEntity({
        kind: 'resource',
        name: resourceName,
      });
      entity = resolved
        ? {
            kind: resolved.kind,
            name: resolved.name,
            selector: resolved.selector,
            resolved: true,
            identity: resolved.identity || null,
          }
        : resourceName
        ? {
            kind: 'resource',
            name: resourceName,
            selector: null,
            resolved: false,
            identity: { kind: 'canonical-name', name: resourceName },
          }
        : null;
    } else if (issue.objectName) {
      const resolved = resolveGraphEntity({
        kind: 'object-definition',
        name: issue.objectName,
        sceneName: scope.kind === 'scene' ? scope.name : null,
      });
      entity = resolved
        ? {
            kind: resolved.kind,
            name: resolved.name,
            selector: resolved.selector,
            resolved: true,
            identity: resolved.identity || null,
          }
        : {
            kind: 'object-definition',
            name: issue.objectName,
            selector: null,
            resolved: false,
            identity: { kind: 'unresolved-name', name: issue.objectName },
          };
    } else if (issue.category === 'project-properties') {
      entity = {
        kind: 'project',
        name: projectIdentity.projectName,
        selector: makeProjectSelector(projectIdentity.projectUuid),
        resolved: true,
        identity: {
          projectUuid: projectIdentity.projectUuid,
          projectName: projectIdentity.projectName,
        },
      };
    }

    const relatedLocations = [];
    let parameterMetadata = null;
    let referencedEntity = null;
    if (
      eventLocation &&
      eventLocation.instruction &&
      eventLocation.field &&
      Number.isInteger(eventLocation.field.parameterIndex)
    ) {
      parameterMetadata = describeInstructionParameter({
        instruction: eventLocation.instruction,
        isCondition: !!details.isCondition,
        parameterIndex: eventLocation.field.parameterIndex,
      });
      referencedEntity = inferReferencedEntity({
        parameterMetadata,
        value: eventLocation.field.value,
        sceneName: scope.kind === 'scene' ? scope.name : null,
      });
      if (referencedEntity) {
        relatedLocations.push({
          relation: referencedEntity.resolved
            ? 'referenced-entity'
            : 'unresolved-referenced-entity',
          entity: referencedEntity,
        });
      }
    }

    if (
      eventLocation &&
      eventLocation.mapping &&
      Array.isArray(eventLocation.mapping.candidateInstructionHandles)
    ) {
      eventLocation.mapping.candidateInstructionHandles.forEach(handle => {
        relatedLocations.push({
          relation: 'candidate-instruction',
          event: eventLocation.event,
          instruction: { handle },
          scope,
        });
      });
    }

    if (
      issue.category === 'behavior-property' &&
      details.behaviorName &&
      details.propertyName
    ) {
      relatedLocations.push({
        relation: 'behavior-property-owner',
        entity: entity,
        property: {
          behaviorName: details.behaviorName,
          path: details.propertyName,
        },
      });
    }

    const primaryLocation = eventLocation
      ? {
          scope,
          event: eventLocation.event,
          instruction: eventLocation.instruction,
          field: eventLocation.field,
          sourceRange: eventLocation.sourceRange,
          entity,
          target: eventLocation.target,
          eventsRevision: eventLocation.eventsRevision,
          mapping: eventLocation.mapping,
        }
      : {
          scope,
          entity,
          property:
            details.propertyName || details.resourceName
              ? {
                  path:
                    details.propertyName ||
                    (details.resourceName
                      ? 'resource:' + details.resourceName
                      : null),
                }
              : null,
          sourceRange: normalizeSourceRange(details),
        };

    const diagnosticIdentityPayload = {
      category: issue.category,
      code: issue.code,
      scopeSelector: scope.selector,
      eventHandle:
        primaryLocation.event && primaryLocation.event.handle
          ? primaryLocation.event.handle
          : null,
      instructionHandle:
        primaryLocation.instruction && primaryLocation.instruction.handle
          ? primaryLocation.instruction.handle
          : null,
      eventPath:
        primaryLocation.event && primaryLocation.event.path
          ? primaryLocation.event.path
          : details.eventPath || null,
      parameterIndex:
        primaryLocation.field &&
        Number.isInteger(primaryLocation.field.parameterIndex)
          ? primaryLocation.field.parameterIndex
          : null,
      entitySelector: entity && entity.selector ? entity.selector : null,
      entityName:
        entity && entity.name ? entity.name : issue.objectName || null,
      propertyName: details.propertyName || null,
      resourceName: details.resourceName || null,
      unresolvedTarget:
        referencedEntity && !referencedEntity.resolved
          ? { kind: referencedEntity.kind, name: referencedEntity.name }
          : null,
    };
    const diagnosticId =
      'diagnostic:' + hashString(JSON.stringify(diagnosticIdentityPayload));

    let suggestedAction = {
      safeAutomaticFix: false,
      inspectWith: 'diagnostics.query',
      targetSelector: scope.selector,
      tool: null,
      inputHint: null,
    };
    if (
      eventLocation &&
      eventLocation.instruction &&
      eventLocation.field &&
      Number.isInteger(eventLocation.field.parameterIndex)
    ) {
      suggestedAction = {
        ...suggestedAction,
        tool: 'events.patch',
        targetSelector:
          eventLocation.instruction.handle || eventLocation.event.handle,
        inputHint: {
          target: eventLocation.target,
          expectedEventsRevision: eventLocation.eventsRevision,
          operation: {
            kind: 'instruction.parameter.update',
            instructionHandle: eventLocation.instruction.handle,
            parameterIndex: eventLocation.field.parameterIndex,
            value: '<replacement>',
          },
        },
      };
    } else if (entity && entity.kind === 'resource') {
      suggestedAction = {
        ...suggestedAction,
        tool: 'resources.visual.inspect',
        targetSelector: entity.selector,
        inputHint: { resourceName: entity.name },
      };
    } else if (entity && entity.kind === 'object-definition') {
      const objectId =
        entity.identity && typeof entity.identity.objectId === 'string'
          ? entity.identity.objectId
          : null;
      suggestedAction = {
        ...suggestedAction,
        tool: 'objects.definitions.get',
        targetSelector: entity.selector,
        inputHint: objectId
          ? { objectId }
          : {
              objectName: entity.name,
              ...(scope.kind === 'scene' ? { sceneName: scope.name } : {}),
            },
      };
    }

    return {
      diagnosticId,
      domain: STATIC_DOMAIN,
      severity: SEVERITIES.includes(issue.severity) ? issue.severity : 'error',
      category: issue.category || 'unknown',
      code: issue.code || 'unknown-static-diagnostic',
      message: issue.message || String(issue.code || 'Static diagnostic'),
      primaryLocation,
      relatedLocations,
      suggestedAction,
      parameterMetadata: parameterMetadata
        ? {
            index: parameterMetadata.index,
            name: parameterMetadata.name || null,
            type: parameterMetadata.type || null,
            valueType: parameterMetadata.valueType || null,
          }
        : null,
      rawContext: {
        actualValue: issue.actualValue === undefined ? null : issue.actualValue,
        expectedValue:
          issue.expectedValue === undefined ? null : issue.expectedValue,
      },
    };
  };

  const capabilities = () => ({
    domain: STATIC_DOMAIN,
    commands: [
      'diagnostics.inspect',
      'diagnostics.capabilities',
      'diagnostics.query',
    ],
    severities: SEVERITIES,
    sources: [
      'project-properties',
      'events-validation',
      'behavior-property',
      'native-code-generation',
      'resources',
    ],
    locationKinds: [
      'project',
      'scene',
      'external-events',
      'extension-function',
      'event',
      'event-condition',
      'event-action',
      'object-definition',
      'resource',
      'behavior',
      'variable',
    ],
    sourceMapping: {
      stableScopeSelectors: true,
      stableEventHandles: true,
      stableInstructionHandles: true,
      parameterIndexAndPath: true,
      textualSourceRangeWhenProvidedByUnderlyingValidator: true,
      ambiguityIsReportedAsCandidates: true,
    },
    filtering: ['severity', 'code', 'scope', 'sceneName', 'entityKind'],
    incremental: {
      projectRevision: true,
      eventsRevisionPerMappedEventSheet: true,
      sinceProjectRevisionShortCircuit: true,
    },
    excludesRuntimeDiagnostics: true,
    runtimeDiagnosticsGuidance:
      'Runtime logs/traces/assertions remain under runtime/validation surfaces and are not returned by diagnostics.query.',
    integrations: {
      responseErrors: 'DX-21',
      eventHandles: 'DX-3/DX-20',
      referenceGraph: 'DX-37',
      projectRevision: 'DX-19',
    },
    projectModified: false,
  });

  const query = (request: any = {}) => {
    eventStateCache.clear();
    graphEntityCache.clear();
    const projectIdentity = requireProjectIdentity();
    const projectRevision = getCurrentProjectRevision();

    if (
      Number.isInteger(request.sinceProjectRevision) &&
      Number.isInteger(projectRevision) &&
      request.sinceProjectRevision === projectRevision
    ) {
      return {
        domain: STATIC_DOMAIN,
        unchanged: true,
        project: projectIdentity,
        snapshot: {
          projectRevision,
          eventRevisions: [],
        },
        summary: {
          total: null,
          errors: null,
          warnings: null,
          info: null,
          clean: null,
          returned: 0,
          filteredOut: 0,
          notModified: true,
        },
        diagnostics: [],
        projectModified: false,
      };
    }

    const inspected = diagnosticsTools.inspect({
      includeNativeReport: request.includeNativeReport !== false,
      includeAssets: request.includeAssets !== false,
    });
    const allDiagnostics = asArray(inspected.issues).map(issue =>
      decorateIssue(issue, projectIdentity)
    );
    const filtered = allDiagnostics.filter(item =>
      matchesFilter(item, request)
    );
    const offset = Number.isInteger(request.offset)
      ? Math.max(0, request.offset)
      : 0;
    const limit = Number.isInteger(request.limit)
      ? Math.max(1, Math.min(1000, request.limit))
      : 200;
    const diagnostics = filtered.slice(offset, offset + limit);
    const eventRevisionMap = new Map();
    allDiagnostics.forEach(item => {
      const location = item.primaryLocation || {};
      const scope = location.scope || {};
      if (location.eventsRevision && scope.selector) {
        eventRevisionMap.set(scope.selector, {
          scope: {
            kind: scope.kind,
            name: scope.name,
            selector: scope.selector,
          },
          eventsRevision: location.eventsRevision,
        });
      }
    });
    const allSummary = summarize(allDiagnostics);
    const returnedSummary = summarize(diagnostics);

    return {
      domain: STATIC_DOMAIN,
      unchanged: false,
      project: projectIdentity,
      snapshot: {
        projectRevision,
        eventRevisions: Array.from(eventRevisionMap.values()).sort((a, b) =>
          String(a.scope.selector).localeCompare(String(b.scope.selector))
        ),
        revisionKey:
          'diagnostics:' +
          hashString(
            JSON.stringify({
              projectRevision,
              eventRevisions: Array.from(eventRevisionMap.values()),
            })
          ),
      },
      summary: {
        ...allSummary,
        returned: diagnostics.length,
        returnedErrors: returnedSummary.errors,
        returnedWarnings: returnedSummary.warnings,
        returnedInfo: returnedSummary.info,
        filteredOut: allDiagnostics.length - filtered.length,
      },
      diagnostics,
      pagination: {
        offset,
        limit,
        total: filtered.length,
        returned: diagnostics.length,
        hasMore: offset + diagnostics.length < filtered.length,
        nextOffset:
          offset + diagnostics.length < filtered.length
            ? offset + diagnostics.length
            : null,
      },
      sourceSummary: inspected.summary || null,
      projectModified: false,
    };
  };

  return { capabilities, query };
};
