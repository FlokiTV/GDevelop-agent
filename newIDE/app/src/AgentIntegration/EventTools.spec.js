// @flow
import { createEventTools } from './EventTools';

const gd: libGDevelop = global.gd;

describe('AgentIntegration EventTools', () => {
  let project: gdProject;
  let source: gdLayout;
  let target: gdLayout;
  let diagnosticsTools;
  let metadataDiscoveryService;
  let triggerUnsavedChanges;
  let onSceneEventsModifiedOutsideEditor;
  let forceUpdate;

  beforeEach(() => {
    project = gd.ProjectHelper.createNewGDJSProject();
    source = project.insertNewLayout('Source', 0);
    target = project.insertNewLayout('Target', 1);
    source
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Standard', 0);
    target
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Comment', 0);
    diagnosticsTools = {
      inspect: jest.fn(() => ({
        issues: [],
        summary: { ok: true, errors: 0, warnings: 0 },
      })),
    };
    metadataDiscoveryService = {
      describeInstruction: jest.fn(input => ({
        item: {
          id: input.id,
          kind: input.kind,
          canHaveSubInstructions: true,
          parameters:
            input.id === 'TestAction'
              ? [{ index: 0, name: 'Target' }, { index: 1, name: 'Value' }]
              : [{ index: 0, name: 'Value' }],
        },
      })),
    };
    triggerUnsavedChanges = jest.fn();
    onSceneEventsModifiedOutsideEditor = jest.fn();
    forceUpdate = jest.fn();
  });

  afterEach(() => {
    project.delete();
  });

  const makeTools = () =>
    createEventTools({
      project,
      diagnosticsTools,
      metadataDiscoveryService,
      triggerUnsavedChanges,
      onSceneEventsModifiedOutsideEditor,
      forceUpdate,
    });

  it('reads canonical scene events JSON', () => {
    const result = makeTools().readSceneEventsJson({ sceneName: 'Source' });
    expect(result.sceneName).toBe('Source');
    expect(result.eventsCount).toBe(1);
    expect(Array.isArray(result.eventsJson)).toBe(true);
    expect(result.eventsJson).toHaveLength(1);
  });

  it('paginates hundreds of root events while keeping full-tree revision and stable paths', () => {
    const largeScene = project.insertNewLayout('LargeEvents', 2);
    for (let index = 0; index < 350; index++) {
      largeScene
        .getEvents()
        .insertNewEvent(project, 'BuiltinCommonInstructions::Comment', index);
    }
    const tools = makeTools();
    const full = tools.readSceneEventsJson({ sceneName: 'LargeEvents' });
    const page = tools.readSceneEventsJson({
      sceneName: 'LargeEvents',
      offset: 200,
      limit: 50,
    });

    expect(full.events).toHaveLength(350);
    expect(page.events).toHaveLength(50);
    expect(page.eventsJson).toHaveLength(50);
    expect(page.eventsRevision).toBe(full.eventsRevision);
    expect(page.events[0].path).toEqual([200]);
    expect(page.events[49].path).toEqual([249]);
    expect(page.pagination).toEqual({
      offset: 200,
      limit: 50,
      total: 350,
      returned: 50,
      hasMore: true,
      nextOffset: 250,
    });
  });

  it('returns canonical handles and a tree revision that changes with the event tree', () => {
    const tools = makeTools();
    const first = tools.readSceneEventsJson({ sceneName: 'Source' });

    expect(first.eventsRevision).toMatch(/^events:[0-9a-f]{32}$/);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      path: [0],
      handleKind: 'fingerprint',
      type: 'BuiltinCommonInstructions::Standard',
    });
    expect(first.events[0].handle).toMatch(/^event:fp:[0-9a-f]{32}$/);

    source
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Comment', 0);
    const second = tools.readSceneEventsJson({ sceneName: 'Source' });

    expect(second.eventsRevision).not.toBe(first.eventsRevision);
    const originalEventAfterInsert = second.events.find(
      event => event.fingerprint === first.events[0].fingerprint
    );
    expect(originalEventAfterInsert).toBeTruthy();
    expect(originalEventAfterInsert.handle).toBe(first.events[0].handle);
    expect(originalEventAfterInsert.path).toEqual([1]);
  });

  it('returns canonical handles for conditions, actions and nested instructions', () => {
    const tools = makeTools();
    const before = tools.readSceneEventsJson({ sceneName: 'Source' });
    const eventJson = {
      ...before.eventsJson[0],
      conditions: [
        {
          type: { value: 'TestCondition' },
          parameters: ['Player'],
          subInstructions: [
            {
              type: { value: 'NestedCondition' },
              parameters: ['Nested'],
              subInstructions: [],
            },
          ],
        },
      ],
      actions: [
        {
          type: { value: 'TestAction' },
          parameters: ['42'],
          subInstructions: [],
        },
      ],
    };
    tools.updateSceneEvent({
      sceneName: 'Source',
      expectedEventsRevision: before.eventsRevision,
      handle: before.events[0].handle,
      eventJson,
    });

    const result = tools.readSceneEventsJson({ sceneName: 'Source' });
    const event = result.events[0];
    expect(event.conditions).toHaveLength(1);
    expect(event.conditions[0]).toMatchObject({
      eventPath: [0],
      path: [0],
      handleKind: 'fingerprint',
      type: 'TestCondition',
      parameters: ['Player'],
    });
    expect(event.conditions[0].handle).toMatch(/^condition:fp:[0-9a-f]{32}$/);
    expect(event.conditions[0].children[0]).toMatchObject({
      eventPath: [0],
      path: [0, 0],
      type: 'NestedCondition',
    });
    expect(event.actions).toHaveLength(1);
    expect(event.actions[0]).toMatchObject({
      eventPath: [0],
      path: [0],
      handleKind: 'fingerprint',
      type: 'TestAction',
      parameters: ['42'],
    });
    expect(event.actions[0].handle).toMatch(/^action:fp:[0-9a-f]{32}$/);
  });

  it('patches one instruction parameter by metadata name without resending the parent event JSON', () => {
    const tools = makeTools();
    const initial = tools.readSceneEventsJson({ sceneName: 'Source' });
    tools.updateSceneEvent({
      sceneName: 'Source',
      expectedEventsRevision: initial.eventsRevision,
      handle: initial.events[0].handle,
      eventJson: {
        ...initial.eventsJson[0],
        conditions: [
          {
            type: { inverted: false, value: 'TestCondition' },
            parameters: ['keep-condition'],
            subInstructions: [],
          },
        ],
        actions: [
          {
            type: { inverted: false, value: 'TestAction' },
            parameters: ['Player', '42'],
            subInstructions: [],
          },
          {
            type: { inverted: false, value: 'SiblingAction' },
            parameters: ['keep-sibling'],
            subInstructions: [],
          },
        ],
      },
    });
    const before = tools.readSceneEventsJson({ sceneName: 'Source' });
    const siblingBefore = before.eventsJson[0].actions[1];
    const conditionsBefore = before.eventsJson[0].conditions;

    const result = tools.patchEvent({
      sceneName: 'Source',
      expectedEventsRevision: before.eventsRevision,
      operation: {
        kind: 'instruction.parameter.update',
        instructionHandle: before.events[0].actions[0].handle,
        parameterName: 'Value',
        value: '99',
      },
    });

    expect(result).toMatchObject({
      updated: true,
      changed: true,
      parameter: {
        index: 1,
        name: 'Value',
        beforeValue: '42',
        value: '99',
      },
      diff: {
        operation: 'instruction.parameter.update',
        changed: true,
      },
    });
    expect(metadataDiscoveryService.describeInstruction).toHaveBeenCalledWith({
      id: 'TestAction',
      kind: 'action',
      includeHidden: true,
    });
    const after = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(after.eventsJson[0].actions[0].parameters).toEqual(['Player', '99']);
    expect(after.eventsJson[0].actions[1]).toEqual(siblingBefore);
    expect(after.eventsJson[0].conditions).toEqual(conditionsBefore);
  });

  it('inserts and deletes individual instructions with deterministic index and sibling placement', () => {
    const tools = makeTools();
    const initial = tools.readSceneEventsJson({ sceneName: 'Source' });
    tools.updateSceneEvent({
      sceneName: 'Source',
      expectedEventsRevision: initial.eventsRevision,
      handle: initial.events[0].handle,
      eventJson: {
        ...initial.eventsJson[0],
        actions: [
          {
            type: { inverted: false, value: 'ActionA' },
            parameters: ['A'],
            subInstructions: [],
          },
          {
            type: { inverted: false, value: 'ActionC' },
            parameters: ['C'],
            subInstructions: [],
          },
        ],
      },
    });
    const before = tools.readSceneEventsJson({ sceneName: 'Source' });

    const inserted = tools.patchEvent({
      sceneName: 'Source',
      expectedEventsRevision: before.eventsRevision,
      operation: {
        kind: 'instruction.insert',
        eventHandle: before.events[0].handle,
        instructionKind: 'action',
        index: 1,
        instructionJson: {
          type: { inverted: false, value: 'ActionB' },
          parameters: ['B'],
          subInstructions: [],
        },
      },
    });
    expect(inserted.inserted).toBe(true);
    expect(inserted.instruction).toMatchObject({
      instructionKind: 'action',
      path: [1],
      type: 'ActionB',
      parameters: ['B'],
    });
    let after = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(
      after.eventsJson[0].actions.map(action => action.type.value)
    ).toEqual(['ActionA', 'ActionB', 'ActionC']);

    const deleted = tools.patchEvent({
      sceneName: 'Source',
      expectedEventsRevision: inserted.eventsRevision,
      operation: {
        kind: 'instruction.delete',
        instructionHandle: inserted.instruction.handle,
      },
    });
    expect(deleted.deleted).toBe(true);
    after = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(
      after.eventsJson[0].actions.map(action => action.type.value)
    ).toEqual(['ActionA', 'ActionC']);

    const insertedBefore = tools.patchEvent({
      sceneName: 'Source',
      expectedEventsRevision: deleted.eventsRevision,
      operation: {
        kind: 'instruction.insert',
        eventHandle: after.events[0].handle,
        instructionKind: 'action',
        beforeHandle: after.events[0].actions[1].handle,
        instructionJson: {
          type: { inverted: false, value: 'ActionB2' },
          parameters: ['B2'],
          subInstructions: [],
        },
      },
    });
    expect(insertedBefore.instruction.path).toEqual([1]);
    let finalRead = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(
      finalRead.eventsJson[0].actions.map(action => action.type.value)
    ).toEqual(['ActionA', 'ActionB2', 'ActionC']);

    const movedBefore = tools.patchEvent({
      sceneName: 'Source',
      expectedEventsRevision: finalRead.eventsRevision,
      operation: {
        kind: 'instruction.move',
        instructionHandle: finalRead.events[0].actions[2].handle,
        beforeHandle: finalRead.events[0].actions[0].handle,
      },
    });
    expect(movedBefore).toMatchObject({
      moved: true,
      fromPath: [2],
      instruction: { path: [0], type: 'ActionC' },
      diff: {
        operation: 'instruction.move',
        fromPath: [2],
        toPath: [0],
      },
    });
    finalRead = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(
      finalRead.eventsJson[0].actions.map(action => action.type.value)
    ).toEqual(['ActionC', 'ActionA', 'ActionB2']);

    const movedToEnd = tools.patchEvent({
      sceneName: 'Source',
      expectedEventsRevision: finalRead.eventsRevision,
      operation: {
        kind: 'instruction.move',
        instructionHandle: finalRead.events[0].actions[1].handle,
        index: 3,
      },
    });
    expect(movedToEnd.instruction).toMatchObject({
      path: [2],
      type: 'ActionA',
    });
    finalRead = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(
      finalRead.eventsJson[0].actions.map(action => action.type.value)
    ).toEqual(['ActionC', 'ActionB2', 'ActionA']);
  });

  it('patches supported instruction/event flags and small event metadata fields', () => {
    const tools = makeTools();
    const initial = tools.readSceneEventsJson({ sceneName: 'Source' });
    tools.updateSceneEvent({
      sceneName: 'Source',
      expectedEventsRevision: initial.eventsRevision,
      handle: initial.events[0].handle,
      eventJson: {
        ...initial.eventsJson[0],
        conditions: [
          {
            type: { inverted: false, value: 'TestCondition' },
            parameters: ['Value'],
            subInstructions: [],
          },
        ],
      },
    });
    const before = tools.readSceneEventsJson({ sceneName: 'Source' });
    const inverted = tools.patchEvent({
      sceneName: 'Source',
      expectedEventsRevision: before.eventsRevision,
      operation: {
        kind: 'instruction.flags.update',
        instructionHandle: before.events[0].conditions[0].handle,
        inverted: true,
      },
    });
    expect(inverted.flags.after).toEqual({ inverted: true });

    const disabled = tools.patchEvent({
      sceneName: 'Source',
      expectedEventsRevision: inverted.eventsRevision,
      operation: {
        kind: 'event.flags.update',
        eventHandle: inverted.event.handle,
        enabled: false,
      },
    });
    expect(disabled.flags.after).toEqual({ enabled: false });
    const sourceAfter = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(sourceAfter.eventsJson[0].conditions[0].type.inverted).toBe(true);
    expect(sourceAfter.eventsJson[0].disabled).toBe(true);

    const commentBefore = tools.readSceneEventsJson({ sceneName: 'Target' });
    const commentPatched = tools.patchEvent({
      sceneName: 'Target',
      expectedEventsRevision: commentBefore.eventsRevision,
      operation: {
        kind: 'event.fields.update',
        eventHandle: commentBefore.events[0].handle,
        fields: { comment: 'Granular comment update' },
      },
    });
    expect(commentPatched.fields).toEqual({
      before: { comment: commentBefore.eventsJson[0].comment },
      after: { comment: 'Granular comment update' },
    });
    const commentAfter = tools.readSceneEventsJson({ sceneName: 'Target' });
    expect(commentAfter.eventsJson[0].comment).toBe('Granular comment update');
  });

  it('composes unrelated granular edits without overwriting the first edit when revisions permit', () => {
    const tools = makeTools();
    const initial = tools.readSceneEventsJson({ sceneName: 'Source' });
    tools.updateSceneEvent({
      sceneName: 'Source',
      expectedEventsRevision: initial.eventsRevision,
      handle: initial.events[0].handle,
      eventJson: {
        ...initial.eventsJson[0],
        actions: [
          {
            type: { inverted: false, value: 'TestAction' },
            parameters: ['Player', '1'],
            subInstructions: [],
          },
          {
            type: { inverted: false, value: 'SiblingAction' },
            parameters: ['A'],
            subInstructions: [],
          },
        ],
      },
    });
    const before = tools.readSceneEventsJson({ sceneName: 'Source' });
    const firstHandle = before.events[0].actions[0].handle;
    const secondHandle = before.events[0].actions[1].handle;

    const first = tools.patchEvent({
      sceneName: 'Source',
      expectedEventsRevision: before.eventsRevision,
      operation: {
        kind: 'instruction.parameter.update',
        instructionHandle: firstHandle,
        parameterIndex: 1,
        value: '2',
      },
    });
    const second = tools.patchEvent({
      sceneName: 'Source',
      expectedEventsRevision: first.eventsRevision,
      operation: {
        kind: 'instruction.parameter.update',
        instructionHandle: secondHandle,
        parameterIndex: 0,
        value: 'B',
      },
    });

    const after = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(after.eventsJson[0].actions[0].parameters).toEqual(['Player', '2']);
    expect(after.eventsJson[0].actions[1].parameters).toEqual(['B']);
    expect(second.eventsRevision).toBe(after.eventsRevision);
  });

  it('uses persistent ids only when unique and scopes indistinguishable duplicates by path', () => {
    const duplicateScene = project.insertNewLayout('Duplicates', 2);
    const first = duplicateScene
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Comment', 0);
    first.setAiGeneratedEventId('shared-generation');
    const second = duplicateScene
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Comment', 1);
    second.setAiGeneratedEventId('shared-generation');
    const unique = duplicateScene
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Standard', 2);
    unique.setAiGeneratedEventId('unique-event-id');

    const result = makeTools().readSceneEventsJson({ sceneName: 'Duplicates' });

    expect(result.events[0].handleKind).toBe('fingerprint-path');
    expect(result.events[1].handleKind).toBe('fingerprint-path');
    expect(result.events[0].handle).not.toBe(result.events[1].handle);
    expect(result.events[2]).toMatchObject({
      handle: 'event:id:unique-event-id',
      handleKind: 'persistent-id',
      aiGeneratedEventId: 'unique-event-id',
    });
  });

  it('indexes nested sub-events with canonical child paths', () => {
    const parent = source.getEvents().getEventAt(0);
    parent
      .getSubEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Comment', 0);

    const result = makeTools().readSceneEventsJson({ sceneName: 'Source' });

    expect(result.events[0].children).toHaveLength(1);
    expect(result.events[0].children[0]).toMatchObject({
      path: [0, 0],
      type: 'BuiltinCommonInstructions::Comment',
    });
  });

  it('inserts after a stable handle without replacing existing events', () => {
    const tools = makeTools();
    const sourceEvents = tools.readSceneEventsJson({ sceneName: 'Source' });
    const before = tools.readSceneEventsJson({ sceneName: 'Target' });
    const result = tools.insertSceneEvents({
      sceneName: 'Target',
      expectedEventsRevision: before.eventsRevision,
      eventsJson: sourceEvents.eventsJson,
      afterHandle: before.events[0].handle,
    });

    expect(result.inserted).toBe(1);
    expect(result.beforeEventsRevision).toBe(before.eventsRevision);
    expect(result.eventsRevision).not.toBe(before.eventsRevision);
    expect(target.getEvents().getEventsCount()).toBe(2);
    expect(
      target
        .getEvents()
        .getEventAt(0)
        .getType()
    ).toBe('BuiltinCommonInstructions::Comment');
    expect(
      target
        .getEvents()
        .getEventAt(1)
        .getType()
    ).toBe('BuiltinCommonInstructions::Standard');
    expect(result.events[0].path).toEqual([1]);
    expect(result.validation).toEqual({ ok: true, issues: [] });
    expect(result.diff).toMatchObject({
      operation: 'insert',
      beforeEventsRevision: before.eventsRevision,
      eventsRevision: result.eventsRevision,
      beforeEventCount: 1,
      afterEventCount: 2,
      inserted: [{ path: [1] }],
    });
    expect(diagnosticsTools.inspect).toHaveBeenCalledWith({
      includeNativeReport: false,
      includeAssets: false,
    });
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(onSceneEventsModifiedOutsideEditor).toHaveBeenCalledWith({
      scene: target,
      newOrChangedAiGeneratedEventIds: expect.any(Set),
    });
  });

  it('returns only native event validation issues for the mutated scene', () => {
    diagnosticsTools.inspect.mockReturnValue({
      issues: [
        {
          severity: 'error',
          category: 'events-validation',
          code: 'invalid-parameter',
          message: 'Invalid target scene parameter',
          details: { locationName: 'Target', eventPath: [0] },
        },
        {
          severity: 'error',
          category: 'events-validation',
          code: 'invalid-parameter',
          message: 'Different scene issue',
          details: { locationName: 'Source', eventPath: [0] },
        },
        {
          severity: 'error',
          category: 'resources',
          code: 'missing-resource-file',
          message: 'Unrelated issue',
        },
      ],
    });
    const tools = makeTools();
    const sourceEvents = tools.readSceneEventsJson({ sceneName: 'Source' });
    const before = tools.readSceneEventsJson({ sceneName: 'Target' });

    const result = tools.insertSceneEvents({
      sceneName: 'Target',
      expectedEventsRevision: before.eventsRevision,
      eventsJson: sourceEvents.eventsJson,
    });

    expect(result.validation.ok).toBe(false);
    expect(result.validation.issues).toHaveLength(1);
    expect(result.validation.issues[0]).toMatchObject({
      category: 'events-validation',
      message: 'Invalid target scene parameter',
    });
  });

  it('inserts and deletes a nested subevent by handle with revision preconditions', () => {
    const tools = makeTools();
    const parentRead = tools.readSceneEventsJson({ sceneName: 'Source' });
    const commentRead = tools.readSceneEventsJson({ sceneName: 'Target' });
    const inserted = tools.insertSceneEvents({
      sceneName: 'Source',
      expectedEventsRevision: parentRead.eventsRevision,
      eventsJson: commentRead.eventsJson,
      parentHandle: parentRead.events[0].handle,
    });

    expect(inserted.events[0].path).toEqual([0, 0]);
    expect(
      source
        .getEvents()
        .getEventAt(0)
        .getSubEvents()
        .getEventsCount()
    ).toBe(1);

    const deleted = tools.deleteSceneEvent({
      sceneName: 'Source',
      expectedEventsRevision: inserted.eventsRevision,
      handle: inserted.events[0].handle,
    });

    expect(deleted.deleted).toBe(true);
    expect(deleted.deletedEvent.path).toEqual([0, 0]);
    expect(deleted.eventsRevision).not.toBe(inserted.eventsRevision);
    expect(
      source
        .getEvents()
        .getEventAt(0)
        .getSubEvents()
        .getEventsCount()
    ).toBe(0);
  });

  it('moves an event subtree without rebuilding the scene event list', () => {
    const moveScene = project.insertNewLayout('Move', 2);
    moveScene
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Comment', 0);
    const movingEvent = moveScene
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Standard', 1);
    movingEvent
      .getSubEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Comment', 0);
    const tools = makeTools();
    const before = tools.readSceneEventsJson({ sceneName: 'Move' });
    const movingHandle = before.events[1].handle;

    const result = tools.moveSceneEvent({
      sceneName: 'Move',
      expectedEventsRevision: before.eventsRevision,
      handle: movingHandle,
      beforeHandle: before.events[0].handle,
    });

    expect(result.moved).toBe(true);
    expect(result.fromPath).toEqual([1]);
    expect(result.event.path).toEqual([0]);
    expect(result.event.handle).toBe(movingHandle);
    expect(
      moveScene
        .getEvents()
        .getEventAt(0)
        .getType()
    ).toBe('BuiltinCommonInstructions::Standard');
    expect(
      moveScene
        .getEvents()
        .getEventAt(0)
        .getSubEvents()
        .getEventsCount()
    ).toBe(1);
    expect(
      moveScene
        .getEvents()
        .getEventAt(1)
        .getType()
    ).toBe('BuiltinCommonInstructions::Comment');
  });

  it('updates one event node while preserving persistent identity and subevents by default', () => {
    const parent = source.getEvents().getEventAt(0);
    parent.setAiGeneratedEventId('stable-parent');
    parent
      .getSubEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Comment', 0);
    const tools = makeTools();
    const before = tools.readSceneEventsJson({ sceneName: 'Source' });
    const replacementJson: any = {
      ...before.eventsJson[0],
      disabled: true,
      actions: [
        {
          type: { value: 'NewAction' },
          parameters: ['Player', '42'],
          subInstructions: [],
        },
      ],
      events: [],
    };
    delete replacementJson.aiGeneratedEventId;

    const result = tools.updateSceneEvent({
      sceneName: 'Source',
      expectedEventsRevision: before.eventsRevision,
      handle: before.events[0].handle,
      eventJson: replacementJson,
    });

    const updated = source.getEvents().getEventAt(0);
    const standard = gd.asStandardEvent(updated);
    expect(updated.isDisabled()).toBe(true);
    expect(updated.getAiGeneratedEventId()).toBe('stable-parent');
    expect(updated.getSubEvents().getEventsCount()).toBe(1);
    expect(standard.getActions().size()).toBe(1);
    expect(
      standard
        .getActions()
        .get(0)
        .getType()
    ).toBe('NewAction');
    expect(
      standard
        .getActions()
        .get(0)
        .getParameter(1)
        .getPlainString()
    ).toBe('42');
    expect(result.event.handle).toBe('event:id:stable-parent');
    expect(result.eventsRevision).not.toBe(before.eventsRevision);
  });

  it('updates Group and Comment style without replacing identity, logic or subevents', () => {
    const tools = makeTools();
    tools.applySceneEventsJson({
      sceneName: 'Source',
      mode: 'replace',
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Group',
          aiGeneratedEventId: 'style-group',
          name: 'Gameplay group',
          source: '',
          creationTime: 1,
          colorR: 10,
          colorG: 20,
          colorB: 30,
          events: [
            {
              type: 'BuiltinCommonInstructions::Standard',
              conditions: [],
              actions: [
                {
                  type: { value: 'NewAction' },
                  parameters: ['Player', '42'],
                  subInstructions: [],
                },
              ],
            },
          ],
        },
        {
          type: 'BuiltinCommonInstructions::Comment',
          aiGeneratedEventId: 'style-comment',
          color: {
            r: 200,
            g: 210,
            b: 220,
            textR: 1,
            textG: 2,
            textB: 3,
          },
          comment: 'Keep this explanation intact.',
        },
      ],
    });
    triggerUnsavedChanges.mockClear();
    onSceneEventsModifiedOutsideEditor.mockClear();

    const before = tools.readSceneEventsJson({ sceneName: 'Source' });
    const groupBeforeJson = before.eventsJson[0];
    const groupResult = tools.updateSceneEventStyle({
      sceneName: 'Source',
      expectedEventsRevision: before.eventsRevision,
      handle: before.events[0].handle,
      style: { background: { r: 45, g: 100, b: 180 } },
    });

    expect(groupResult).toMatchObject({
      updated: true,
      changed: true,
      beforeStyle: { background: { r: 10, g: 20, b: 30 } },
      afterStyle: { background: { r: 45, g: 100, b: 180 } },
      event: { handle: 'event:id:style-group', path: [0] },
      diff: {
        operation: 'style-update',
        changed: true,
        beforeStyle: { background: { r: 10, g: 20, b: 30 } },
        afterStyle: { background: { r: 45, g: 100, b: 180 } },
      },
    });
    const afterGroup = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(afterGroup.eventsJson[0]).toMatchObject({
      aiGeneratedEventId: 'style-group',
      name: groupBeforeJson.name,
      source: groupBeforeJson.source,
      creationTime: groupBeforeJson.creationTime,
      colorR: 45,
      colorG: 100,
      colorB: 180,
    });
    expect(afterGroup.eventsJson[0].events).toEqual(groupBeforeJson.events);
    expect(afterGroup.eventsJson[0].actions).toEqual(groupBeforeJson.actions);
    expect(afterGroup.eventsJson[0].conditions).toEqual(
      groupBeforeJson.conditions
    );

    const commentBeforeJson = afterGroup.eventsJson[1];
    const commentResult = tools.updateSceneEventStyle({
      sceneName: 'Source',
      expectedEventsRevision: afterGroup.eventsRevision,
      handle: afterGroup.events[1].handle,
      style: {
        background: { r: 70, g: 80, b: 90 },
        text: { r: 240, g: 246, b: 252 },
      },
    });
    expect(commentResult).toMatchObject({
      updated: true,
      changed: true,
      beforeStyle: {
        background: { r: 200, g: 210, b: 220 },
        text: { r: 1, g: 2, b: 3 },
      },
      afterStyle: {
        background: { r: 70, g: 80, b: 90 },
        text: { r: 240, g: 246, b: 252 },
      },
      event: { handle: 'event:id:style-comment', path: [1] },
    });
    const afterComment = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(afterComment.eventsJson[1]).toMatchObject({
      aiGeneratedEventId: 'style-comment',
      comment: commentBeforeJson.comment,
      color: {
        r: 70,
        g: 80,
        b: 90,
        textR: 240,
        textG: 246,
        textB: 252,
      },
    });

    triggerUnsavedChanges.mockClear();
    onSceneEventsModifiedOutsideEditor.mockClear();
    const noOp = tools.updateSceneEventStyle({
      sceneName: 'Source',
      expectedEventsRevision: afterComment.eventsRevision,
      handle: afterComment.events[1].handle,
      style: {
        background: { r: 70, g: 80, b: 90 },
        text: { r: 240, g: 246, b: 252 },
      },
    });
    expect(noOp).toMatchObject({
      updated: false,
      changed: false,
      beforeEventsRevision: afterComment.eventsRevision,
      eventsRevision: afterComment.eventsRevision,
    });
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
    expect(onSceneEventsModifiedOutsideEditor).not.toHaveBeenCalled();
  });

  it('rejects unsupported event style targets and fields without mutation', () => {
    const tools = makeTools();
    const standard = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(() =>
      tools.updateSceneEventStyle({
        sceneName: 'Source',
        expectedEventsRevision: standard.eventsRevision,
        handle: standard.events[0].handle,
        style: { background: { r: 1, g: 2, b: 3 } },
      })
    ).toThrow(
      expect.objectContaining({
        code: 'event_style_unsupported_event_type',
      })
    );

    tools.applySceneEventsJson({
      sceneName: 'Source',
      mode: 'replace',
      eventsJson: [
        {
          type: 'BuiltinCommonInstructions::Group',
          name: 'Group',
          source: '',
          creationTime: 1,
          colorR: 10,
          colorG: 20,
          colorB: 30,
          events: [],
        },
      ],
    });
    triggerUnsavedChanges.mockClear();
    onSceneEventsModifiedOutsideEditor.mockClear();
    const group = tools.readSceneEventsJson({ sceneName: 'Source' });
    expect(() =>
      tools.updateSceneEventStyle({
        sceneName: 'Source',
        expectedEventsRevision: group.eventsRevision,
        handle: group.events[0].handle,
        style: { text: { r: 1, g: 2, b: 3 } },
      })
    ).toThrow(
      expect.objectContaining({
        code: 'event_style_field_unsupported',
        details: expect.objectContaining({
          field: 'text',
          supportedFields: ['background'],
        }),
      })
    );
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
    expect(onSceneEventsModifiedOutsideEditor).not.toHaveBeenCalled();
  });

  it('rejects localized edits when the scene event revision is stale', () => {
    const tools = makeTools();
    const read = tools.readSceneEventsJson({ sceneName: 'Target' });
    target
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Standard', 1);

    expect(() =>
      tools.deleteSceneEvent({
        sceneName: 'Target',
        expectedEventsRevision: read.eventsRevision,
        handle: read.events[0].handle,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'events_revision_conflict',
        details: expect.objectContaining({
          expectedEventsRevision: read.eventsRevision,
        }),
      })
    );
    expect(() =>
      tools.updateSceneEventStyle({
        sceneName: 'Target',
        expectedEventsRevision: read.eventsRevision,
        handle: read.events[0].handle,
        style: { background: { r: 1, g: 2, b: 3 } },
      })
    ).toThrow(
      expect.objectContaining({
        code: 'events_revision_conflict',
        details: expect.objectContaining({
          expectedEventsRevision: read.eventsRevision,
        }),
      })
    );
    expect(() =>
      tools.patchEvent({
        sceneName: 'Target',
        expectedEventsRevision: read.eventsRevision,
        operation: {
          kind: 'event.fields.update',
          eventHandle: read.events[0].handle,
          fields: { comment: 'stale write must not land' },
        },
      })
    ).toThrow(
      expect.objectContaining({
        code: 'events_revision_conflict',
        details: expect.objectContaining({
          conflictScope: 'events',
          expectedEventsRevision: read.eventsRevision,
          actualEventsRevision: expect.stringMatching(/^events:[0-9a-f]{32}$/),
        }),
      })
    );
    expect(target.getEvents().getEventsCount()).toBe(2);
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
    expect(onSceneEventsModifiedOutsideEditor).not.toHaveBeenCalled();
  });

  it('reads and mutates External Events with the same canonical revisions and handles', () => {
    const externalEvents = project.insertNewExternalEvents('SharedLogic', 0);
    externalEvents.setAssociatedLayout('Target');
    externalEvents
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Standard', 0);
    const targetDescriptor = {
      kind: 'external-events',
      externalEventsName: 'SharedLogic',
    };
    const tools = makeTools();
    const before = tools.readEventsJson({ target: targetDescriptor });
    const comment = tools.readSceneEventsJson({ sceneName: 'Target' });

    expect(before).toMatchObject({
      target: {
        kind: 'external-events',
        externalEventsName: 'SharedLogic',
      },
      eventsCount: 1,
    });
    expect(before.events[0].handle).toMatch(/^event:fp:[0-9a-f]{32}$/);

    const inserted = tools.insertEvents({
      target: targetDescriptor,
      expectedEventsRevision: before.eventsRevision,
      eventsJson: comment.eventsJson,
      afterHandle: before.events[0].handle,
    });
    expect(inserted.events[0].path).toEqual([1]);
    expect(inserted.eventsRevision).not.toBe(before.eventsRevision);
    expect(externalEvents.getEvents().getEventsCount()).toBe(2);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(onSceneEventsModifiedOutsideEditor).not.toHaveBeenCalled();

    const deleted = tools.deleteEvent({
      target: targetDescriptor,
      expectedEventsRevision: inserted.eventsRevision,
      handle: inserted.events[0].handle,
    });
    expect(deleted.deleted).toBe(true);
    expect(externalEvents.getEvents().getEventsCount()).toBe(1);
  });

  it('reads and mutates a free extension function with the same canonical revisions and handles', () => {
    const extension = project.insertNewEventsFunctionsExtension('Logic', 0);
    const eventsFunction = extension
      .getEventsFunctions()
      .insertNewEventsFunction('Tick', 0);
    eventsFunction.setFunctionType(gd.EventsFunction.Action);
    eventsFunction
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Standard', 0);
    const targetDescriptor = {
      kind: 'extension-function',
      extensionName: 'Logic',
      functionName: 'Tick',
    };
    const tools = makeTools();
    const before = tools.readEventsJson({ target: targetDescriptor });
    const comment = tools.readSceneEventsJson({ sceneName: 'Target' });

    expect(before).toMatchObject({
      target: {
        kind: 'extension-function',
        extensionName: 'Logic',
        ownerKind: 'extension',
        functionName: 'Tick',
      },
      eventsCount: 1,
    });
    expect(before.events[0].handle).toMatch(/^event:fp:[0-9a-f]{32}$/);

    const inserted = tools.insertEvents({
      target: targetDescriptor,
      expectedEventsRevision: before.eventsRevision,
      eventsJson: comment.eventsJson,
      afterHandle: before.events[0].handle,
    });
    expect(inserted.events[0].path).toEqual([1]);
    expect(inserted.eventsRevision).not.toBe(before.eventsRevision);
    expect(eventsFunction.getEvents().getEventsCount()).toBe(2);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(onSceneEventsModifiedOutsideEditor).not.toHaveBeenCalled();

    const deleted = tools.deleteEvent({
      target: targetDescriptor,
      expectedEventsRevision: inserted.eventsRevision,
      handle: inserted.events[0].handle,
    });
    expect(deleted.deleted).toBe(true);
    expect(eventsFunction.getEvents().getEventsCount()).toBe(1);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(2);
    expect(forceUpdate).toHaveBeenCalledTimes(2);
    expect(onSceneEventsModifiedOutsideEditor).not.toHaveBeenCalled();
  });

  it('filters post-patch validation to the targeted object method', () => {
    const extension = project.insertNewEventsFunctionsExtension(
      'ObjectLogic',
      0
    );
    const object = extension.getEventsBasedObjects().insertNew('Panel', 0);
    const eventsFunction = object
      .getEventsFunctions()
      .insertNewEventsFunction('Refresh', 0);
    eventsFunction.setFunctionType(gd.EventsFunction.Action);
    eventsFunction
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Standard', 0);
    diagnosticsTools.inspect.mockReturnValue({
      issues: [
        {
          severity: 'error',
          category: 'events-validation',
          message: 'Panel refresh issue',
          objectName: 'Panel',
          details: {
            locationType: 'extension',
            extensionName: 'ObjectLogic',
            functionName: 'Refresh',
          },
        },
        {
          severity: 'error',
          category: 'events-validation',
          message: 'Other object issue',
          objectName: 'Other',
          details: {
            locationType: 'extension',
            extensionName: 'ObjectLogic',
            functionName: 'Refresh',
          },
        },
        {
          severity: 'error',
          category: 'events-validation',
          message: 'Scene issue',
          details: { locationType: 'scene', locationName: 'Target' },
        },
      ],
    });
    const tools = makeTools();
    const targetDescriptor = {
      kind: 'extension-function',
      extensionName: 'ObjectLogic',
      ownerKind: 'object',
      ownerName: 'Panel',
      functionName: 'Refresh',
    };
    const before = tools.readEventsJson({ target: targetDescriptor });
    const comment = tools.readSceneEventsJson({ sceneName: 'Target' });
    const inserted = tools.insertEvents({
      target: targetDescriptor,
      expectedEventsRevision: before.eventsRevision,
      eventsJson: comment.eventsJson,
    });

    expect(inserted.validation.ok).toBe(false);
    expect(inserted.validation.issues).toHaveLength(1);
    expect(inserted.validation.issues[0].message).toBe('Panel refresh issue');
  });

  it('replaces scene events from native serialized JSON', () => {
    const tools = makeTools();
    const sourceEvents = tools.readSceneEventsJson({ sceneName: 'Source' });
    const result = tools.applySceneEventsJson({
      sceneName: 'Target',
      eventsJson: sourceEvents.eventsJson,
      mode: 'replace',
    });

    expect(result).toMatchObject({
      applied: true,
      sceneName: 'Target',
      mode: 'replace',
      beforeCount: 1,
      incomingCount: 1,
      afterCount: 1,
    });
    expect(
      target
        .getEvents()
        .getEventAt(0)
        .getType()
    ).toBe('BuiltinCommonInstructions::Standard');
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(onSceneEventsModifiedOutsideEditor).toHaveBeenCalledWith({
      scene: target,
      newOrChangedAiGeneratedEventIds: expect.any(Set),
    });
  });

  it('appends native serialized events without replacing existing ones', () => {
    const tools = makeTools();
    const sourceEvents = tools.readSceneEventsJson({ sceneName: 'Source' });
    const result = tools.applySceneEventsJson({
      sceneName: 'Target',
      eventsJson: sourceEvents.eventsJson,
      mode: 'append',
    });

    expect(result.afterCount).toBe(2);
    expect(
      target
        .getEvents()
        .getEventAt(0)
        .getType()
    ).toBe('BuiltinCommonInstructions::Comment');
    expect(
      target
        .getEvents()
        .getEventAt(1)
        .getType()
    ).toBe('BuiltinCommonInstructions::Standard');
  });

  it('rejects invalid serialized events before mutating the scene', () => {
    const tools = makeTools();
    expect(() =>
      tools.applySceneEventsJson({
        sceneName: 'Target',
        eventsJson: { not: 'an events list' },
      })
    ).toThrow('invalid_events_json');
    expect(target.getEvents().getEventsCount()).toBe(1);
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
  });
});
