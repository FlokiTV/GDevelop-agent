// @flow
import {
  getPublicAsset,
  listAllAuthors,
  listAllLicenses,
  listAllPublicAssets,
  listAllResources,
} from '../../Utils/GDevelopServices/Asset';
import { getIDEVersionWithHash } from '../../Version';
import { AgentError } from '../core/AgentError';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 45000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CATALOG_BYTES = 48 * 1024 * 1024;

const clampInteger = (value: any, fallback: number, min: number, max: number) => {
  const number = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, number));
};

const normalize = (value: any): string =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9:_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const estimateJsonBytes = (value: any): number => {
  try {
    return JSON.stringify(value).length * 2;
  } catch (error) {
    return Number.MAX_SAFE_INTEGER;
  }
};

const scoreSearch = (query: string, fields: Array<any>): number => {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 1;
  const haystack = normalize(fields.filter(Boolean).join(' '));
  if (!haystack) return 0;
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  let score = haystack === normalizedQuery ? 200 : 0;
  if (haystack.startsWith(normalizedQuery)) score += 80;
  if (haystack.includes(normalizedQuery)) score += 50;
  for (const token of tokens) {
    if (!haystack.includes(token)) return 0;
    score += 10;
  }
  return score;
};

const throwIfCancelled = (signal: any) => {
  if (signal && signal.aborted) {
    throw new AgentError({
      code: 'operation_cancelled',
      message: 'The store operation was cancelled.',
    });
  }
};

