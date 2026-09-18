// @flow
import { createBuildService } from './BuildService';

jest.mock(
  '../../ExportAndShare/LocalExporters/LocalOnlineElectronExport',
  () => ({
    localOnlineElectronExportPipeline: {},
  })
);
jest.mock(
  '../../ExportAndShare/LocalExporters/LocalOnlineCordovaExport',
  () => ({
    localOnlineCordovaExportPipeline: {},
  })
);
jest.mock('../../ExportAndShare/LocalExporters/LocalOnlineWebExport', () => ({
  localOnlineWebExportPipeline: {},
}));

const gd: libGDevelop = global.gd;

const addImageResource = (project, name) => {
  const resource = new gd.ImageResource();
  try {
    resource.setName(name);
    resource.setFile(name);
    project.getResourcesManager().addResource(resource);
  } finally {
    resource.delete();
  }
};

const makePipeline = (name, buildType) => {
  const build = {
    id: `${name}-build-1`,
    userId: 'secret-user-id',
    bucket: 'secret-bucket',
    logsKey: 'secret-log-key',
    status: 'pending',
    type: buildType,
    targets:
      name === 'electron'
        ? ['winExe']
        : name === 'cordova'
        ? ['androidApk']
        : ['s3'],
    ...(name === 'web' ? { s3Key: 'private-web-storage-key' } : {}),
    updatedAt: 123,
  };
  return {
    name,
    getInitialExportState: jest.fn(() =>
      name === 'web' ? null : { targets: [] }
    ),
    prepareExporter: jest.fn(async () => ({
      exporter: { delete: jest.fn() },
    })),
    launchExport: jest.fn(async () => ({ exported: true })),
    launchResourcesDownload: jest.fn(async () => ({ downloaded: true })),
    launchCompression: jest.fn(async () => 'C:/temp/game-archive.zip'),
    launchUpload: jest.fn(async () => 'private-upload-bucket-key'),
    launchOnlineBuild: jest.fn(async () => build),
  };
};

const makeAuthenticatedUser = () => ({
  authenticated: true,
  firebaseUser: { uid: 'firebase-user-id' },
  profile: { id: 'profile-id', username: 'Agent Tester' },
  getAuthorizationHeader: jest.fn(async () => 'Bearer secret-token'),
  onRefreshLimits: jest.fn(async () => {}),
});

