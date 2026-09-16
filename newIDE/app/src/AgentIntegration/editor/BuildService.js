// @flow
import { AgentError } from '../core/AgentError';
import { localOnlineElectronExportPipeline } from '../../ExportAndShare/LocalExporters/LocalOnlineElectronExport';
import { localOnlineCordovaExportPipeline } from '../../ExportAndShare/LocalExporters/LocalOnlineCordovaExport';
import {
  getBuild,
  getBuildArtifactUrl,
} from '../../Utils/GDevelopServices/Build';

const DESKTOP_ICON_SIZES = [512];
const ANDROID_ICON_SIZES = [192, 144, 96, 72, 48, 36];
const IOS_ICON_SIZES = [
  1024,
  180,
  167,
  152,
  144,
  120,
  114,
  100,
  87,
  80,
  76,
  72,
  60,
  58,
  57,
  50,
  40,
  29,
  20,
];

const REMOTE_TARGETS = [
  {
    id: 'windows-exe',
    label: 'Windows executable installer',
    platform: 'windows',
    artifactKind: 'exe',
    providerTarget: 'winExe',
    artifactKey: 'windowsExeKey',
    pipeline: 'electron',
    buildType: 'electron-build',
    installable: true,
  },
  {
    id: 'windows-zip',
    label: 'Windows portable ZIP',
    platform: 'windows',
    artifactKind: 'zip',
    providerTarget: 'winZip',
    artifactKey: 'windowsZipKey',
    pipeline: 'electron',
    buildType: 'electron-build',
    installable: false,
  },
  {
    id: 'macos-zip',
    label: 'macOS application ZIP',
    platform: 'macos',
    artifactKind: 'zip',
    providerTarget: 'macZip',
    artifactKey: 'macosZipKey',
    pipeline: 'electron',
    buildType: 'electron-build',
    installable: true,
  },
  {
    id: 'linux-appimage',
    label: 'Linux AppImage',
    platform: 'linux',
    artifactKind: 'appimage',
    providerTarget: 'linuxAppImage',
    artifactKey: 'linuxAppImageKey',
    pipeline: 'electron',
    buildType: 'electron-build',
    installable: true,
  },
  {
    id: 'android-apk',
    label: 'Android APK',
    platform: 'android',
    artifactKind: 'apk',
    providerTarget: 'androidApk',
    artifactKey: 'apkKey',
    pipeline: 'cordova',
    buildType: 'cordova-build',
    installable: true,
  },
  {
    id: 'android-app-bundle',
    label: 'Android App Bundle',
    platform: 'android',
    artifactKind: 'aab',
    providerTarget: 'androidAppBundle',
    artifactKey: 'aabKey',
    pipeline: 'cordova',
    buildType: 'cordova-build',
    installable: true,
  },
];

const IOS_UNSUPPORTED_TARGETS = [
  {
    id: 'ios-app-store',
    label: 'iOS App Store IPA',
    platform: 'ios',
    artifactKind: 'ipa',
    providerTarget: 'iosAppStore',
    buildType: 'cordova-ios-build',
    installable: true,
  },
  {
    id: 'ios-development',
    label: 'iOS development IPA',
    platform: 'ios',
    artifactKind: 'ipa',
    providerTarget: 'iosDevelopment',
    buildType: 'cordova-ios-build',
    installable: true,
  },
];

const LOCAL_HTML5_TARGET = {
  id: 'html5-local',
  label: 'Local HTML5 folder',
  platform: 'web',
  artifactKind: 'directory',
  installable: false,
};

const throwIfAborted = (signal: ?AbortSignal) => {
  if (signal && signal.aborted) {
    throw new AgentError({
      code: 'request_cancelled',
      message:
        'Build preparation was cancelled before the provider build started.',
      retryable: true,
    });
  }
};

const sanitizeDetectedErrors = value =>
  Array.isArray(value)
    ? value
        .filter(error => error && typeof error.code === 'string')
        .map(error => ({
          code: error.code,
          ...(typeof error.helpUrl === 'string' && error.helpUrl
            ? { helpUrl: error.helpUrl }
            : {}),
        }))
    : [];