const withRequestControl = async ({
  promise,
  signal,
  timeoutMs,
  timeoutCode,
  unavailableCode,
}: any) => {
  throwIfCancelled(signal);
  let timeoutId = null;
  let abortListener = null;
  const controlPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new AgentError({
            code: timeoutCode,
            message: `Store request timed out after ${timeoutMs}ms.`,
            retryable: true,
            details: { timeoutMs },
          })
        ),
      timeoutMs
    );
    if (signal && signal.addEventListener) {
      abortListener = () =>
        reject(
          new AgentError({
            code: 'operation_cancelled',
            message: 'The store operation was cancelled.',
          })
        );
      signal.addEventListener('abort', abortListener, { once: true });
    }
  });

  try {
    const result = await Promise.race([promise, controlPromise]);
    throwIfCancelled(signal);
    return result;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError({
      code: unavailableCode,
      message:
        'The GDevelop asset/resource store is unavailable. Check the network connection and try again.',
      retryable: true,
      cause: error,
    });
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (signal && abortListener && signal.removeEventListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
};

const makeCache = () => ({ value: null, loadedAt: 0 });

const makeAssetSummary = (asset: any) => ({
  assetId: asset.id,
  name: asset.name,
  description: asset.shortDescription || asset.description || '',
  objectType: asset.objectType,
  tags: Array.isArray(asset.tags) ? asset.tags : [],
  license: asset.license || null,
  previewImageUrls: Array.isArray(asset.previewImageUrls)
    ? asset.previewImageUrls.slice(0, 6)
    : [],
  animationsCount: Number.isFinite(asset.animationsCount)
    ? asset.animationsCount
    : null,
  maxFramesCount: Number.isFinite(asset.maxFramesCount)
    ? asset.maxFramesCount
    : null,
  width: Number.isFinite(asset.width) ? asset.width : null,
  height: Number.isFinite(asset.height) ? asset.height : null,
});

const makeResourceSummary = (resource: any) => ({
  name: resource.name,
  url: resource.url,
  kind: resource.type,
  tags: Array.isArray(resource.tags) ? resource.tags : [],
  license: resource.license || null,
  authors: Array.isArray(resource.authors) ? resource.authors : [],
  metadata: resource.metadata || null,
  previewImageUrl: resource.previewImageUrl || null,
});

export const createStoreService = ({
  environment = 'live',
  assetTools,
  editorFunctionService,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxCatalogBytes = DEFAULT_MAX_CATALOG_BYTES,
  listPublicAssets = listAllPublicAssets,
  fetchPublicAsset = getPublicAsset,
  listResources = listAllResources,
  listAuthors = listAllAuthors,
  listLicenses = listAllLicenses,
}: any) => {
  const assetCatalogCache = makeCache();
  const resourceCatalogCache = makeCache();
  const attributionCache = makeCache();

  const makeSource = (provider: string) => ({
    provider,
    environment,
    ideVersionWithHash: getIDEVersionWithHash(),
    retrievedAt: new Date(now()).toISOString(),
  });

  const getTimeout = (request: any) =>
    clampInteger(
      request && request.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1000,
      MAX_TIMEOUT_MS
    );

  const ensureBounded = (value: any, code: string) => {
    const estimatedBytes = estimateJsonBytes(value);
    if (estimatedBytes > maxCatalogBytes) {
      throw new AgentError({
        code,
        message: `Store payload exceeds the ${maxCatalogBytes}-byte safety limit.`,
        details: { estimatedBytes, maxCatalogBytes },
      });
    }
    return value;
  };

  const loadAssets = async (request: any, signal: any) => {
    if (
      assetCatalogCache.value &&
      now() - assetCatalogCache.loadedAt <= cacheTtlMs
    ) {
      return assetCatalogCache.value;
    }
    const payload = await withRequestControl({
      promise: listPublicAssets({ environment }),
      signal,
      timeoutMs: getTimeout(request),
      timeoutCode: 'object_store_timeout',
      unavailableCode: 'object_store_unavailable',
    });
    ensureBounded(payload, 'object_store_payload_too_large');
    const assets = Array.isArray(payload.publicAssetShortHeaders)
      ? payload.publicAssetShortHeaders
      : [];
    assetCatalogCache.value = assets;
    assetCatalogCache.loadedAt = now();
    return assets;
  };

  const loadResources = async (request: any, signal: any) => {
    if (
      resourceCatalogCache.value &&
      now() - resourceCatalogCache.loadedAt <= cacheTtlMs
    ) {
      return resourceCatalogCache.value;
    }
    const payload = await withRequestControl({
      promise: listResources({ environment }),
      signal,
      timeoutMs: getTimeout(request),
      timeoutCode: 'resource_store_timeout',
      unavailableCode: 'resource_store_unavailable',
    });
    ensureBounded(payload, 'resource_store_payload_too_large');
    const byUrl = new Map();
    (Array.isArray(payload.resourcesV2) ? payload.resourcesV2 : []).forEach(
      resource => byUrl.set(resource.url, resource)
    );
    (Array.isArray(payload.resources) ? payload.resources : []).forEach(
      resource => {
        if (!byUrl.has(resource.url)) byUrl.set(resource.url, resource);
      }
    );
    const resources = [...byUrl.values()];
    resourceCatalogCache.value = resources;
    resourceCatalogCache.loadedAt = now();
    return resources;
  };

  const loadAttribution = async (request: any, signal: any) => {
    if (
      attributionCache.value &&
      now() - attributionCache.loadedAt <= cacheTtlMs
    ) {
      return attributionCache.value;
    }
    const timeoutMs = getTimeout(request);
    const [authors, licenses] = await Promise.all([
      withRequestControl({
        promise: listAuthors({ environment }),
        signal,
        timeoutMs,
        timeoutCode: 'store_attribution_timeout',
        unavailableCode: 'store_attribution_unavailable',
      }),
      withRequestControl({
        promise: listLicenses({ environment }),
        signal,
        timeoutMs,
        timeoutCode: 'store_attribution_timeout',
        unavailableCode: 'store_attribution_unavailable',
      }),
    ]);
    ensureBounded({ authors, licenses }, 'store_attribution_payload_too_large');
    const value = {
      authors: Array.isArray(authors) ? authors : [],
      licenses: Array.isArray(licenses) ? licenses : [],
    };
    attributionCache.value = value;
    attributionCache.loadedAt = now();
    return value;
  };

  const searchObjects = async (request: any, signal?: any) => {
    const query =
      request && typeof request.query === 'string' ? request.query.trim() : '';
    if (!query) throw new AgentError({ code: 'missing_object_store_query' });
    const objectType =
      request && typeof request.objectType === 'string'
        ? request.objectType.trim()
        : '';
    const limit = clampInteger(request.limit, 10, 1, 50);
    const assets = await loadAssets(request, signal);
    const ranked = assets
      .filter(asset => !objectType || asset.objectType === objectType)
      .map(asset => ({
        asset,
        score:
          scoreSearch(query, [
            asset.id,
            asset.name,
            asset.shortDescription,
            asset.objectType,
            ...(Array.isArray(asset.tags) ? asset.tags : []),
          ]) + (normalize(asset.id) === normalize(query) ? 500 : 0),
      }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name));
    return {
      query,
      objectType: objectType || null,
      total: ranked.length,
      results: ranked.slice(0, limit).map(entry => makeAssetSummary(entry.asset)),
      source: makeSource('gdevelop-public-asset-store'),
      cache: { policy: 'process-memory', ttlMs: cacheTtlMs },
    };
  };

  const inspectObject = async (request: any, signal?: any) => {
    const assetId =
      request && typeof request.assetId === 'string' ? request.assetId.trim() : '';
    if (!assetId) throw new AgentError({ code: 'missing_asset_id' });
    const assets = await loadAssets(request, signal);
    const header = assets.find(asset => asset.id === assetId);
    if (!header) {
      throw new AgentError({
        code: 'asset_not_found',
        details: { assetId },
      });
    }
    const [asset, attribution] = await Promise.all([
      withRequestControl({
        promise: fetchPublicAsset(header, { environment }),
        signal,
        timeoutMs: getTimeout(request),
        timeoutCode: 'object_store_timeout',
        unavailableCode: 'object_store_unavailable',
      }),
      loadAttribution(request, signal),
    ]);
    ensureBounded(asset, 'object_store_payload_too_large');
    const authorDetails = (Array.isArray(asset.authors) ? asset.authors : []).map(
      authorName =>
        attribution.authors.find(author => author.name === authorName) || {
          name: authorName,
          website: null,
        }
    );
    const licenseDetails =
      attribution.licenses.find(license => license.name === asset.license) ||
      (asset.license ? { name: asset.license, website: null } : null);
    return {
      asset: {
        ...makeAssetSummary(asset),
        version: asset.version || null,
        gdevelopVersion: asset.gdevelopVersion || null,
        authors: authorDetails,
        licenseDetails,
        objectAssetsCount: Array.isArray(asset.objectAssets)
          ? asset.objectAssets.length
          : 0,
        requiredExtensions: Array.from(
          new Set(
            (Array.isArray(asset.objectAssets) ? asset.objectAssets : [])
              .flatMap(objectAsset => objectAsset.requiredExtensions || [])
              .map(extension => extension.extensionName || extension.name)
              .filter(Boolean)
          )
        ),
      },
      provenance: {
        origin: 'gdevelop-asset-store',
        assetId,
        authors: authorDetails,
        license: licenseDetails,
      },
      source: makeSource('gdevelop-public-asset-store'),
    };
  };

  const importObject = async (request: any, signal?: any) => {
    if (!editorFunctionService) throw new AgentError({ code: 'no_project_open' });
    const assetId =
      request && typeof request.assetId === 'string' ? request.assetId.trim() : '';
    const objectName =
      request && typeof request.objectName === 'string'
        ? request.objectName.trim()
        : '';
    const sceneName =
      request && typeof request.sceneName === 'string'
        ? request.sceneName.trim()
        : '';
    if (!assetId) throw new AgentError({ code: 'missing_asset_id' });
    if (!objectName) throw new AgentError({ code: 'missing_object_name' });
    if (!sceneName) throw new AgentError({ code: 'missing_scene_name' });
    const assets = await loadAssets(request, signal);
    const header = assets.find(asset => asset.id === assetId);
    if (!header) throw new AgentError({ code: 'asset_not_found', details: { assetId } });
    throwIfCancelled(signal);
    const result = await editorFunctionService.run({
      calls: [
        {
          name: 'create_object',
          arguments: {
            scene_name: sceneName,
            object_name: objectName,
            asset_id: assetId,
            object_type: header.objectType,
            target_object_scope: request.targetScope === 'global' ? 'global' : 'scene',
            replace_existing_object: request.replaceExistingObject === true,
          },
        },
      ],
      signal,
    });
    return {
      ...result,
      importedAsset: makeAssetSummary(header),
      provenance: {
        origin: 'gdevelop-asset-store',
        assetId,
        license: header.license || null,
      },
    };
  };

  const searchResources = async (request: any, signal?: any) => {
    const query =
      request && typeof request.query === 'string' ? request.query.trim() : '';
    if (!query) throw new AgentError({ code: 'missing_resource_store_query' });
    const kind =
      request && typeof request.kind === 'string' ? request.kind.trim() : '';
    const limit = clampInteger(request.limit, 10, 1, 50);
    const resources = await loadResources(request, signal);
    const ranked = resources
      .filter(resource => !kind || resource.type === kind)
      .map(resource => ({
        resource,
        score: scoreSearch(query, [
          resource.name,
          resource.url,
          resource.license,
          ...(Array.isArray(resource.tags) ? resource.tags : []),
          ...(Array.isArray(resource.authors) ? resource.authors : []),
        ]),
      }))
      .filter(entry => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || a.resource.name.localeCompare(b.resource.name)
      );
    return {
      query,
      kind: kind || null,
      total: ranked.length,
      results: ranked
        .slice(0, limit)
        .map(entry => makeResourceSummary(entry.resource)),
      source: makeSource('gdevelop-public-resource-store'),
      cache: { policy: 'process-memory', ttlMs: cacheTtlMs },
    };
  };

  const inspectResource = async (request: any, signal?: any) => {
    const resourceUrl =
      request && typeof request.resourceUrl === 'string'
        ? request.resourceUrl.trim()
        : '';
    if (!resourceUrl) throw new AgentError({ code: 'missing_resource_store_url' });
    const resources = await loadResources(request, signal);
    const resource = resources.find(item => item.url === resourceUrl);
    if (!resource) {
      throw new AgentError({
        code: 'store_resource_not_found',
        details: { resourceUrl },
      });
    }
    const attribution = await loadAttribution(request, signal);
    const authorDetails = (Array.isArray(resource.authors)
      ? resource.authors
      : []
    ).map(
      authorName =>
        attribution.authors.find(author => author.name === authorName) || {
          name: authorName,
          website: null,
        }
    );
    const licenseDetails =
      attribution.licenses.find(license => license.name === resource.license) ||
      (resource.license
        ? { name: resource.license, website: null }
        : null);
    return {
      resource: {
        ...makeResourceSummary(resource),
        authors: authorDetails,
        licenseDetails,
      },
      provenance: {
        origin: 'gdevelop-asset-store',
        identifier: resource.url,
        authors: authorDetails,
        license: licenseDetails,
      },
      source: makeSource('gdevelop-public-resource-store'),
    };
  };

  const importResource = async (request: any, signal?: any) => {
    if (!assetTools) throw new AgentError({ code: 'no_project_open' });
    const resourceUrl =
      request && typeof request.resourceUrl === 'string'
        ? request.resourceUrl.trim()
        : '';
    if (!resourceUrl) throw new AgentError({ code: 'missing_resource_store_url' });
    const resources = await loadResources(request, signal);
    const resource = resources.find(item => item.url === resourceUrl);
    if (!resource) {
      throw new AgentError({
        code: 'store_resource_not_found',
        details: { resourceUrl },
      });
    }
    throwIfCancelled(signal);
    const imported = assetTools.importStoreResource({
      resource,
      resourceName:
        request && typeof request.resourceName === 'string'
          ? request.resourceName
          : undefined,
      overwrite: request && request.overwrite === true,
    });
    throwIfCancelled(signal);
    return {
      ...imported,
      provenance: {
        origin: 'gdevelop-asset-store',
        identifier: resource.url,
        license: resource.license || null,
        authors: Array.isArray(resource.authors) ? resource.authors : [],
      },
    };
  };

  return {
    searchObjects,
    inspectObject,
    importObject,
    searchResources,
    inspectResource,
    importResource,
  };
};
