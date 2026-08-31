// @flow
import { createEventTools } from './EventTools';

const gd: libGDevelop = global.gd;

describe('AgentApi EventTools', () => {
  let project: gdProject;
  let source: gdLayout;
  let target: gdLayout;
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
    triggerUnsavedChanges = jest.fn();
    onSceneEventsModifiedOutsideEditor = jest.fn();
  });

  afterEach(() => {
    project.delete();
  });

  const makeTools = () =>
    createEventTools({
      project,
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
