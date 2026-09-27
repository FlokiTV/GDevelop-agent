// @flow
import {
  analyzeExternalEventsRenameImpact,
  analyzeSceneRenameImpact,
} from './ProjectStructureImpact';

const gd: libGDevelop = global.gd;

describe('ProjectStructureImpact', () => {
  let project: gdProject;

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
  });

  afterEach(() => {
    project.delete();
  });

  it('reports scene references using the native refactorer without mutating the real project', () => {
    project.insertNewLayout('Menu', 0);
    project.insertNewLayout('Game', 1);
    project.setFirstLayout('Game');
    project.setPreviewLayout('Game');
    const externalEvents = project.insertNewExternalEvents('Shared', 0);
    externalEvents.setAssociatedLayout('Game');
    const externalLayout = project.insertNewExternalLayout('Overlay', 0);
    externalLayout.setAssociatedLayout('Game');

    const impact = analyzeSceneRenameImpact(project, 'Game');

    expect(project.hasLayoutNamed('Game')).toBe(true);
    expect(project.hasLayoutNamed('__GDevelopAgentSceneTarget__')).toBe(false);
    expect(impact.total).toBeGreaterThanOrEqual(4);
    expect(impact.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'firstLayout',
          before: 'Game',
          kind: 'project-first-scene',
        }),
        expect.objectContaining({
          path: 'previewLayout',
          before: 'Game',
          kind: 'project-preview-scene',
        }),
        expect.objectContaining({
          before: 'Game',
          kind: 'external-events-associated-scene',
        }),
        expect.objectContaining({
          before: 'Game',
          kind: 'external-layout-associated-scene',
        }),
      ])
    );
  });

  it('reports External Events links using the native refactorer without mutating the real project', () => {
    const scene = project.insertNewLayout('Game', 0);
    project.insertNewExternalEvents('Shared', 0);
    const linkBaseEvent = scene
      .getEvents()
      .insertNewEvent(project, 'BuiltinCommonInstructions::Link', 0);
    gd.asLinkEvent(linkBaseEvent).setTarget('Shared');

    const impact = analyzeExternalEventsRenameImpact(project, 'Shared');

    expect(project.hasExternalEventsNamed('Shared')).toBe(true);
    expect(
      project.hasExternalEventsNamed('__GDevelopAgentExternalEventsTarget__')
    ).toBe(false);
    expect(impact.total).toBeGreaterThanOrEqual(1);
    expect(impact.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          before: 'Shared',
          kind: 'event-reference',
        }),
      ])
    );
  });
});
