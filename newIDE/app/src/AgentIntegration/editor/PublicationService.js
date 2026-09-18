// @flow
import { AgentError } from '../core/AgentError';
import {
  getBuild,
  getBuildArtifactUrl,
} from '../../Utils/GDevelopServices/Build';
import {
  getGame,
  getGameUrl,
  updateGame,
} from '../../Utils/GDevelopServices/Game';

const GD_GAMES_INTEGRATION_ID = 'gd-games';

type Options = {|
  project: ?gdProject,
  authenticatedUser: any,
  getBuildById?: any,
  getGameById?: any,
  updateGameById?: any,
  getGameUrlFor?: any,
  getBuildArtifactUrlFor?: any,
|};

const hasEditorAuthentication = authenticatedUser =>
  !!(
    authenticatedUser &&
    authenticatedUser.firebaseUser &&
    typeof authenticatedUser.firebaseUser.uid === 'string' &&
    authenticatedUser.firebaseUser.uid &&
    authenticatedUser.profile &&
    typeof authenticatedUser.profile.id === 'string' &&
    authenticatedUser.profile.id &&
    typeof authenticatedUser.getAuthorizationHeader === 'function'
  );

const makeAvailability = ({ project, authenticatedUser }) => {
  if (!project) {
    return {
      state: 'unavailable',
      code: 'project_required',
      retryable: true,
    };
  }
  if (!hasEditorAuthentication(authenticatedUser)) {
    return {
      state: 'unavailable',
      code: 'authentication_required',
      retryable: true,
    };
  }
  return { state: 'available', code: null, retryable: false };
};

