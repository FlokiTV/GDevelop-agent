// @flow
import {
  createExtensionLifecycleService,
  extensionLifecycleInternals,
} from './ExtensionLifecycleService';
import { makeTestExtensions } from '../../fixtures/TestExtensions';

const gd: libGDevelop = global.gd;

const makeHeader = ({
  name,
  version = '1.0.0',
  requiredExtensions = [],
}: any) => ({
  tier: 'reviewed',
  authorIds: [],
  extensionNamespace: name,
  fullName: `${name} full`,
  name,
  version,
  gdevelopVersion: '',
  url: `https://example.invalid/${name}.json`,
  headerUrl: `https://example.invalid/${name}-header.json`,
  tags: ['test'],
  category: 'Test',
  previewIconUrl: '',
  changelog: [],
  requiredExtensions,
  shortDescription: `${name} description`,
  eventsBasedBehaviorsCount: 0,
  eventsFunctionsCount: 0,
  eventsBasedObjects: [],
  helpPath: '',
});

const makeSerializedExtension = (name: string, version: string = '1.0.0') => ({
  author: '',
  category: '',
  dimension: '',
  extensionNamespace: name,
  fullName: `${name} full`,
  gdevelopVersion: '',
  helpPath: '',
  iconUrl: '',
  name,
  previewIconUrl: '',
  shortDescription: '',
  version,
  description: '',
  tags: [],
  authorIds: [],
  dependencies: [],
  globalVariables: [],
  sceneVariables: [],
  eventsFunctions: [],
  eventsFunctionsFolderStructure: { folderName: '__ROOT', children: [] },
  eventsBasedBehaviors: [],
  eventsBasedObjects: [],
});

