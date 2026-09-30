// @flow
import { AgentHost } from './core/AgentHost';
import { type IdempotencyStore } from './core/IdempotencyStore';
import { createCoreCommandDescriptors } from './core/CoreCommands';
import { createDiagnosticsCommandDescriptors } from './editor/DiagnosticsCommands';
import { createEditorFunctionCommandDescriptors } from './editor/EditorFunctionCommands';
import { createEditorVisualCommandDescriptors } from './editor/EditorVisualCommands';
import { createEventCommandDescriptors } from './editor/EventCommands';
import { createExternalProjectItemsCommandDescriptors } from './editor/ExternalProjectItemsCommands';
import { createExtensionAuthoringCommandDescriptors } from './editor/ExtensionAuthoringCommands';
import { createExtensionLifecycleCommandDescriptors } from './editor/ExtensionLifecycleCommands';
import { createObjectStructureCommandDescriptors } from './editor/ObjectStructureCommands';
import { createObjectPropertyCommandDescriptors } from './editor/ObjectPropertyCommands';
import { createBehaviorLifecycleCommandDescriptors } from './editor/BehaviorLifecycleCommands';
import { createSpriteAnimationCommandDescriptors } from './editor/SpriteAnimationCommands';
import { createObjectGroupCommandDescriptors } from './editor/ObjectGroupCommands';
import { createMetadataDiscoveryCommandDescriptors } from './editor/MetadataDiscoveryCommands';
import { createDocumentationCommandDescriptors } from './editor/DocumentationCommands';
import { createStoreCommandDescriptors } from './editor/StoreCommands';
import { createExportCommandDescriptors } from './editor/ExportCommands';
import { createProjectLifecycleCommandDescriptors } from './editor/ProjectLifecycleCommands';
import { createSceneLifecycleCommandDescriptors } from './editor/SceneLifecycleCommands';
import { createLayerOrderCommandDescriptors } from './editor/LayerOrderCommands';
import { createSceneInstanceCommandDescriptors } from './editor/SceneInstanceCommands';
import { createTargetIdentityCommandDescriptors } from './editor/TargetIdentityCommands';
import { createResourceCommandDescriptors } from './editor/ResourceCommands';
import { createRemoteResourceCommandDescriptors } from './editor/RemoteResourceCommands';
import { createAssetProcessingCommandDescriptors } from './editor/AssetProcessingCommands';
import { createBuildCommandDescriptors } from './editor/BuildCommands';
import { createPublicationCommandDescriptors } from './editor/PublicationCommands';
import { createValidationCommandDescriptors } from './editor/ValidationCommands';
import { createPreviewCommandDescriptors } from './runtime/PreviewCommands';
import { createRuntimeCommandDescriptors } from './runtime/RuntimeCommands';
import { createSafetyCommandDescriptors } from './safety/SafetyCommands';

type Options = {|
  environment: any,
  idempotencyStore?: IdempotencyStore,
  assetTools: any,
  diagnosticsTools: any,
  editorFunctionService: {| run: (options: any) => Promise<any> |},
  editorVisualService: any,
  eventTools: any,
  externalProjectItemsService: any,
  sceneLifecycleService: any,
  layerOrderService: any,
  sceneInstanceService?: any,
  extensionAuthoringService: any,
  extensionLifecycleService: any,
  objectStructureService: any,
  objectPropertyService: any,
  behaviorLifecycleService: any,
  spriteAnimationService: any,
  objectGroupService: any,
  metadataDiscoveryService: any,
  documentationService: any,
  storeService: any,
  remoteResourceService: any,
  assetProcessingService: any,
  buildService: any,
  publicationService: any,
  exportService: any,
  previewService: any,
  projectLifecycleService: any,
  targetIdentityService: any,
  runtimeTelemetry: any,
  runtimeDiagnosticsService: any,
  safetyService: any,
  validationService: any,
|};

export const createRendererAgentHost = ({
  environment,
  idempotencyStore,
  assetTools,
  diagnosticsTools,
  editorFunctionService,
  editorVisualService,
  eventTools,
  externalProjectItemsService,
  sceneLifecycleService,
  layerOrderService,
  sceneInstanceService,
  extensionAuthoringService,
  extensionLifecycleService,
  objectStructureService,
  objectPropertyService,
  behaviorLifecycleService,
  spriteAnimationService,
  objectGroupService,
  metadataDiscoveryService,
  documentationService,
  storeService,
  remoteResourceService,
  assetProcessingService,
  buildService,
  publicationService,
  exportService,
  previewService,
  projectLifecycleService,
  targetIdentityService,
  runtimeTelemetry,
  runtimeDiagnosticsService,
  safetyService,
  validationService,
}: Options): AgentHost =>
  new AgentHost({
    environment,
    idempotencyStore,
    descriptors: [
      ...createCoreCommandDescriptors(),
      ...createTargetIdentityCommandDescriptors({ targetIdentityService }),
      ...createProjectLifecycleCommandDescriptors({ projectLifecycleService }),
      ...createSafetyCommandDescriptors({ safetyService }),
      ...createEventCommandDescriptors({
        eventTools,
        metadataDiscoveryService,
      }),
      ...createSceneLifecycleCommandDescriptors({ sceneLifecycleService }),
      ...createLayerOrderCommandDescriptors({ layerOrderService }),
      ...createSceneInstanceCommandDescriptors({ sceneInstanceService }),
      ...createExternalProjectItemsCommandDescriptors({
        externalProjectItemsService,
      }),
      ...createExtensionAuthoringCommandDescriptors({
        extensionAuthoringService,
      }),
      ...createExtensionLifecycleCommandDescriptors({
        extensionLifecycleService,
      }),
      ...createObjectStructureCommandDescriptors({ objectStructureService }),
      ...createObjectPropertyCommandDescriptors({ objectPropertyService }),
      ...createBehaviorLifecycleCommandDescriptors({
        behaviorLifecycleService,
      }),
      ...createSpriteAnimationCommandDescriptors({
        spriteAnimationService,
      }),
      ...createObjectGroupCommandDescriptors({
        objectGroupService,
      }),
      ...createMetadataDiscoveryCommandDescriptors({
        metadataDiscoveryService,
      }),
      ...createDocumentationCommandDescriptors({ documentationService }),
      ...createStoreCommandDescriptors({ storeService }),
      ...createResourceCommandDescriptors({ assetTools }),
      ...createRemoteResourceCommandDescriptors({ remoteResourceService }),
      ...createAssetProcessingCommandDescriptors({ assetProcessingService }),
      ...createBuildCommandDescriptors({ buildService }),
      ...createPublicationCommandDescriptors({ publicationService }),
      ...createDiagnosticsCommandDescriptors({ diagnosticsTools }),
      ...createEditorVisualCommandDescriptors({ editorVisualService }),
      ...createValidationCommandDescriptors({ validationService }),
      ...createExportCommandDescriptors({ exportService }),
      ...createPreviewCommandDescriptors({ previewService }),
      ...createRuntimeCommandDescriptors({
        runtimeTelemetry,
        runtimeDiagnosticsService,
      }),
      ...createEditorFunctionCommandDescriptors({ editorFunctionService }),
    ],
  });
