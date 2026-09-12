// @flow
import { AgentError } from '../core/AgentError';
import {
  getExtension,
  getExtensionsRegistry,
  type ExtensionShortHeader,
  type ExtensionsRegistry,
  type SerializedExtension,
} from '../../Utils/GDevelopServices/Extension';
import { getIDEVersion } from '../../Version';
import {
  getBreakingChanges,
  isCompatibleWithGDevelopVersion,
} from '../../Utils/Extension/ExtensionCompatibilityChecker';

const gd: libGDevelop = global.gd;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const REGISTRY_TTL_MS = 5 * 60 * 1000;

const normalizeText = (value: any): string =>
  String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const matchesQuery = (header: ExtensionShortHeader, query: any): boolean => {
  const normalized = normalizeText(query);
  if (!normalized) return true;
  const haystack = normalizeText(
    [
      header.name,
      header.fullName,
      header.shortDescription,
      header.category,
      ...(header.tags || []),
    ]
      .filter(Boolean)
      .join(' ')
  );
  return normalized
    .split(' ')
    .filter(Boolean)
    .every(term => haystack.includes(term));
};

const paginate = (items: Array<any>, input: any = {}) => {
  const rawLimit = Number(input.limit);
  const rawOffset = Number(input.offset);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.round(rawLimit)))
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset)
    ? Math.max(0, Math.round(rawOffset))
    : 0;
  const selected = items.slice(offset, offset + limit);
  return {
    items: selected,
    total: items.length,
    offset,
    limit,
    nextOffset:
      offset + selected.length < items.length ? offset + selected.length : null,
  };
};

const requireName = (value: any, field: string = 'name'): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError({
      code: 'invalid_extension_name',
      details: { field },
    });
  }
  return value.trim();
};

const projectExtensionsByName = (project: gdProject) => {
  const result: Map<string, gdEventsFunctionsExtension> = new Map();
  for (
    let index = 0;
    index < project.getEventsFunctionsExtensionsCount();
    index++
  ) {
    const extension = project.getEventsFunctionsExtensionAt(index);
    result.set(extension.getName(), extension);
  }
  return result;
};

const builtInExtensionsByName = (project: gdProject) => {
  const projectNames = new Set(projectExtensionsByName(project).keys());
  const result: Map<string, gdPlatformExtension> = new Map();
  const extensions = gd
    .asPlatform(gd.JsPlatform.get())
    .getAllPlatformExtensions();
  for (let index = 0; index < extensions.size(); index++) {
    const extension = extensions.at(index);
    if (!projectNames.has(extension.getName())) {
      result.set(extension.getName(), extension);
    }
  }
  return result;
};

const classifyProjectExtension = (extension: gdEventsFunctionsExtension) =>
  extension.getOriginName() === 'gdevelop-extension-store'
    ? 'store'
    : 'project';

const serializeProjectExtension = (extension: gdEventsFunctionsExtension) => ({
  name: extension.getName(),
  fullName: extension.getFullName(),
  namespace: extension.getNamespace(),
  version: extension.getVersion(),
  description: extension.getDescription(),
  source: classifyProjectExtension(extension),
  kind: 'events-functions',
  removable: classifyProjectExtension(extension) === 'store',
  origin: {
    name: extension.getOriginName() || null,
    identifier: extension.getOriginIdentifier() || null,
  },
});

const serializeBuiltInExtension = (extension: gdPlatformExtension) => ({
  name: extension.getName(),
  fullName: extension.getFullName(),
  namespace: extension.getNameSpace(),
  version: null,
  description: extension.getDescription(),
  source: 'built-in',
  kind: 'platform',
  removable: false,
  origin: null,
  category: extension.getCategory() || null,
  license: extension.getLicense() || null,
  deprecated: extension.isDeprecated(),
});

const serializeCatalogHeader = (
  header: ExtensionShortHeader,
  project: gdProject
) => {
  const installed = project.hasEventsFunctionsExtensionNamed(header.name)
    ? project.getEventsFunctionsExtension(header.name)
    : null;
  return {
    name: header.name,
    fullName: header.fullName,
    version: header.version,
    gdevelopVersion: header.gdevelopVersion || null,
    tier: header.tier,
    category: header.category,
    tags: header.tags || [],
    shortDescription: header.shortDescription,
    helpPath: header.helpPath || null,
    previewIconUrl: header.previewIconUrl || null,
    extensionNamespace: header.extensionNamespace || null,
    requiredExtensions: header.requiredExtensions || [],
    counts: {
      functions: header.eventsFunctionsCount || 0,
      behaviors: header.eventsBasedBehaviorsCount || 0,
      objects: (header.eventsBasedObjects || []).length,
    },
    installed: !!installed,
    installedVersion: installed ? installed.getVersion() : null,
    installedSource: installed ? classifyProjectExtension(installed) : null,
  };
};