describe('AgentIntegration ExtensionLifecycleService', () => {
  let project: gdProject;
  let lifecycle: any;
  let triggerUnsavedChanges: jest.Mock<any, any>;
  let forceUpdate: jest.Mock<any, any>;
  let onWillInstallExtension: jest.Mock<any, any>;
  let onExtensionInstalled: jest.Mock<any, any>;
  let registry: any;
  let service: any;

  beforeAll(() => {
    makeTestExtensions(gd);
  });

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    onWillInstallExtension = jest.fn();
    onExtensionInstalled = jest.fn();
    lifecycle = {
      ensureLoadFinished: jest.fn(() => Promise.resolve()),
      loadProjectEventsFunctionsExtensions: jest.fn(() => Promise.resolve()),
      unloadProjectEventsFunctionsExtension: jest.fn(),
      reloadProjectEventsFunctionsExtensions: jest.fn(() => Promise.resolve()),
    };
    registry = {
      version: 'test-registry',
      headers: [
        makeHeader({ name: 'DependencyExt' }),
        makeHeader({
          name: 'StoreExt',
          requiredExtensions: [
            { extensionName: 'DependencyExt', extensionVersion: '1.0.0' },
          ],
        }),
      ],
      views: { default: { firstIds: [] } },
    };
    service = createExtensionLifecycleService({
      project,
      eventsFunctionsExtensionsState: lifecycle,
      triggerUnsavedChanges,
      forceUpdate,
      onWillInstallExtension,
      onExtensionInstalled,
      registryProvider: jest.fn(() => Promise.resolve(registry)),
      serializedExtensionProvider: jest.fn(header =>
        Promise.resolve(makeSerializedExtension(header.name, header.version))
      ),
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('searches catalog metadata and reports installed state deterministically', async () => {
    const result = await service.searchCatalog({ query: 'store', limit: 10 });
    expect(result.registryVersion).toBe('test-registry');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      name: 'StoreExt',
      version: '1.0.0',
      installed: false,
      requiredExtensions: [
        { extensionName: 'DependencyExt', extensionVersion: '1.0.0' },
      ],
    });

    const described = await service.describeCatalog({ name: 'StoreExt' });
    expect(described.extension.name).toBe('StoreExt');
  });

  it('installs a dependency closure and classifies store extensions separately from built-ins/project extensions', async () => {
    const local = project.insertNewEventsFunctionsExtension('LocalExt', 0);
    local.setVersion('0.1.0');

    const result = await service.install({ name: 'StoreExt' });
    expect(result.changed).toBe(true);
    expect(result.installed.map(item => item.name)).toEqual([
      'DependencyExt',
      'StoreExt',
    ]);
    expect(onWillInstallExtension).toHaveBeenCalledWith([
      'DependencyExt',
      'StoreExt',
    ]);
    expect(onExtensionInstalled).toHaveBeenCalledWith([
      'DependencyExt',
      'StoreExt',
    ]);
    expect(lifecycle.loadProjectEventsFunctionsExtensions).toHaveBeenCalledWith(
      project
    );
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledTimes(1);

    expect(
      project.getEventsFunctionsExtension('StoreExt').getOriginName()
    ).toBe('gdevelop-extension-store');
    const installed = service.listInstalled();
    expect(installed.counts.store).toBe(2);
    expect(installed.counts.project).toBe(1);
    expect(installed.counts.builtIn).toBeGreaterThan(0);
    expect(installed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'StoreExt', source: 'store' }),
        expect.objectContaining({ name: 'LocalExt', source: 'project' }),
        expect.objectContaining({ source: 'built-in' }),
      ])
    );
  });

  it('refuses store install when a project-authored extension owns the same name', async () => {
    project.insertNewEventsFunctionsExtension('StoreExt', 0);
    await expect(service.install({ name: 'StoreExt' })).rejects.toMatchObject({
      code: 'extension_name_conflict',
    });
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
  });

  it('removes only store-managed project extensions and uses the lifecycle unload/reload path', async () => {
    await service.install({ name: 'StoreExt' });
    triggerUnsavedChanges.mockClear();
    forceUpdate.mockClear();

    // Regression: read blockers before removing, as an MCP client normally
    // does. The libGD [Value] wrappers must remain safe across repeated scans.
    expect(service.inspectInstalled({ name: 'StoreExt' })).toMatchObject({
      extension: { name: 'StoreExt', source: 'store' },
    });
    const result = await service.remove({ name: 'StoreExt' });
    expect(result).toMatchObject({ removed: true, name: 'StoreExt' });
    expect(project.hasEventsFunctionsExtensionNamed('StoreExt')).toBe(false);
    expect(
      lifecycle.unloadProjectEventsFunctionsExtension
    ).toHaveBeenCalledWith(project, 'StoreExt');
    expect(
      lifecycle.reloadProjectEventsFunctionsExtensions
    ).toHaveBeenCalledWith(project);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledTimes(1);

    project.insertNewEventsFunctionsExtension('LocalExt', 0);
    await expect(service.remove({ name: 'LocalExt' })).rejects.toMatchObject({
      code: 'project_extension_requires_authoring_delete',
    });
  });

  it('updates managed store extensions to a newer catalog version', async () => {
    await service.install({ name: 'StoreExt' });
    registry.headers = registry.headers.map(header =>
      header.name === 'StoreExt'
        ? { ...header, version: '2.0.0', changelog: [] }
        : header
    );

    const result = await service.update({ name: 'StoreExt' });
    expect(result).toMatchObject({
      changed: true,
      mode: 'update',
      requested: 'StoreExt',
      installed: [{ name: 'StoreExt', version: '2.0.0' }],
    });
    expect(project.getEventsFunctionsExtension('StoreExt').getVersion()).toBe(
      '2.0.0'
    );
  });

  it('blocks removal when another installed extension depends on the target', async () => {
    const blockerService = createExtensionLifecycleService({
      project,
      eventsFunctionsExtensionsState: lifecycle,
      triggerUnsavedChanges,
      forceUpdate,
      onWillInstallExtension,
      onExtensionInstalled,
      registryProvider: jest.fn(() => Promise.resolve(registry)),
      serializedExtensionProvider: jest.fn(header =>
        Promise.resolve(makeSerializedExtension(header.name, header.version))
      ),
      deleteBlockersProvider: () => ({
        usedByProject: false,
        dependentExtensions: ['StoreExt'],
      }),
    });
    await blockerService.install({ name: 'StoreExt' });
    await expect(
      blockerService.remove({ name: 'DependencyExt' })
    ).rejects.toMatchObject({
      code: 'extension_in_use',
      details: expect.objectContaining({
        dependentExtensions: expect.arrayContaining(['StoreExt']),
      }),
    });
    expect(project.hasEventsFunctionsExtensionNamed('DependencyExt')).toBe(
      true
    );
  });

  it('resolves dependency closures dependency-first and detects missing dependencies', () => {
    const headers = new Map(
      registry.headers.map(header => [header.name, header])
    );
    expect(
      extensionLifecycleInternals
        .resolveDependencyClosure(headers, 'StoreExt')
        .map(header => header.name)
    ).toEqual(['DependencyExt', 'StoreExt']);
    expect(() =>
      extensionLifecycleInternals.resolveDependencyClosure(
        headers,
        'MissingExt'
      )
    ).toThrow('extension_dependency_not_found');
  });
});
