// @flow
import { createStaticDiagnosticsService } from './StaticDiagnosticsService';

const makeProjectIdentity = () => ({
  open: true,
  projectId: 'project-uuid',
  projectUuid: 'project-uuid',
  projectName: 'Game',
  scenes: [
    {
      sceneName: 'Main',
      sceneId: 'scene-uuid',
      selector: 'scene:scene-uuid',
      identityKind: 'persistent-uuid',
    },
  ],
  externalEvents: [],
});

const makeService = ({
  issues = [],
  projectRevision = 7,
  eventState,
  graphNodes = {},
}: any = {}) => {
  const diagnosticsTools = {
    inspect: jest.fn(() => ({
      summary: {
        ok: !issues.some(issue => issue.severity === 'error'),
        total: issues.length,
        errors: issues.filter(issue => issue.severity === 'error').length,
        warnings: issues.filter(issue => issue.severity === 'warning').length,
        info: issues.filter(issue => issue.severity === 'info').length,
      },
      issues,
    })),
  };
  const eventTools = {
    readEventsJson: jest.fn(
      () =>
        eventState || {
          target: { kind: 'scene', sceneName: 'Main' },
          eventsRevision: 'events:abc',
          events: [
            {
              handle: 'event:fp:event1',
              path: [0],
              type: 'BuiltinCommonInstructions::Standard',
              conditions: [],
              whileConditions: [],
              actions: [
                {
                  handle: 'action:fp:set-x',
                  path: [0],
                  eventPath: [0],
                  instructionKind: 'action',
                  type: 'SetX',
                  parameters: ['MissingObject', '10'],
                  children: [],
                },
              ],
              children: [],
            },
          ],
        }
    ),
  };
  const metadataDiscoveryService = {
    describeInstruction: jest.fn(() => ({
      item: {
        parameters: [
          {
            index: 0,
            name: 'Object',
            type: 'object',
            valueType: { object: true },
          },
          {
            index: 1,
            name: 'X',
            type: 'expression',
            valueType: {},
          },
        ],
      },
    })),
  };
  const referenceGraphService = {
    query: jest.fn(input => {
      const node = graphNodes[`${input.kind}:${input.name}`];
      if (!node) throw new Error('reference_graph_node_not_found');
      return { root: node };
    }),
  };
  const targetIdentityService = {
    requireProjectIdentity: jest.fn(makeProjectIdentity),
  };
  const service = createStaticDiagnosticsService({
    project: { getName: () => 'Game' },
    diagnosticsTools,
    eventTools,
    metadataDiscoveryService,
    referenceGraphService,
    targetIdentityService,
    getProjectRevision: () => projectRevision,
  });
  return {
    service,
    diagnosticsTools,
    eventTools,
    metadataDiscoveryService,
    referenceGraphService,
  };
};