const getDeleteBlockers = (
  project: gdProject,
  extension: gdEventsFunctionsExtension
) => {
  // Follow the ownership pattern used by the editor itself for these libGD
  // [Value] return types: convert them immediately and do not explicitly
  // delete the temporary JS wrappers. Explicit deletion can invalidate
  // embind-owned temporary values and make a later scan crash in WASM.
  const dependentExtensions = gd.UsedExtensionsFinder.findExtensionsDependentOn(
    project,
    extension
  ).toJSArray();
  const usedByProject = gd.UsedExtensionsFinder.scanProject(project)
    .getUsedExtensions()
    .toNewVectorString()
    .toJSArray()
    .includes(extension.getName());

  return {
    usedByProject,
    dependentExtensions: dependentExtensions.sort(),
  };
};

const resolveDependencyClosure = (
  headersByName: Map<string, ExtensionShortHeader>,
  name: string
): Array<ExtensionShortHeader> => {
  const resolved = [];
  const visiting = new Set();
  const visited = new Set();

  const visit = extensionName => {
    if (visited.has(extensionName)) return;
    if (visiting.has(extensionName)) {
      throw new AgentError({
        code: 'extension_dependency_cycle',
        details: { extensionName, path: [...visiting, extensionName] },
      });
    }
    const header = headersByName.get(extensionName);
    if (!header) {
      throw new AgentError({
        code: 'extension_dependency_not_found',
        details: { extensionName },
      });
    }
    visiting.add(extensionName);
    (header.requiredExtensions || []).forEach(dependency =>
      visit(dependency.extensionName)
    );
    visiting.delete(extensionName);
    visited.add(extensionName);
    resolved.push(header);
  };

  visit(name);
  return resolved;
};

type Options = {|
  project: gdProject,
  eventsFunctionsExtensionsState: any,
  triggerUnsavedChanges: () => void,
  forceUpdate: () => void,
  onWillInstallExtension?: (names: Array<string>) => void,
  onExtensionInstalled?: (names: Array<string>) => void,
  registryProvider?: () => Promise<ExtensionsRegistry>,
  serializedExtensionProvider?: (
    header: ExtensionShortHeader
  ) => Promise<SerializedExtension>,
  deleteBlockersProvider?: (
    project: gdProject,
    extension: gdEventsFunctionsExtension
  ) => { usedByProject: boolean, dependentExtensions: Array<string> },
|};

