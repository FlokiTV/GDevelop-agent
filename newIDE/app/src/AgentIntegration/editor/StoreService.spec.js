// @flow
import { createStoreService } from './StoreService';

const assetHeader = {
  id: 'platformer-player',
  name: 'Platformer Player',
  shortDescription: 'A pixel art player character',
  previewImageUrls: ['https://example.com/player.png'],
  tags: ['pixel art', 'player'],
  license: 'CC0',
  objectType: 'Sprite',
  animationsCount: 2,
  maxFramesCount: 4,
  width: 32,
  height: 32,
  dominantColors: [],
};

const fullAsset = {
  ...assetHeader,
  version: '1',
  gdevelopVersion: '5',
  description: 'Player asset',
  authors: ['Jane'],
  objectAssets: [
    {
      object: { type: 'Sprite' },
      resources: [],
      requiredExtensions: [{ extensionName: 'PlatformBehavior' }],
    },
  ],
};

const audioResource = {
  name: 'Coin pickup',
  url: 'https://resources.gdevelop-app.com/coin.ogg',
  license: 'CC0',
  type: 'audio',
  tags: ['coin', 'pickup'],
  authors: ['Jane'],
  metadata: { duration: 1, type: 'sound' },
};

const makeService = (overrides: any = {}) => {
  const editorFunctionService = {
    run: jest.fn(async () => ({
      results: [{ status: 'finished', didModifyProject: true }],
      createdSceneNames: [],
      didModifyProject: true,
      saved: false,
      createdProject: null,
    })),
  };
  const assetTools = {
    importStoreResource: jest.fn(request => ({
      imported: true,
      overwritten: false,
      resource: { name: request.resourceName || 'coin.ogg' },
    })),
  };
  const listPublicAssets = jest.fn(async () => ({
    publicAssetShortHeaders: [assetHeader],
    publicFilters: {},
    publicAssetPacks: { starterPacks: [] },
  }));
  const listResources = jest.fn(async () => ({
    resources: [],
    resourcesV2: [audioResource],
    filters: {},
  }));
  const service = createStoreService({
    editorFunctionService,
    assetTools,
    listPublicAssets,
    fetchPublicAsset: jest.fn(async () => fullAsset),
    listResources,
    listAuthors: jest.fn(async () => [
      { name: 'Jane', website: 'https://example.com/jane' },
    ]),
    listLicenses: jest.fn(async () => [
      { name: 'CC0', website: 'https://creativecommons.org/publicdomain/zero/1.0/' },
    ]),
    now: () => 1000,
    ...overrides,
  });
  return { service, editorFunctionService, assetTools, listPublicAssets, listResources };
};

describe('StoreService', () => {
  it('searches and caches the public object catalog without generation-service orchestration', async () => {
    const { service, listPublicAssets } = makeService();

    const first = await service.searchObjects({ query: 'pixel player' });
    const second = await service.searchObjects({ query: 'platformer' });

    expect(first.results[0]).toMatchObject({
      assetId: 'platformer-player',
      objectType: 'Sprite',
      license: 'CC0',
    });
    expect(second.results[0].assetId).toBe('platformer-player');
    expect(listPublicAssets).toHaveBeenCalledTimes(1);
    expect(first.source.provider).toBe('gdevelop-public-asset-store');
  });

  it('inspects full asset provenance, authors, license and extension dependencies', async () => {
    const { service } = makeService();

    const result = await service.inspectObject({ assetId: 'platformer-player' });

    expect(result.asset.authors).toEqual([
      { name: 'Jane', website: 'https://example.com/jane' },
    ]);
    expect(result.asset.licenseDetails).toMatchObject({ name: 'CC0' });
    expect(result.asset.requiredExtensions).toEqual(['PlatformBehavior']);
    expect(result.provenance).toMatchObject({
      origin: 'gdevelop-asset-store',
      assetId: 'platformer-player',
    });
  });

  it('imports an object by delegating to canonical create_object', async () => {
    const { service, editorFunctionService } = makeService();

    const result = await service.importObject({
      assetId: 'platformer-player',
      sceneName: 'Level1',
      objectName: 'Player',
    });

    expect(editorFunctionService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            name: 'create_object',
            arguments: expect.objectContaining({
              asset_id: 'platformer-player',
              object_type: 'Sprite',
              scene_name: 'Level1',
              object_name: 'Player',
            }),
          }),
        ],
      })
    );
    expect(result.provenance.origin).toBe('gdevelop-asset-store');
  });

  it('searches, inspects and imports Resource Store entries through AssetTools', async () => {
    const { service, assetTools, listResources } = makeService();

    const search = await service.searchResources({ query: 'coin', kind: 'audio' });
    expect(search.results[0]).toMatchObject({
      name: 'Coin pickup',
      kind: 'audio',
      license: 'CC0',
    });
    const inspected = await service.inspectResource({
      resourceUrl: audioResource.url,
    });
    expect(inspected.resource.authors[0]).toMatchObject({ name: 'Jane' });
    const imported = await service.importResource({
      resourceUrl: audioResource.url,
      resourceName: 'coin.ogg',
    });
    expect(assetTools.importStoreResource).toHaveBeenCalledWith({
      resource: audioResource,
      resourceName: 'coin.ogg',
      overwrite: false,
    });
    expect(imported.provenance.license).toBe('CC0');
    expect(listResources).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized catalogs and already-cancelled operations explicitly', async () => {
    const oversized = makeService({ maxCatalogBytes: 1 });
    await expect(
      oversized.service.searchObjects({ query: 'player' })
    ).rejects.toMatchObject({ code: 'object_store_payload_too_large' });

    const { service } = makeService();
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.searchResources({ query: 'coin' }, controller.signal)
    ).rejects.toMatchObject({ code: 'operation_cancelled' });
  });
});