export const createPublicationService = ({
  project,
  authenticatedUser,
  getBuildById = getBuild,
  getGameById = getGame,
  updateGameById = updateGame,
  getGameUrlFor = getGameUrl,
  getBuildArtifactUrlFor = getBuildArtifactUrl,
}: Options) => {
  const listIntegrations = () => ({
    integrations: [
      {
        id: GD_GAMES_INTEGRATION_ID,
        label: 'gd.games',
        provider: 'GDevelop',
        destinationKind: 'public-game-page',
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
        availability: makeAvailability({ project, authenticatedUser }),
      },
    ],
    environment: {
      projectOpen: !!project,
      authenticated: hasEditorAuthentication(authenticatedUser),
    },
  });

  const requireProject = () => {
    if (!project) throw new AgentError({ code: 'no_project_open' });
    return project;
  };

  const requireAuthenticatedUser = () => {
    const availability = makeAvailability({ project, authenticatedUser });
    if (availability.state !== 'available') {
      throw new AgentError({
        code: 'publication_authentication_required',
        message:
          'Publishing to gd.games requires the authenticated GDevelop editor session.',
        retryable: true,
        recovery: 'Sign in to GDevelop, then retry the publication command.',
      });
    }
    return authenticatedUser;
  };

  const requireIntegration = integrationId => {
    if (integrationId !== GD_GAMES_INTEGRATION_ID) {
      throw new AgentError({
        code: 'publication_integration_unsupported',
        message: 'The requested publication integration is not supported.',
        details: {
          integrationId,
          supportedIntegrationIds: [GD_GAMES_INTEGRATION_ID],
        },
      });
    }
  };

  const resolvePublicationState = async input => {
    requireIntegration(input.integrationId);
    const currentProject = requireProject();
    const user = requireAuthenticatedUser();
    const projectUuid = currentProject.getProjectUuid();
    const gameUserId = user.profile.id;
    const buildUserId = user.firebaseUser.uid;
    const getAuthorizationHeader = user.getAuthorizationHeader;

    const [game, build] = await Promise.all([
      getGameById(getAuthorizationHeader, gameUserId, projectUuid),
      getBuildById(getAuthorizationHeader, buildUserId, input.buildId),
    ]);

    if (!game || game.id !== projectUuid) {
      throw new AgentError({
        code: 'publication_game_identity_mismatch',
        message:
          'The online game identity does not match the currently open project.',
        details: {
          projectUuid,
          gameId: game && typeof game.id === 'string' ? game.id : null,
        },
      });
    }

    if (!build || build.id !== input.buildId) {
      throw new AgentError({
        code: 'publication_build_not_found',
        message: 'The requested build could not be resolved.',
        retryable: true,
        details: { buildId: input.buildId },
      });
    }
    if (!build.gameId) {
      throw new AgentError({
        code: 'publication_build_identity_unverifiable',
        message:
          'The build does not expose a game identity, so it cannot be safely published.',
        details: { buildId: build.id },
      });
    }
    if (build.gameId !== projectUuid) {
      throw new AgentError({
        code: 'publication_build_project_mismatch',
        message: 'The build belongs to a different game project.',
        details: {
          buildId: build.id,
          buildGameId: build.gameId,
          projectUuid,
        },
      });
    }
    if (build.type !== 'web-build') {
      throw new AgentError({
        code: 'publication_build_type_unsupported',
        message:
          'Only completed GDevelop web builds can be published to gd.games.',
        details: { buildId: build.id, buildType: build.type },
      });
    }
    if (build.status !== 'complete') {
      throw new AgentError({
        code: 'publication_build_not_complete',
        message: 'The web build must be complete before it can be published.',
        retryable: build.status === 'pending',
        details: { buildId: build.id, status: build.status },
      });
    }

    const artifactUrl = getBuildArtifactUrlFor(build, 's3Key');
    if (!artifactUrl) {
      throw new AgentError({
        code: 'publication_artifact_unavailable',
        message:
          'The completed web build does not expose a publishable web artifact.',
        details: { buildId: build.id },
      });
    }

    return {
      currentProject,
      user,
      projectUuid,
      gameUserId,
      getAuthorizationHeader,
      game,
      build,
      artifactUrl,
    };
  };

  const toManifest = state => ({
    integrationId: GD_GAMES_INTEGRATION_ID,
    action: 'publish',
    dryRun: true,
    project: {
      projectUuid: state.projectUuid,
      projectName: state.currentProject.getName(),
    },
    game: {
      gameId: state.game.id,
      currentPublicWebBuildId: state.game.publicWebBuildId || null,
      publicUrl: getGameUrlFor(state.game) || null,
    },
    artifact: {
      identity: {
        kind: 'gdevelop-build',
        buildId: state.build.id,
        gameId: state.build.gameId,
        buildType: state.build.type,
      },
      status: state.build.status,
      immutableUrl: state.artifactUrl,
    },
    effect: {
      willChange: state.game.publicWebBuildId !== state.build.id,
      publicWebBuildIdAfter: state.build.id,
    },
    credentialHandling: {
      source: 'editor-session',
      exposedToAgent: false,
      persistedByAgent: false,
    },
  });

  const prepare = async input => {
    const state = await resolvePublicationState(input);
    return { manifest: toManifest(state) };
  };

  const publish = async input => {
    if (input.confirmPublication !== true) {
      throw new AgentError({
        code: 'publication_explicit_intent_required',
        message:
          'Publication requires confirmPublication=true in addition to any protocol-level confirmation.',
        recovery:
          'Review publication.prepare, then retry publication.publish with confirmPublication=true.',
      });
    }

    const state = await resolvePublicationState(input);
    const manifest = toManifest(state);
    if (!manifest.effect.willChange) {
      return {
        published: true,
        changed: false,
        integrationId: GD_GAMES_INTEGRATION_ID,
        artifact: manifest.artifact,
        publication: {
          gameId: state.game.id,
          publicWebBuildId: state.build.id,
          publicUrl: getGameUrlFor(state.game) || null,
        },
      };
    }

    const updatedGame = await updateGameById(
      state.getAuthorizationHeader,
      state.gameUserId,
      state.game.id,
      { publicWebBuildId: state.build.id }
    );

    if (!updatedGame || updatedGame.publicWebBuildId !== state.build.id) {
      throw new AgentError({
        code: 'publication_result_mismatch',
        message:
          'The publication provider response did not confirm the requested build identity.',
        retryable: true,
        details: { buildId: state.build.id, gameId: state.game.id },
      });
    }

    return {
      published: true,
      changed: true,
      integrationId: GD_GAMES_INTEGRATION_ID,
      artifact: manifest.artifact,
      publication: {
        gameId: updatedGame.id,
        publicWebBuildId: updatedGame.publicWebBuildId,
        publicUrl: getGameUrlFor(updatedGame) || null,
      },
    };
  };

  return {
    listIntegrations,
    prepare,
    publish,
  };
};

export { GD_GAMES_INTEGRATION_ID };