export const createExtensionLifecycleService = ({
  project,
  eventsFunctionsExtensionsState,
  triggerUnsavedChanges,
  forceUpdate,
  onWillInstallExtension = () => {},
  onExtensionInstalled = () => {},
  registryProvider = getExtensionsRegistry,
  serializedExtensionProvider = getExtension,
  deleteBlockersProvider = getDeleteBlockers,
}: Options) => {
  let cachedRegistry = null;
  let registryLoadedAt = 0;

  const requireLifecycle = () => {
    if (
      !eventsFunctionsExtensionsState ||
      typeof eventsFunctionsExtensionsState.loadProjectEventsFunctionsExtensions !==
        'function' ||
      typeof eventsFunctionsExtensionsState.reloadProjectEventsFunctionsExtensions !==
        'function'
    ) {
      throw new AgentError({
        code: 'extension_lifecycle_unavailable',
        recovery: 'Retry from the full GDevelop editor integration.',
      });
    }
    return eventsFunctionsExtensionsState;
  };

  const ensureLifecycleReady = async () => {
    const lifecycle = requireLifecycle();
    if (typeof lifecycle.ensureLoadFinished === 'function') {
      await lifecycle.ensureLoadFinished();
    }
    return lifecycle;
  };

  const loadRegistry = async (
    refresh: boolean = false
  ): Promise<ExtensionsRegistry> => {
    const now = Date.now();
    if (
      !refresh &&
      cachedRegistry &&
      now - registryLoadedAt < REGISTRY_TTL_MS
    ) {
      return cachedRegistry;
    }
    try {
      cachedRegistry = await registryProvider();
      registryLoadedAt = Date.now();
      return cachedRegistry;
    } catch (cause) {
      throw new AgentError({
        code: 'extension_catalog_unavailable',
        message: 'Unable to load the GDevelop extension catalog.',
        recovery: 'Check network access and retry.',
        cause,
      });
    }
  };

  const getHeadersByName = async (refresh: boolean = false) => {
    const registry = await loadRegistry(refresh);
    return new Map(registry.headers.map(header => [header.name, header]));
  };

  const requireCatalogHeader = async (
    name: string,
    refresh: boolean = false
  ) => {
    const headers = await getHeadersByName(refresh);
    const header = headers.get(name);
    if (!header) {
      throw new AgentError({
        code: 'extension_catalog_entry_not_found',
        details: { name },
      });
    }
    return { header, headers };
  };

  const listInstalled = () => {
    const projectItems = [...projectExtensionsByName(project).values()].map(
      serializeProjectExtension
    );
    const builtInItems = [...builtInExtensionsByName(project).values()].map(
      serializeBuiltInExtension
    );
    const items = [...builtInItems, ...projectItems].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    return {
      items,
      total: items.length,
      counts: {
        builtIn: builtInItems.length,
        store: projectItems.filter(item => item.source === 'store').length,
        project: projectItems.filter(item => item.source === 'project').length,
      },
    };
  };

  const inspectInstalled = ({ name }: any) => {
    const extensionName = requireName(name);
    const projectExtension = projectExtensionsByName(project).get(
      extensionName
    );
    if (projectExtension) {
      return {
        extension: serializeProjectExtension(projectExtension),
        blockers: deleteBlockersProvider(project, projectExtension),
      };
    }
    const builtInExtension = builtInExtensionsByName(project).get(
      extensionName
    );
    if (builtInExtension) {
      return {
        extension: serializeBuiltInExtension(builtInExtension),
        blockers: null,
      };
    }
    throw new AgentError({
      code: 'installed_extension_not_found',
      details: { name: extensionName },
    });
  };

  const searchCatalog = async (input: any = {}) => {
    const registry = await loadRegistry(!!input.refresh);
    const items = registry.headers
      .filter(header => matchesQuery(header, input.query))
      .filter(header => !input.tier || header.tier === input.tier)
      .map(header => serializeCatalogHeader(header, project))
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      ...paginate(items, input),
      registryVersion: registry.version || null,
      filters: {
        query: input.query || '',
        tier: input.tier || null,
      },
    };
  };

  const describeCatalog = async (input: any) => {
    const name = requireName(input && input.name);
    const { header } = await requireCatalogHeader(
      name,
      !!(input && input.refresh)
    );
    return { extension: serializeCatalogHeader(header, project) };
  };

  const assertCompatible = (header: ExtensionShortHeader) => {
    if (
      header.gdevelopVersion &&
      !isCompatibleWithGDevelopVersion(getIDEVersion(), header.gdevelopVersion)
    ) {
      throw new AgentError({
        code: 'extension_requires_newer_gdevelop',
        details: {
          name: header.name,
          requiredGDevelopVersion: header.gdevelopVersion,
          currentGDevelopVersion: getIDEVersion(),
        },
      });
    }
  };

  const installOrUpdate = async (input: any, mode: 'install' | 'update') => {
    const name = requireName(input && input.name);
    const allowBreakingChanges = !!(input && input.allowBreakingChanges);
    const lifecycle = await ensureLifecycleReady();
    const { header: targetHeader, headers } = await requireCatalogHeader(
      name,
      !!(input && input.refreshCatalog)
    );
    const closure = resolveDependencyClosure(headers, targetHeader.name);
    const projectExtensions = projectExtensionsByName(project);
    const builtIns = builtInExtensionsByName(project);
    const headersToInstall = [];
    const alreadySatisfied = [];

    closure.forEach(header => {
      assertCompatible(header);
      const existing = projectExtensions.get(header.name);
      if (existing) {
        if (classifyProjectExtension(existing) !== 'store') {
          throw new AgentError({
            code: 'extension_name_conflict',
            hint:
              'A project-authored extension already uses this name. Rename/remove it before installing the store extension.',
            details: { name: header.name, source: 'project' },
          });
        }
        if (mode === 'install' || existing.getVersion() === header.version) {
          alreadySatisfied.push({
            name: header.name,
            version: existing.getVersion(),
          });
          return;
        }
        const breakingChanges = getBreakingChanges(
          existing.getVersion(),
          header
        );
        if (breakingChanges.length > 0 && !allowBreakingChanges) {
          throw new AgentError({
            code: 'extension_update_has_breaking_changes',
            hint:
              'Inspect the catalog changelog and retry with allowBreakingChanges=true only inside a checkpoint/transaction when the breaking changes are accepted.',
            details: {
              name: header.name,
              installedVersion: existing.getVersion(),
              targetVersion: header.version,
              breakingChangeCount: breakingChanges.length,
            },
          });
        }
        headersToInstall.push(header);
        return;
      }
      if (builtIns.has(header.name)) {
        alreadySatisfied.push({
          name: header.name,
          version: null,
          source: 'built-in',
        });
        return;
      }
      headersToInstall.push(header);
    });

    if (headersToInstall.length === 0) {
      return {
        changed: false,
        mode,
        requested: name,
        installed: [],
        alreadySatisfied,
      };
    }

    const serializedExtensions = await Promise.all(
      headersToInstall.map(async header => {
        try {
          const serialized = await serializedExtensionProvider(header);
          if (!serialized || serialized.name !== header.name) {
            throw new Error(
              'Downloaded extension name does not match catalog entry.'
            );
          }
          return serialized;
        } catch (cause) {
          throw new AgentError({
            code: 'extension_download_failed',
            details: { name: header.name, version: header.version },
            cause,
          });
        }
      })
    );

    const changedNames = headersToInstall.map(header => header.name);
    onWillInstallExtension(changedNames);
    const serializedElement = gd.Serializer.fromJSObject(serializedExtensions);
    try {
      project.unserializeAndInsertExtensionsFrom(serializedElement);
    } finally {
      serializedElement.delete();
    }
    changedNames.forEach(extensionName => {
      if (!project.hasEventsFunctionsExtensionNamed(extensionName)) return;
      project
        .getEventsFunctionsExtension(extensionName)
        .setOrigin('gdevelop-extension-store', extensionName);
    });

    try {
      await lifecycle.loadProjectEventsFunctionsExtensions(project);
    } catch (cause) {
      throw new AgentError({
        code: 'extension_reload_failed',
        message:
          'Store extension data was inserted but generated metadata reload failed.',
        recovery: 'Rollback the surrounding checkpoint/transaction and retry.',
        details: { mutationApplied: true, names: changedNames },
        cause,
      });
    }
    triggerUnsavedChanges();
    forceUpdate();
    onExtensionInstalled(changedNames);

    return {
      changed: true,
      mode,
      requested: name,
      installed: headersToInstall.map(header => ({
        name: header.name,
        version: header.version,
      })),
      alreadySatisfied,
    };
  };

  const remove = async (input: any) => {
    const name = requireName(input && input.name);
    const projectExtension = projectExtensionsByName(project).get(name);
    if (!projectExtension) {
      if (builtInExtensionsByName(project).has(name)) {
        throw new AgentError({
          code: 'builtin_extension_not_removable',
          details: { name },
        });
      }
      throw new AgentError({
        code: 'installed_extension_not_found',
        details: { name },
      });
    }
    if (classifyProjectExtension(projectExtension) !== 'store') {
      throw new AgentError({
        code: 'project_extension_requires_authoring_delete',
        hint: 'Use extensions.project.delete for project-authored extensions.',
        details: { name },
      });
    }

    const blockers = deleteBlockersProvider(project, projectExtension);
    if (
      !input.allowReferenced &&
      (blockers.usedByProject || blockers.dependentExtensions.length > 0)
    ) {
      throw new AgentError({
        code: 'extension_in_use',
        hint:
          'Remove project usages/dependent extensions first, or retry with allowReferenced=true only when broken references are intentional and rollback is available.',
        details: { name, ...blockers },
      });
    }

    const lifecycle = await ensureLifecycleReady();
    if (typeof lifecycle.unloadProjectEventsFunctionsExtension === 'function') {
      lifecycle.unloadProjectEventsFunctionsExtension(project, name);
    }
    project.removeEventsFunctionsExtension(name);
    try {
      await lifecycle.reloadProjectEventsFunctionsExtensions(project);
    } catch (cause) {
      throw new AgentError({
        code: 'extension_reload_failed',
        message:
          'Store extension was removed but generated metadata reload failed.',
        recovery: 'Rollback the surrounding checkpoint/transaction and retry.',
        details: { mutationApplied: true, name },
        cause,
      });
    }
    triggerUnsavedChanges();
    forceUpdate();
    return {
      removed: true,
      name,
      allowedReferenced: !!input.allowReferenced,
      blockers,
    };
  };

  return {
    listInstalled,
    inspectInstalled,
    searchCatalog,
    describeCatalog,
    install: input => installOrUpdate(input, 'install'),
    update: input => installOrUpdate(input, 'update'),
    remove,
  };
};

export const extensionLifecycleInternals = {
  classifyProjectExtension,
  getDeleteBlockers,
  resolveDependencyClosure,
  serializeCatalogHeader,
};
