// @flow
import { createPublicationService } from './PublicationService';

const gd: libGDevelop = global.gd;

const makeAuthenticatedUser = () => ({
  firebaseUser: { uid: 'firebase-secret-user' },
  profile: { id: 'profile-secret-id', username: 'Publisher' },
  getAuthorizationHeader: jest.fn(async () => 'Bearer secret-token'),
});

describe('AgentIntegration PublicationService', () => {
  let project: gdProject;
  let authenticatedUser;
  let getBuildById;
  let getGameById;
  let updateGameById;
  let service;

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
    project.resetProjectUuid();
    project.setName('Publication Test');
    authenticatedUser = makeAuthenticatedUser();
    getBuildById = jest.fn();
    getGameById = jest.fn();
    updateGameById = jest.fn();
    service = createPublicationService({
      project,
      authenticatedUser,
      getBuildById,
      getGameById,
      updateGameById,
      getGameUrlFor: game => 'https://gd.games/games/' + game.id,
      getBuildArtifactUrlFor: build =>
        build.s3Key ? 'https://gd.games/instant-builds/' + build.id : null,
    });
  });

  afterEach(() => {
    project.delete();
  });

  const mockPublishableState = ({
    currentPublicWebBuildId = null,
    buildOverrides = {},
  } = {}) => {
    const projectUuid = project.getProjectUuid();
    getGameById.mockResolvedValue({
      id: projectUuid,
      publicWebBuildId: currentPublicWebBuildId,
    });
    getBuildById.mockResolvedValue({
      id: 'web-build-1',
      gameId: projectUuid,
      userId: 'private-user-id',
      bucket: 'private-bucket',
      logsKey: 'private-log-key',
      s3Key: 'private-storage-key',
      status: 'complete',
      type: 'web-build',
      updatedAt: 123,
      ...buildOverrides,
    });
  };

  it('discovers gd.games without exposing or accepting credentials', () => {
    const result = service.listIntegrations();
    expect(result.integrations).toEqual([
      expect.objectContaining({
        id: 'gd-games',
        publicationMode: 'select-existing-web-build',
        requiresAuthentication: true,
        credentialHandling: {
          source: 'editor-session',
          exposedToAgent: false,
          persistedByAgent: false,
          acceptedFromCommandInput: false,
        },
        capabilities: {
          dryRunManifest: true,
          publishExistingBuild: true,
          unpublish: false,
        },
        prerequisites: {
          artifactKind: 'web-build',
          buildTargetId: 'web-online',
        },
        availability: { state: 'available', code: null, retryable: false },
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /secret|firebase-secret-user|profile-secret-id|bearer/i
    );
  });

  it('returns a dry-run manifest with immutable build identity and no secrets', async () => {
    mockPublishableState();
    const result = await service.prepare({
      integrationId: 'gd-games',
      buildId: 'web-build-1',
    });

    expect(result.manifest).toMatchObject({
      integrationId: 'gd-games',
      action: 'publish',
      dryRun: true,
      project: { projectUuid: project.getProjectUuid() },
      artifact: {
        identity: {
          kind: 'gdevelop-build',
          buildId: 'web-build-1',
          gameId: project.getProjectUuid(),
          buildType: 'web-build',
        },
        status: 'complete',
        immutableUrl: 'https://gd.games/instant-builds/web-build-1',
      },
      effect: {
        willChange: true,
        publicWebBuildIdAfter: 'web-build-1',
      },
      credentialHandling: {
        source: 'editor-session',
        exposedToAgent: false,
        persistedByAgent: false,
      },
    });
    expect(getBuildById).toHaveBeenCalledWith(
      authenticatedUser.getAuthorizationHeader,
      'firebase-secret-user',
      'web-build-1'
    );
    expect(getGameById).toHaveBeenCalledWith(
      authenticatedUser.getAuthorizationHeader,
      'profile-secret-id',
      project.getProjectUuid()
    );
    expect(updateGameById).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(
      /private-user-id|private-bucket|private-log-key|private-storage-key|secret-token/
    );
  });

  it('fails closed for cross-project, non-web and incomplete builds', async () => {
    mockPublishableState({ buildOverrides: { gameId: 'other-game' } });
    await expect(
      service.prepare({ integrationId: 'gd-games', buildId: 'web-build-1' })
    ).rejects.toMatchObject({ code: 'publication_build_project_mismatch' });

    mockPublishableState({ buildOverrides: { type: 'electron-build' } });
    await expect(
      service.prepare({ integrationId: 'gd-games', buildId: 'web-build-1' })
    ).rejects.toMatchObject({ code: 'publication_build_type_unsupported' });

    mockPublishableState({ buildOverrides: { status: 'pending' } });
    await expect(
      service.prepare({ integrationId: 'gd-games', buildId: 'web-build-1' })
    ).rejects.toMatchObject({
      code: 'publication_build_not_complete',
      retryable: true,
    });
  });

  it('requires explicit command intent before publishing', async () => {
    await expect(
      service.publish({
        integrationId: 'gd-games',
        buildId: 'web-build-1',
        confirmPublication: false,
      })
    ).rejects.toMatchObject({ code: 'publication_explicit_intent_required' });
    expect(getBuildById).not.toHaveBeenCalled();
    expect(updateGameById).not.toHaveBeenCalled();
  });

  it('publishes through updateGame with editor credentials and returns immutable artifact identity', async () => {
    mockPublishableState();
    updateGameById.mockResolvedValue({
      id: project.getProjectUuid(),
      publicWebBuildId: 'web-build-1',
    });

    const result = await service.publish({
      integrationId: 'gd-games',
      buildId: 'web-build-1',
      confirmPublication: true,
    });

    expect(updateGameById).toHaveBeenCalledWith(
      authenticatedUser.getAuthorizationHeader,
      'profile-secret-id',
      project.getProjectUuid(),
      { publicWebBuildId: 'web-build-1' }
    );
    expect(result).toMatchObject({
      published: true,
      changed: true,
      artifact: {
        identity: {
          kind: 'gdevelop-build',
          buildId: 'web-build-1',
          gameId: project.getProjectUuid(),
          buildType: 'web-build',
        },
      },
      publication: {
        gameId: project.getProjectUuid(),
        publicWebBuildId: 'web-build-1',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret-token|profile-secret-id|private-storage-key/
    );
  });

  it('is idempotent when the requested build is already public', async () => {
    mockPublishableState({ currentPublicWebBuildId: 'web-build-1' });
    const result = await service.publish({
      integrationId: 'gd-games',
      buildId: 'web-build-1',
      confirmPublication: true,
    });

    expect(result).toMatchObject({
      published: true,
      changed: false,
      publication: { publicWebBuildId: 'web-build-1' },
    });
    expect(updateGameById).not.toHaveBeenCalled();
  });

  it('reports authentication availability without leaking session material', () => {
    const loggedOut = createPublicationService({
      project,
      authenticatedUser: { firebaseUser: null, profile: null },
      getBuildById,
      getGameById,
      updateGameById,
    });
    expect(loggedOut.listIntegrations().integrations[0].availability).toEqual({
      state: 'unavailable',
      code: 'authentication_required',
      retryable: true,
    });
  });
});