const sanitizeBuild = build => ({
  buildId: build.id,
  status: build.status,
  buildType: build.type,
  targets: Array.isArray(build.targets) ? [...build.targets] : [],
  ...(Number.isFinite(build.createdAt) ? { createdAt: build.createdAt } : {}),
  ...(Number.isFinite(build.updatedAt) ? { updatedAt: build.updatedAt } : {}),
  detectedErrors: sanitizeDetectedErrors(build.detectedErrors),
});

const publicRemoteTarget = (target, availability) => ({
  id: target.id,
  label: target.label,
  deliveryKind: 'remote-build',
  platform: target.platform,
  artifactKind: target.artifactKind,
  installable: target.installable,
  provider: {
    buildType: target.buildType,
    target: target.providerTarget,
  },
  requiresAuthentication: true,
  cancellation: {
    supportedAfterProviderStart: false,
    reasonCode: 'provider_cancel_not_supported',
  },
  availability,
});

const resourceNameFor = (platformSpecificAssets, platform, name) =>
  platformSpecificAssets.get(platform, name) || '';

const iconEntriesFor = (platformSpecificAssets, platform, sizes) =>
  sizes.map(size => ({
    size,
    resourceName: resourceNameFor(
      platformSpecificAssets,
      platform,
      `icon-${size}`
    ),
  }));

const requireImageResource = (project, resourceName, field) => {
  if (!resourceName) return;
  const resourcesManager = project.getResourcesManager();
  if (!resourcesManager.hasResource(resourceName)) {
    throw new AgentError({
      code: 'build_configuration_resource_not_found',
      message: `Build configuration resource was not found: ${resourceName}`,
      details: { field, resourceName },
    });
  }
  const resource = resourcesManager.getResource(resourceName);
  if (resource.getKind() !== 'image') {
    throw new AgentError({
      code: 'build_configuration_resource_kind_mismatch',
      message: `${field} must reference an image resource.`,
      details: { field, resourceName, kind: resource.getKind() },
    });
  }
};

const applyIconEntries = ({
  project,
  platformSpecificAssets,
  platform,
  entries,
  allowedSizes,
  field,
}) => {
  if (entries === undefined) return false;
  if (!Array.isArray(entries)) {
    throw new AgentError({
      code: 'invalid_build_configuration',
      message: `${field} must be an array.`,
    });
  }
  let changed = false;
  const seen = new Set();
  entries.forEach((entry, index) => {
    const size = entry && entry.size;
    const resourceName = entry && entry.resourceName;
    if (!allowedSizes.includes(size) || seen.has(size)) {
      throw new AgentError({
        code: 'invalid_build_configuration',
        message: `${field}[${index}].size is unsupported or duplicated.`,
        details: { field, size, allowedSizes },
      });
    }
    seen.add(size);
    if (typeof resourceName !== 'string') {
      throw new AgentError({
        code: 'invalid_build_configuration',
        message: `${field}[${index}].resourceName must be a string.`,
      });
    }
    requireImageResource(project, resourceName, `${field}[${index}]`);
    const key = `icon-${size}`;
    const previous = resourceNameFor(platformSpecificAssets, platform, key);
    if (previous !== resourceName) {
      platformSpecificAssets.set(platform, key, resourceName);
      changed = true;
    }
  });
  return changed;
};

const setIfChanged = (getter, setter, value) => {
  if (value === undefined || getter() === value) return false;
  setter(value);
  return true;
};

const artifactsForBuild = build =>
  REMOTE_TARGETS.map(target => {
    const url = getBuildArtifactUrl(build, target.artifactKey);
    return url
      ? {
          targetId: target.id,
          providerTarget: target.providerTarget,
          platform: target.platform,
          artifactKind: target.artifactKind,
          installable: target.installable,
          url,
        }
      : null;
  }).filter(Boolean);

type Options = {|
  project: ?gdProject,
  i18n: any,
  authenticatedUser: any,
  eventsFunctionsExtensionsState: any,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  isDesktopEnvironment: boolean,
  electronPipeline?: any,
  cordovaPipeline?: any,
  getBuildById?: any,
|};