describe('AgentIntegration BuildService', () => {
  let project: gdProject;
  let triggerUnsavedChanges;
  let forceUpdate;
  let electronPipeline;
  let cordovaPipeline;
  let webPipeline;
  let authenticatedUser;
  let getBuildById;
  let service;

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('Build Service Test');
    project.setPackageName('com.example.buildtest');
    project.setVersion('1.2.3');
    project.setOrientation('landscape');
    addImageResource(project, 'icon.png');
    addImageResource(project, 'loading.png');
    triggerUnsavedChanges = jest.fn();
    forceUpdate = jest.fn();
    electronPipeline = makePipeline('electron', 'electron-build');
    cordovaPipeline = makePipeline('cordova', 'cordova-build');
    webPipeline = makePipeline('web', 'web-build');
    authenticatedUser = makeAuthenticatedUser();
    getBuildById = jest.fn();
    service = createBuildService({
      project,
      i18n: { _: value => value },
      authenticatedUser,
      eventsFunctionsExtensionsState: {
        ensureLoadFinished: jest.fn(async () => {}),
      },
      triggerUnsavedChanges,
      forceUpdate,
      isDesktopEnvironment: true,
      electronPipeline,
      cordovaPipeline,
      webPipeline,
      getBuildById,
    });
  });

  afterEach(() => {
    project.delete();
  });

  it('discovers local, authenticated remote and explicit unsupported targets without secrets', () => {
    const result = service.listTargets();
    const html5 = result.targets.find(target => target.id === 'html5-local');
    const web = result.targets.find(target => target.id === 'web-online');
    const windows = result.targets.find(target => target.id === 'windows-exe');
    const ios = result.targets.find(target => target.id === 'ios-app-store');

    expect(html5).toMatchObject({
      deliveryKind: 'local-export',
      command: 'export.html5',
      availability: { state: 'available' },
    });
    expect(web).toMatchObject({
      deliveryKind: 'remote-build',
      platform: 'web',
      artifactKind: 'web',
      installable: false,
      provider: { buildType: 'web-build', target: 's3' },
      availability: { state: 'available' },
    });
    expect(windows).toMatchObject({
      deliveryKind: 'remote-build',
      installable: true,
      provider: { buildType: 'electron-build', target: 'winExe' },
      availability: { state: 'available' },
    });
    expect(ios).toMatchObject({
      availability: {
        state: 'unsupported',
        code: 'signing_configuration_not_exposed',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret|firebase-user-id|profile-id/i
    );
  });

  it('reports remote targets as unavailable when authentication is absent', () => {
    const loggedOutService = createBuildService({
      project,
      i18n: { _: value => value },
      authenticatedUser: { firebaseUser: null },
      eventsFunctionsExtensionsState: {},
      triggerUnsavedChanges,
      forceUpdate,
      isDesktopEnvironment: true,
      electronPipeline,
      cordovaPipeline,
      webPipeline,
      getBuildById,
    });
    const windows = loggedOutService
      .listTargets()
      .targets.find(target => target.id === 'windows-exe');
    expect(windows.availability).toEqual({
      state: 'unavailable',
      code: 'authentication_required',
      retryable: true,
    });
  });

  it('round-trips native packaging, icon, splash and loading-screen configuration', () => {
    const applied = service.applyConfiguration({
      packageName: 'com.example.changed',
      version: '2.0.0',
      orientation: 'portrait',
      icons: {
        desktop: [{ size: 512, resourceName: 'icon.png' }],
        android: [{ size: 192, resourceName: 'icon.png' }],
        ios: [{ size: 1024, resourceName: 'icon.png' }],
      },
      splash: {
        androidWindowSplashScreenAnimatedIconResourceName: 'icon.png',
      },
      loadingScreen: {
        backgroundImageResourceName: 'loading.png',
        backgroundColor: 12345,
        minDuration: 250,
        showProgressBar: true,
        progressBarWidthPercent: 70,
      },
    });

    expect(applied.changed).toBe(true);
    expect(applied.configuration).toMatchObject({
      packageName: 'com.example.changed',
      version: '2.0.0',
      orientation: 'portrait',
      icons: {
        desktop: [{ size: 512, resourceName: 'icon.png' }],
      },
      splash: {
        androidWindowSplashScreenAnimatedIconResourceName: 'icon.png',
      },
      loadingScreen: {
        backgroundImageResourceName: 'loading.png',
        backgroundColor: 12345,
        minDuration: 250,
        showProgressBar: true,
        progressBarWidthPercent: 70,
      },
    });
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledTimes(1);

    const noop = service.applyConfiguration({
      packageName: 'com.example.changed',
    });
    expect(noop.changed).toBe(false);
    expect(triggerUnsavedChanges).toHaveBeenCalledTimes(1);
  });

  it('rejects missing or non-image build resources before dirtying the project', () => {
    expect(() =>
      service.applyConfiguration({
        icons: { desktop: [{ size: 512, resourceName: 'missing.png' }] },
      })
    ).toThrow('Build configuration resource was not found');
    expect(triggerUnsavedChanges).not.toHaveBeenCalled();
  });

  it('starts web, desktop and Android provider builds through the official injected pipelines without returning upload secrets', async () => {
    const web = await service.start({ targetId: 'web-online' });
    expect(webPipeline.launchOnlineBuild).toHaveBeenCalledWith(
      null,
      authenticatedUser,
      expect.any(String),
      project.getProjectUuid(),
      { gameName: 'Build Service Test', gameVersion: '1.2.3' },
      false
    );
    expect(web).toMatchObject({
      started: true,
      targetId: 'web-online',
      build: {
        buildId: 'web-build-1',
        status: 'pending',
        buildType: 'web-build',
      },
    });

    const windows = await service.start({ targetId: 'windows-exe' });
    expect(electronPipeline.launchOnlineBuild).toHaveBeenCalledWith(
      expect.objectContaining({ targets: ['winExe'] }),
      authenticatedUser,
      'private-upload-bucket-key',
      project.getProjectUuid(),
      { gameName: 'Build Service Test', gameVersion: '1.2.3' },
      false
    );
    expect(windows).toMatchObject({
      started: true,
      targetId: 'windows-exe',
      build: {
        buildId: 'electron-build-1',
        status: 'pending',
        buildType: 'electron-build',
      },
    });
    expect(JSON.stringify(windows)).not.toMatch(
      /secret-user-id|secret-bucket|secret-log-key|private-upload-bucket-key/
    );

    await service.start({
      targetId: 'android-apk',
      androidKeystore: 'old',
      payWithCredits: true,
    });
    expect(cordovaPipeline.launchOnlineBuild).toHaveBeenCalledWith(
      expect.objectContaining({ targets: ['androidApk'], keystore: 'old' }),
      authenticatedUser,
      'private-upload-bucket-key',
      project.getProjectUuid(),
      { gameName: 'Build Service Test', gameVersion: '1.2.3' },
      true
    );
  });

  it('rejects local export and unavailable targets through typed build errors', async () => {
    await expect(
      service.start({ targetId: 'html5-local' })
    ).rejects.toMatchObject({
      code: 'build_target_uses_export_command',
    });
    await expect(
      service.start({ targetId: 'ios-app-store' })
    ).rejects.toMatchObject({
      code: 'build_target_unsupported',
      details: { reasonCode: 'signing_configuration_not_exposed' },
    });
  });

  it('sanitizes status/result and returns only public artifact URLs', async () => {
    getBuildById.mockResolvedValue({
      id: 'remote-build-9',
      userId: 'private-user',
      bucket: 'private-bucket',
      logsKey: 'private/log.txt',
      windowsExeKey: 'public/build/game.exe',
      status: 'complete',
      type: 'electron-build',
      targets: ['winExe'],
      createdAt: 100,
      updatedAt: 200,
      detectedErrors: [],
    });

    const status = await service.status({ buildId: 'remote-build-9' });
    expect(status).toEqual({
      build: {
        buildId: 'remote-build-9',
        status: 'complete',
        buildType: 'electron-build',
        targets: ['winExe'],
        createdAt: 100,
        updatedAt: 200,
        detectedErrors: [],
      },
    });
    const result = await service.result({ buildId: 'remote-build-9' });
    expect(result).toMatchObject({
      ready: true,
      succeeded: true,
      artifacts: [
        {
          targetId: 'windows-exe',
          artifactKind: 'exe',
          installable: true,
          url: 'https://builds.gdevelop-app.com/public/build/game.exe',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-user|private-bucket|private\/log/
    );
  });

  it('reports provider cancellation as unsupported instead of deleting a build', async () => {
    getBuildById.mockResolvedValue({
      id: 'remote-build-10',
      userId: 'private-user',
      status: 'pending',
      type: 'electron-build',
      targets: ['winExe'],
      updatedAt: 200,
    });
    await expect(
      service.cancel({ buildId: 'remote-build-10' })
    ).resolves.toMatchObject({
      cancelled: false,
      supported: false,
      reasonCode: 'provider_cancel_not_supported',
      build: { status: 'pending' },
    });
  });
});