describe('StaticDiagnosticsService', () => {
  test('returns an explicit zero-error/zero-warning result for a clean project', () => {
    const { service } = makeService({ issues: [] });
    const result = service.query();

    expect(result.unchanged).toBe(false);
    expect(result.summary).toMatchObject({
      total: 0,
      errors: 0,
      warnings: 0,
      info: 0,
      clean: true,
      returned: 0,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot.projectRevision).toBe(7);
    expect(result.projectModified).toBe(false);
  });

  test('maps an invalid Event Sheet parameter to stable event/instruction handles and field path', () => {
    const issue = {
      severity: 'error',
      category: 'events-validation',
      code: 'invalid-parameter',
      message: 'Invalid parameter in SetX',
      details: {
        isCondition: false,
        instructionType: 'SetX',
        parameterIndex: 0,
        parameterValue: 'MissingObject',
        locationName: 'Main',
        locationType: 'scene',
        eventPath: [0],
      },
    };
    const { service } = makeService({ issues: [issue] });
    const result = service.query();
    const diagnostic = result.diagnostics[0];

    expect(diagnostic.domain).toBe('static-editor-project');
    expect(diagnostic.primaryLocation.scope).toMatchObject({
      kind: 'scene',
      name: 'Main',
      selector: 'scene:scene-uuid',
    });
    expect(diagnostic.primaryLocation.event).toMatchObject({
      handle: 'event:fp:event1',
      path: [0],
    });
    expect(diagnostic.primaryLocation.instruction).toMatchObject({
      handle: 'action:fp:set-x',
      instructionKind: 'action',
      type: 'SetX',
    });
    expect(diagnostic.primaryLocation.field).toEqual({
      kind: 'instruction-parameter',
      parameterIndex: 0,
      path: 'parameters[0]',
      value: 'MissingObject',
    });
    expect(diagnostic.primaryLocation.eventsRevision).toBe('events:abc');
    expect(diagnostic.primaryLocation.mapping).toEqual({
      exactInstruction: true,
      candidateCount: 1,
    });
    expect(diagnostic.relatedLocations).toContainEqual({
      relation: 'unresolved-referenced-entity',
      entity: {
        kind: 'object-definition',
        name: 'MissingObject',
        selector: null,
        resolved: false,
        identity: {
          kind: 'unresolved-name',
          name: 'MissingObject',
        },
      },
    });
    expect(diagnostic.suggestedAction).toMatchObject({
      safeAutomaticFix: false,
      tool: 'events.patch',
      targetSelector: 'action:fp:set-x',
      inputHint: {
        target: { kind: 'scene', sceneName: 'Main' },
        expectedEventsRevision: 'events:abc',
        operation: {
          kind: 'instruction.parameter.update',
          instructionHandle: 'action:fp:set-x',
          parameterIndex: 0,
          value: '<replacement>',
        },
      },
    });
    expect(typeof diagnostic.diagnosticId).toBe('string');
    expect(result.snapshot.eventRevisions).toEqual([
      {
        scope: {
          kind: 'scene',
          name: 'Main',
          selector: 'scene:scene-uuid',
        },
        eventsRevision: 'events:abc',
      },
    ]);
  });

  test('keeps diagnostic identity stable across repeated reads at the same location', () => {
    const issue = {
      severity: 'warning',
      category: 'events-validation',
      code: 'missing-instruction',
      message: 'Missing instruction: Missing::Action',
      details: {
        isCondition: false,
        instructionType: 'Missing::Action',
        locationName: 'Main',
        locationType: 'scene',
        eventPath: [0],
      },
    };
    const eventState = {
      eventsRevision: 'events:missing',
      events: [
        {
          handle: 'event:fp:missing-event',
          path: [0],
          type: 'BuiltinCommonInstructions::Standard',
          conditions: [],
          whileConditions: [],
          actions: [
            {
              handle: 'action:fp:missing-action',
              path: [0],
              eventPath: [0],
              instructionKind: 'action',
              type: 'Missing::Action',
              parameters: [],
              children: [],
            },
          ],
          children: [],
        },
      ],
    };
    const { service } = makeService({ issues: [issue], eventState });
    const first = service.query();
    const second = service.query();

    expect(first.diagnostics[0].diagnosticId).toBe(
      second.diagnostics[0].diagnosticId
    );
    expect(first.diagnostics[0].primaryLocation.instruction.handle).toBe(
      'action:fp:missing-action'
    );
  });

  test('reports source range and stable resource identity when provided by an underlying validator', () => {
    const issue = {
      severity: 'error',
      category: 'resources',
      code: 'missing-resource-file',
      message: 'Missing resource file',
      details: {
        resourceName: 'hero.png',
        file: 'assets/hero.png',
        sourceRange: {
          start: { line: 12, column: 5 },
          end: { line: 12, column: 23 },
        },
      },
    };
    const { service } = makeService({
      issues: [issue],
      graphNodes: {
        'resource:hero.png': {
          kind: 'resource',
          name: 'hero.png',
          selector: 'resource:hero.png',
          identity: { kind: 'canonical-resource-name', name: 'hero.png' },
        },
      },
    });
    const diagnostic = service.query().diagnostics[0];

    expect(diagnostic.primaryLocation.entity).toMatchObject({
      kind: 'resource',
      name: 'hero.png',
      selector: 'resource:hero.png',
      resolved: true,
    });
    expect(diagnostic.primaryLocation.sourceRange).toEqual(
      issue.details.sourceRange
    );
  });

  test('supports filtering and project-revision short-circuit without rescanning', () => {
    const issues = [
      {
        severity: 'error',
        category: 'project-properties',
        code: 'invalid-project-property:packageName',
        message: 'Invalid package name',
        details: { propertyName: 'packageName' },
      },
      {
        severity: 'warning',
        category: 'project-properties',
        code: 'invalid-project-property:version',
        message: 'Version warning',
        details: { propertyName: 'version' },
      },
    ];
    const { service, diagnosticsTools } = makeService({ issues });

    const filtered = service.query({
      severities: ['warning'],
      codes: ['invalid-project-property:version'],
    });
    expect(filtered.diagnostics).toHaveLength(1);
    expect(filtered.diagnostics[0].severity).toBe('warning');
    expect(filtered.summary.total).toBe(2);
    expect(filtered.summary.returned).toBe(1);
    expect(filtered.summary.filteredOut).toBe(1);

    const callsBefore = diagnosticsTools.inspect.mock.calls.length;
    const unchanged = service.query({ sinceProjectRevision: 7 });
    expect(unchanged).toMatchObject({
      unchanged: true,
      summary: {
        returned: 0,
        notModified: true,
      },
      diagnostics: [],
    });
    expect(diagnosticsTools.inspect.mock.calls).toHaveLength(callsBefore);
  });

  test('capabilities explicitly separate static diagnostics from runtime traces', () => {
    const { service } = makeService();
    expect(service.capabilities()).toMatchObject({
      domain: 'static-editor-project',
      excludesRuntimeDiagnostics: true,
      sourceMapping: {
        stableScopeSelectors: true,
        stableEventHandles: true,
        stableInstructionHandles: true,
        parameterIndexAndPath: true,
        ambiguityIsReportedAsCandidates: true,
      },
      incremental: {
        projectRevision: true,
        eventsRevisionPerMappedEventSheet: true,
        sinceProjectRevisionShortCircuit: true,
      },
    });
  });
});