export const createBuildService = ({
  project,
  i18n,
  authenticatedUser,
  eventsFunctionsExtensionsState,
  triggerUnsavedChanges,
  forceUpdate,
  isDesktopEnvironment,
  electronPipeline = localOnlineElectronExportPipeline,
  cordovaPipeline = localOnlineCordovaExportPipeline,
  getBuildById = getBuild,
}: Options) => {
  let buildPreparationInProgress = false;

  const hasAuthenticatedUser = () =>
    !!(
      authenticatedUser &&
      authenticatedUser.firebaseUser &&
      typeof authenticatedUser.getAuthorizationHeader === 'function'
    );

  const availabilityForRemote = () => {
    if (!project) {
      return {
        state: 'unavailable',
        code: 'project_required',
        retryable: true,
      };
    }
    if (!isDesktopEnvironment) {
      return {
        state: 'unavailable',
        code: 'desktop_environment_required',
        retryable: false,
      };
    }
    if (!hasAuthenticatedUser()) {
      return {
        state: 'unavailable',
        code: 'authentication_required',
        retryable: true,
      };
    }
    return { state: 'available', code: null, retryable: false };
  };

  const listTargets = () => {
    const localAvailability = project
      ? { state: 'available', code: null, retryable: false }
      : { state: 'unavailable', code: 'project_required', retryable: true };
    const remoteAvailability = availabilityForRemote();
    return {
      targets: [
        {
          ...LOCAL_HTML5_TARGET,
          deliveryKind: 'local-export',
          command: 'export.html5',
          requiresAuthentication: false,
          cancellation: {
            supportedAfterStart: false,
            reasonCode: 'local_export_is_single_operation',
          },
          availability: localAvailability,
        },
        ...REMOTE_TARGETS.map(target =>
          publicRemoteTarget(target, remoteAvailability)
        ),
        ...IOS_UNSUPPORTED_TARGETS.map(target =>
          publicRemoteTarget(target, {
            state: 'unsupported',
            code: 'signing_configuration_not_exposed',
            retryable: false,
          })
        ),
      ],
      environment: {
        desktop: !!isDesktopEnvironment,
        projectOpen: !!project,
        authenticated: hasAuthenticatedUser(),
      },
    };
  };

  const requireProject = () => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    return project;
  };

  const inspectConfiguration = () => {
    const currentProject = requireProject();
    const platformSpecificAssets = currentProject.getPlatformSpecificAssets();
    const loadingScreen = currentProject.getLoadingScreen();
    return {
      packageName: currentProject.getPackageName(),
      version: currentProject.getVersion(),
      orientation: currentProject.getOrientation(),
      icons: {
        desktop: iconEntriesFor(
          platformSpecificAssets,
          'desktop',
          DESKTOP_ICON_SIZES
        ),
        android: iconEntriesFor(
          platformSpecificAssets,
          'android',
          ANDROID_ICON_SIZES
        ),
        ios: iconEntriesFor(platformSpecificAssets, 'ios', IOS_ICON_SIZES),
      },
      splash: {
        androidWindowSplashScreenAnimatedIconResourceName: resourceNameFor(
          platformSpecificAssets,
          'android',
          'windowSplashScreenAnimatedIcon'
        ),
      },
      loadingScreen: {
        showGDevelopLogo: loadingScreen.isGDevelopLogoShownDuringLoadingScreen(),
        gdevelopLogoStyle: loadingScreen.getGDevelopLogoStyle(),
        backgroundImageResourceName: loadingScreen.getBackgroundImageResourceName(),
        backgroundColor: loadingScreen.getBackgroundColor(),
        backgroundFadeInDuration: loadingScreen.getBackgroundFadeInDuration(),
        minDuration: loadingScreen.getMinDuration(),
        logoAndProgressFadeInDuration: loadingScreen.getLogoAndProgressFadeInDuration(),
        logoAndProgressLogoFadeInDelay: loadingScreen.getLogoAndProgressLogoFadeInDelay(),
        showProgressBar: loadingScreen.getShowProgressBar(),
        progressBarMaxWidth: loadingScreen.getProgressBarMaxWidth(),
        progressBarMinWidth: loadingScreen.getProgressBarMinWidth(),
        progressBarWidthPercent: loadingScreen.getProgressBarWidthPercent(),
        progressBarHeight: loadingScreen.getProgressBarHeight(),
        progressBarColor: loadingScreen.getProgressBarColor(),
      },
    };
  };

  const applyConfiguration = input => {
    const currentProject = requireProject();
    const platformSpecificAssets = currentProject.getPlatformSpecificAssets();
    let changed = false;

    changed =
      setIfChanged(
        () => currentProject.getPackageName(),
        value => currentProject.setPackageName(value),
        input.packageName
      ) || changed;
    changed =
      setIfChanged(
        () => currentProject.getVersion(),
        value => currentProject.setVersion(value),
        input.version
      ) || changed;
    changed =
      setIfChanged(
        () => currentProject.getOrientation(),
        value => currentProject.setOrientation(value),
        input.orientation
      ) || changed;

    const icons = input.icons || {};
    changed =
      applyIconEntries({
        project: currentProject,
        platformSpecificAssets,
        platform: 'desktop',
        entries: icons.desktop,
        allowedSizes: DESKTOP_ICON_SIZES,
        field: 'icons.desktop',
      }) || changed;
    changed =
      applyIconEntries({
        project: currentProject,
        platformSpecificAssets,
        platform: 'android',
        entries: icons.android,
        allowedSizes: ANDROID_ICON_SIZES,
        field: 'icons.android',
      }) || changed;
    changed =
      applyIconEntries({
        project: currentProject,
        platformSpecificAssets,
        platform: 'ios',
        entries: icons.ios,
        allowedSizes: IOS_ICON_SIZES,
        field: 'icons.ios',
      }) || changed;

    const splash = input.splash || {};
    if (
      splash.androidWindowSplashScreenAnimatedIconResourceName !== undefined
    ) {
      const resourceName =
        splash.androidWindowSplashScreenAnimatedIconResourceName;
      requireImageResource(
        currentProject,
        resourceName,
        'splash.androidWindowSplashScreenAnimatedIconResourceName'
      );
      const previous = resourceNameFor(
        platformSpecificAssets,
        'android',
        'windowSplashScreenAnimatedIcon'
      );
      if (previous !== resourceName) {
        platformSpecificAssets.set(
          'android',
          'windowSplashScreenAnimatedIcon',
          resourceName
        );
        changed = true;
      }
    }

    const loadingInput = input.loadingScreen || {};
    const loadingScreen = currentProject.getLoadingScreen();
    if (loadingInput.backgroundImageResourceName !== undefined) {
      requireImageResource(
        currentProject,
        loadingInput.backgroundImageResourceName,
        'loadingScreen.backgroundImageResourceName'
      );
    }
    const loadingSetters = [
      [
        'showGDevelopLogo',
        () => loadingScreen.isGDevelopLogoShownDuringLoadingScreen(),
        value => loadingScreen.showGDevelopLogoDuringLoadingScreen(value),
      ],
      [
        'gdevelopLogoStyle',
        () => loadingScreen.getGDevelopLogoStyle(),
        value => loadingScreen.setGDevelopLogoStyle(value),
      ],
      [
        'backgroundImageResourceName',
        () => loadingScreen.getBackgroundImageResourceName(),
        value => loadingScreen.setBackgroundImageResourceName(value),
      ],
      [
        'backgroundColor',
        () => loadingScreen.getBackgroundColor(),
        value => loadingScreen.setBackgroundColor(value),
      ],
      [
        'backgroundFadeInDuration',
        () => loadingScreen.getBackgroundFadeInDuration(),
        value => loadingScreen.setBackgroundFadeInDuration(value),
      ],
      [
        'minDuration',
        () => loadingScreen.getMinDuration(),
        value => loadingScreen.setMinDuration(value),
      ],
      [
        'logoAndProgressFadeInDuration',
        () => loadingScreen.getLogoAndProgressFadeInDuration(),
        value => loadingScreen.setLogoAndProgressFadeInDuration(value),
      ],
      [
        'logoAndProgressLogoFadeInDelay',
        () => loadingScreen.getLogoAndProgressLogoFadeInDelay(),
        value => loadingScreen.setLogoAndProgressLogoFadeInDelay(value),
      ],
      [
        'showProgressBar',
        () => loadingScreen.getShowProgressBar(),
        value => loadingScreen.setShowProgressBar(value),
      ],
      [
        'progressBarMaxWidth',
        () => loadingScreen.getProgressBarMaxWidth(),
        value => loadingScreen.setProgressBarMaxWidth(value),
      ],
      [
        'progressBarMinWidth',
        () => loadingScreen.getProgressBarMinWidth(),
        value => loadingScreen.setProgressBarMinWidth(value),
      ],
      [
        'progressBarWidthPercent',
        () => loadingScreen.getProgressBarWidthPercent(),
        value => loadingScreen.setProgressBarWidthPercent(value),
      ],
      [
        'progressBarHeight',
        () => loadingScreen.getProgressBarHeight(),
        value => loadingScreen.setProgressBarHeight(value),
      ],
      [
        'progressBarColor',
        () => loadingScreen.getProgressBarColor(),
        value => loadingScreen.setProgressBarColor(value),
      ],
    ];
    loadingSetters.forEach(([field, getter, setter]) => {
      if (loadingInput[field] !== undefined) {
        changed = setIfChanged(getter, setter, loadingInput[field]) || changed;
      }
    });

    if (changed) {
      triggerUnsavedChanges();
      forceUpdate();
    }
    return { changed, configuration: inspectConfiguration() };
  };

  const findRemoteTarget = targetId =>
    REMOTE_TARGETS.find(target => target.id === targetId) || null;

  const requireAuthenticatedUser = () => {
    if (!hasAuthenticatedUser()) {
      throw new AgentError({
        code: 'build_authentication_required',
        message: 'This build target requires an authenticated GDevelop user.',
        retryable: true,
        recovery: 'Sign in to GDevelop, then retry the build command.',
      });
    }
    return authenticatedUser;
  };

  const start = async (input, signal: ?AbortSignal) => {
    const currentProject = requireProject();
    if (input.targetId === LOCAL_HTML5_TARGET.id) {
      throw new AgentError({
        code: 'build_target_uses_export_command',
        message: 'Local HTML5 output is exposed by export.html5.',
        hint: 'Call export.html5 with an outputDir instead of build.start.',
        details: { targetId: input.targetId, command: 'export.html5' },
      });
    }
    const unsupportedIos = IOS_UNSUPPORTED_TARGETS.find(
      target => target.id === input.targetId
    );
    if (unsupportedIos) {
      throw new AgentError({
        code: 'build_target_unsupported',
        message:
          'iOS signing configuration is not exposed by AgentIntegration yet.',
        details: {
          targetId: unsupportedIos.id,
          reasonCode: 'signing_configuration_not_exposed',
        },
      });
    }
    const target = findRemoteTarget(input.targetId);
    if (!target) {
      throw new AgentError({
        code: 'build_target_not_found',
        message: `Unknown build target: ${String(input.targetId)}`,
      });
    }
    const availability = availabilityForRemote();
    if (availability.state !== 'available') {
      throw new AgentError({
        code: 'build_target_unavailable',
        message: `Build target ${
          target.id
        } is unavailable in the current environment.`,
        retryable: !!availability.retryable,
        details: { targetId: target.id, availability },
      });
    }
    if (buildPreparationInProgress) {
      throw new AgentError({
        code: 'build_preparation_in_progress',
        message:
          'Another build is currently being prepared in this editor window.',
        retryable: true,
      });
    }

    const user = requireAuthenticatedUser();
    const pipeline =
      target.pipeline === 'electron' ? electronPipeline : cordovaPipeline;
    const baseState = pipeline.getInitialExportState(currentProject);
    const exportState = {
      ...baseState,
      targets: [target.providerTarget],
      ...(target.pipeline === 'cordova'
        ? { keystore: input.androidKeystore || 'new' }
        : {}),
    };
    const context = {
      project: currentProject,
      exportState,
      updateStepProgress: () => {},
      i18n,
    };
    const profile = user.profile;
    const fallbackAuthor = profile
      ? { id: profile.id, username: profile.username || '' }
      : undefined;

    buildPreparationInProgress = true;
    let preparedExporter = null;
    let exportWasLaunched = false;
    try {
      throwIfAborted(signal);
      if (
        eventsFunctionsExtensionsState &&
        typeof eventsFunctionsExtensionsState.ensureLoadFinished === 'function'
      ) {
        await eventsFunctionsExtensionsState.ensureLoadFinished();
      }
      throwIfAborted(signal);
      preparedExporter = await pipeline.prepareExporter(context);
      throwIfAborted(signal);
      const exportOutput = await pipeline.launchExport(
        context,
        preparedExporter,
        fallbackAuthor
      );
      exportWasLaunched = true;
      throwIfAborted(signal);
      const resourcesDownloadOutput = await pipeline.launchResourcesDownload(
        context,
        exportOutput
      );
      throwIfAborted(signal);
      const compressionOutput = await pipeline.launchCompression(
        context,
        resourcesDownloadOutput
      );
      throwIfAborted(signal);
      if (!pipeline.launchUpload || !pipeline.launchOnlineBuild) {
        throw new AgentError({
          code: 'build_pipeline_incomplete',
          message: `Build pipeline ${
            pipeline.name
          } does not expose online build stages.`,
        });
      }
      const uploadBucketKey = await pipeline.launchUpload(
        context,
        compressionOutput
      );
      throwIfAborted(signal);
      const build = await pipeline.launchOnlineBuild(
        exportState,
        user,
        uploadBucketKey,
        currentProject.getProjectUuid(),
        {
          gameName: currentProject.getName(),
          gameVersion: currentProject.getVersion(),
        },
        !!input.payWithCredits
      );
      if (user.onRefreshLimits) user.onRefreshLimits();
      return {
        started: true,
        targetId: target.id,
        cancellation: {
          supportedAfterProviderStart: false,
          reasonCode: 'provider_cancel_not_supported',
        },
        build: sanitizeBuild(build),
      };
    } finally {
      if (
        preparedExporter &&
        !exportWasLaunched &&
        preparedExporter.exporter &&
        typeof preparedExporter.exporter.delete === 'function'
      ) {
        preparedExporter.exporter.delete();
      }
      buildPreparationInProgress = false;
    }
  };

  const fetchBuild = async buildId => {
    const user = requireAuthenticatedUser();
    const build = await getBuildById(
      user.getAuthorizationHeader,
      user.firebaseUser.uid,
      buildId
    );
    return build;
  };

  const status = async input => ({
    build: sanitizeBuild(await fetchBuild(input.buildId)),
  });

  const cancel = async input => {
    const build = await fetchBuild(input.buildId);
    return {
      build: sanitizeBuild(build),
      cancelled: false,
      supported: false,
      reasonCode: 'provider_cancel_not_supported',
      message:
        'The current GDevelop Build API does not expose cancellation; deleting a build is not treated as cancellation.',
    };
  };

  const result = async input => {
    const build = await fetchBuild(input.buildId);
    const sanitized = sanitizeBuild(build);
    if (build.status === 'pending') {
      return {
        ready: false,
        succeeded: false,
        build: sanitized,
        artifacts: [],
      };
    }
    if (build.status === 'error') {
      return {
        ready: true,
        succeeded: false,
        build: sanitized,
        artifacts: [],
      };
    }
    return {
      ready: true,
      succeeded: true,
      build: sanitized,
      artifacts: artifactsForBuild(build),
    };
  };

  return {
    listTargets,
    inspectConfiguration,
    applyConfiguration,
    start,
    status,
    cancel,
    result,
  };
};

export const buildServiceInternals = {
  DESKTOP_ICON_SIZES,
  ANDROID_ICON_SIZES,
  IOS_ICON_SIZES,
  REMOTE_TARGETS,
  IOS_UNSUPPORTED_TARGETS,
  sanitizeBuild,
  artifactsForBuild,
};
