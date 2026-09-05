// @flow
import { createEventTools } from './EventTools';

const gd: libGDevelop = global.gd;

describe('AgentIntegration EventTools', () => {
  let project: gdProject;
  let source: gdLayout;
  let target: gdLayout;
  let diagnosticsTools;
  let triggerUnsavedChanges;
  let onSceneEventsModifiedOutsideEditor;

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
    triggerUnsavedChanges = jest.fn();
    onSceneEventsModifiedOutsideEditor = jest.fn();
  });

  afterEach(() => {
    project.delete();
  });

  const makeTools = () =>
    createEventTools({
      project,
      diagnosticsTools,
      triggerUnsavedChanges,
      onSceneEventsModifiedOutsideEditor,
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
    expect(target.getEvents().getEventAt(0).getType()).toBe(
      'BuiltinCommonInstructions::Comment'
    );
    expect(target.getEvents().getEventAt(1).getType()).toBe(
      'BuiltinCommonInstructions::Standard'
    );
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
    expect(source.getEvents().getEventAt(0).getSubEvents().getEventsCount()).toBe(
      1
    );

    const deleted = tools.deleteSceneEvent({
      sceneName: 'Source',
      expectedEventsRevision: inserted.eventsRevision,
      handle: inserted.events[0].handle,
    });

    expect(deleted.deleted).toBe(true);
    expect(deleted.deletedEvent.path).toEqual([0, 0]);
    expect(deleted.eventsRevision).not.toBe(inserted.eventsRevision);
    expect(source.getEvents().getEventAt(0).getSubEvents().getEventsCount()).toBe(
      0
    );
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
    expect(moveScene.getEvents().getEventAt(0).getType()).toBe(
      'BuiltinCommonInstructions::Standard'
    );
    expect(
      moveScene.getEvents().getEventAt(0).getSubEvents().getEventsCount()
    ).toBe(1);
    expect(moveScene.getEvents().getEventAt(1).getType()).toBe(
      'BuiltinCommonInstructions::Comment'
    );
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
    expect(standard.getActions().get(0).getType()).toBe('NewAction');
    expect(standard.getActions().get(0).getParameter(1).getPlainString()).toBe(
      '42'
    );
    expect(result.event.handle).toBe('event:id:stable-parent');
    expect(result.eventsRevision).not.toBe(before.eventsRevision);
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
    expect(target.getEvents().getEventsCount()).toBe(2);
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
    expect(onSceneEventsModifiedOutsideEditor).not.toHaveBeenCalled();
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
