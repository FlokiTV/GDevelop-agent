const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { fileURLToPath } = require('url');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.close',
  'project.persistence.status',
  'editor.types.objects.list',
  'editor.functions.create-scene',
  'editor.functions.create-object',
  'objects.properties.describe',
  'objects.properties.set',
  'scene.instances.create',
  'scene.open',
  'resources.visual.import',
  'resources.visual.inspect',
  'resources.visual.replace',
  'resources.visual.relocate',
  'resources.visual.delete',
  'resources.packaging.inspect',
  'safety.transactions.begin',
  'safety.transactions.rollback',
  'validation.run',
  'preview.status',
  'preview.start',
  'preview.close-all',
  'desktop.windows.list',
];

const FONT_BASE64 =
  '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';

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const getData = result =>
  result && result.data
    ? result.data
    : result && result.structuredContent && result.structuredContent.data
    ? result.structuredContent.data
    : result && result.structuredContent
    ? result.structuredContent
    : null;

const getRevision = result => {
  const data = getData(result);
  const revision =
    result && result.meta && Number.isInteger(result.meta.projectRevision)
      ? result.meta.projectRevision
      : result &&
        result.structuredContent &&
        result.structuredContent.meta &&
        Number.isInteger(result.structuredContent.meta.projectRevision)
      ? result.structuredContent.meta.projectRevision
      : data && Number.isInteger(data.projectRevision)
      ? data.projectRevision
      : data && Number.isInteger(data.currentProjectRevision)
      ? data.currentProjectRevision
      : null;
  assert(Number.isInteger(revision), 'dx28_missing_project_revision');
  return revision;
};

const extractError = result =>
  result && result.structuredContent && result.structuredContent.error
    ? result.structuredContent.error
    : result && result.data && result.data.error
    ? result.data.error
    : null;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

const crc32 = buffer => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const typeBytes = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    8 + data.length
  );
  return output;
};

const makePng = (width, height, rgba) => {
  const signature = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const offset = row + 1 + x * 4;
      raw[offset] = rgba[0];
      raw[offset + 1] = rgba[1];
      raw[offset + 2] = rgba[2];
      raw[offset + 3] = rgba[3];
    }
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const chooseResourceProperty = (described, hint) => {
  const properties =
    described && Array.isArray(described.properties)
      ? described.properties
      : described && described.data && Array.isArray(described.data.properties)
      ? described.data.properties
      : [];
  const candidates = properties.filter(
    property =>
      property &&
      property.writable === true &&
      property.valueType === 'string' &&
      String(property.descriptorType || '').toLowerCase() === 'resource'
  );
  const normalizedHint = String(hint || '').toLowerCase();
  const byExtraInfo = candidates.find(property => {
    const extraInfo =
      property.constraints && Array.isArray(property.constraints.extraInfo)
        ? property.constraints.extraInfo
        : [];
    return extraInfo.some(value =>
      String(value)
        .toLowerCase()
        .includes(normalizedHint)
    );
  });
  if (byExtraInfo) return byExtraInfo;
  const semanticPattern =
    normalizedHint === 'font' ? /font/i : /(image|texture|sprite)/i;
  return (
    candidates.find(property =>
      semanticPattern.test(`${property.name || ''} ${property.path || ''}`)
    ) || null
  );
};

const usageSignature = inspected => {
  const usages =
    inspected &&
    inspected.usages &&
    Array.isArray(inspected.usages.objectUsages)
      ? inspected.usages.objectUsages
      : [];
  return usages
    .flatMap(usage =>
      (Array.isArray(usage.paths) ? usage.paths : []).map(pathEntry =>
        [
          usage.scope || '',
          usage.sceneName || '',
          usage.objectName || '',
          usage.objectType || '',
          pathEntry.property || '',
          pathEntry.path || '',
          pathEntry.structuralConstraint || '',
        ].join('|')
      )
    )
    .sort();
};

const assertVisualToolSchemas = tools => {
  const find = name => {
    const tool = tools.find(candidate => candidate.name === name);
    assert(tool, `dx28_missing_tool:${name}`);
    return tool;
  };
  REQUIRED_TOOLS.forEach(find);
  const imported = find('resources.visual.import');
  const replaced = find('resources.visual.replace');
  const relocated = find('resources.visual.relocate');
  const deleted = find('resources.visual.delete');
  assert(
    imported.inputSchema &&
      imported.inputSchema.properties &&
      imported.inputSchema.properties.contentBase64 &&
      imported.inputSchema.properties.kind &&
      Array.isArray(imported.inputSchema.properties.kind.enum),
    'dx28_import_schema_missing'
  );
  assert(
    replaced.inputSchema &&
      replaced.inputSchema.properties &&
      replaced.inputSchema.properties.contentBase64,
    'dx28_replace_schema_missing'
  );
  assert(
    relocated.inputSchema &&
      relocated.inputSchema.properties &&
      relocated.inputSchema.properties.dryRun &&
      relocated.inputSchema.properties.dryRun.default === true,
    'dx28_relocate_dry_run_default_missing'
  );
  assert(
    deleted.inputSchema &&
      deleted.inputSchema.properties &&
      deleted.inputSchema.properties.dryRun &&
      deleted.inputSchema.properties.dryRun.default === true,
    'dx28_delete_dry_run_default_missing'
  );
};

const installRepositoryReadGuard = () => {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const originalReadFile = fs.readFile.bind(fs);
  const assertAllowed = filePath => {
    if (typeof filePath !== 'string') return;
    const resolved = path.resolve(filePath);
    const relative = path.relative(repositoryRoot, resolved);
    const insideRepository =
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (insideRepository) {
      throw new Error(
        'dx28_clean_room_repository_read_forbidden:' + path.basename(resolved)
      );
    }
  };
  fs.readFileSync = (filePath, ...args) => {
    assertAllowed(filePath);
    return originalReadFileSync(filePath, ...args);
  };
  fs.readFile = (filePath, ...args) => {
    assertAllowed(filePath);
    return originalReadFile(filePath, ...args);
  };
  return () => {
    fs.readFileSync = originalReadFileSync;
    fs.readFile = originalReadFile;
  };
};

const readRuntimeBytes = async (previewUrl, exportedFilename) => {
  const resourceUrl = new URL(exportedFilename, previewUrl);
  if (resourceUrl.protocol === 'file:') {
    return fs.readFileSync(fileURLToPath(resourceUrl));
  }
  const response = await fetch(resourceUrl);
  assert(response.ok, 'dx28_preview_resource_fetch_failed');
  return Buffer.from(await response.arrayBuffer());
};

const findPreviewWindow = windows =>
  Array.isArray(windows)
    ? windows.find(window => window && window.previewWindow === true)
    : null;

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx28-visual-resources-${process.pid}.json`
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx28-visual-resource-')
  );
  const projectDir = path.join(rootDir, 'project');
  const projectFile = path.join(projectDir, 'game.json');
  fs.mkdirSync(projectDir, { recursive: true });

  const restoreRepositoryReads = installRepositoryReadGuard();
  let session = null;
  let transactionId = null;
  let projectOpen = false;
  let previewOpen = false;
  const replay = [];

  const record = (name, args, result) => {
    replay.push(
      sanitizeForReplay({
        name,
        args,
        result: result.structuredContent || result.data || result.content,
      })
    );
  };

  const connect = async suffix =>
    connectLiveGDevelopMcp({
      clientId: `gdevelop-dx28-visual-resources-${label}-${suffix}`,
      confirmDestructiveOperations: true,
    });

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError && !allowError) {
      const error = extractError(result);
      throw new Error(
        `dx28_tool_failed:${name}:${
          error && error.code ? error.code : 'unknown'
        }`
      );
    }
    return result;
  };

  const mutate = async (name, args = {}) => {
    const revision = getRevision(await call('project.status'));
    const result = await call(name, {
      ...args,
      expectedRevision: revision,
      idempotencyKey: `dx28-${name}-${revision}-${replay.length}`,
    });
    if (transactionId) {
      const meta =
        result.meta ||
        (result.structuredContent && result.structuredContent.meta) ||
        null;
      assert(
        meta && meta.transactionId === transactionId,
        `dx28_transaction_metadata_missing:${name}`
      );
    }
    return result;
  };

  const isOwnedStaleDx28Project = status => {
    if (
      !status ||
      status.projectOpen !== true ||
      status.projectName !== 'DX28 Visual Resource Acceptance' ||
      status.hasUnsavedChanges !== false ||
      typeof status.fileIdentifier !== 'string'
    ) {
      return false;
    }
    const normalizedFile = path.resolve(status.fileIdentifier);
    const tempRoot = path.resolve(os.tmpdir());
    const relative = path.relative(tempRoot, normalizedFile);
    if (
      relative === '' ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      return false;
    }
    return /(?:^|[\\/])gdevelop-dx28-visual-resource-[^\\/]+[\\/]project[\\/]game\.json$/i.test(
      normalizedFile
    );
  };

  const ensureFreshEditor = async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const status = getData(await call('project.status'));
      if (!status || status.projectOpen !== true) return status;
      if (!isOwnedStaleDx28Project(status)) {
        throw new Error(
          `dx28_requires_fresh_editor_without_open_project:${JSON.stringify({
            rootDir,
            fileIdentifier: status.fileIdentifier,
            projectName: status.projectName,
            hasUnsavedChanges: status.hasUnsavedChanges,
          })}`
        );
      }
      await call('project.close', { discardUnsavedChanges: false });
      await wait(250);
    }
    const status = getData(await call('project.status'));
    throw new Error(
      `dx28_stale_project_cleanup_exhausted:${JSON.stringify({
        rootDir,
        fileIdentifier: status && status.fileIdentifier,
        projectName: status && status.projectName,
        hasUnsavedChanges: status && status.hasUnsavedChanges,
      })}`
    );
  };

  const closePreview = async () => {
    if (!previewOpen) return;
    await call('preview.close-all');
    previewOpen = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = getData(await call('preview.status'));
      if (status && (status.state === 'stopped' || status.running === false)) {
        return;
      }
      await wait(100);
    }
    throw new Error('dx28_preview_did_not_stop');
  };

  const createObjectWithResourceProperty = async ({
    sceneName,
    query,
    hint,
    prefix,
  }) => {
    const listed = getData(
      await call('editor.types.objects.list', {
        query,
        deprecated: 'exclude',
        renderingMode: '2d',
        limit: 100,
      })
    );
    const candidates =
      listed && Array.isArray(listed.items)
        ? listed.items.filter(item => item && item.kind === 'object')
        : [];
    assert(candidates.length > 0, `dx28_no_object_candidates:${hint}`);
    for (let index = 0; index < Math.min(candidates.length, 16); index++) {
      const candidate = candidates[index];
      const objectName = `${prefix}${index}`;
      try {
        await mutate('editor.functions.create-object', {
          scene_name: sceneName,
          object_name: objectName,
          object_type: candidate.type,
        });
      } catch (_) {
        continue;
      }
      const described = getData(
        await call('objects.properties.describe', {
          targetKind: 'object-definition',
          sceneName,
          objectName,
        })
      );
      const property = chooseResourceProperty(described, hint);
      if (property) {
        return {
          objectName,
          objectType: candidate.type,
          property,
        };
      }
    }
    throw new Error(`dx28_resource_property_not_discovered:${hint}`);
  };

  try {
    session = await connect('initial');
    const tools = await session.listTools();
    assertVisualToolSchemas(tools);

    const initial = getData(await call('project.status'));
    assert(
      !initial || initial.projectOpen !== true,
      `dx28_requires_fresh_editor_without_open_project:${JSON.stringify({
        rootDir,
        fileIdentifier: initial && initial.fileIdentifier,
        projectName: initial && initial.projectName,
        hasUnsavedChanges: initial && initial.hasUnsavedChanges,
      })}`
    );

    await call('project.create', {
      name: 'DX28 Visual Resource Acceptance',
      idempotencyKey: 'dx28-create-project',
    });
    projectOpen = true;
    await wait(300);
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX28 Visual Resource Acceptance',
    });

    const baselinePersistence = getData(
      await call('project.persistence.status')
    );
    assert(
      baselinePersistence &&
        baselinePersistence.persisted &&
        baselinePersistence.persisted.serializedHash,
      'dx28_baseline_persisted_hash_missing'
    );
    const baselinePersistedHash = baselinePersistence.persisted.serializedHash;

    const begun = getData(
      await call('safety.transactions.begin', {
        label: 'DX-28 visual resource MCP-only acceptance',
      })
    );
    transactionId = begun && begun.transactionId;
    assert(transactionId, 'dx28_transaction_missing');

    const suffix = Date.now().toString(36);
    const sceneName = `DX28Visual${suffix}`;
    await mutate('editor.functions.create-scene', { scene_name: sceneName });

    const imageObject = await createObjectWithResourceProperty({
      sceneName,
      query: 'tiled',
      hint: 'image',
      prefix: `DX28Image${suffix}`,
    });
    const textObject = await createObjectWithResourceProperty({
      sceneName,
      query: 'text',
      hint: 'font',
      prefix: `DX28Text${suffix}`,
    });

    const imageName = `dx28-image-${suffix}`;
    const movedImageName = `${imageName}-moved`;
    const fontName = `dx28-font-${suffix}`;
    const firstImage = makePng(32, 16, [33, 143, 255, 255]);
    const replacementImage = makePng(64, 32, [246, 174, 45, 255]);

    const importedImage = getData(
      await mutate('resources.visual.import', {
        resourceName: imageName,
        kind: 'image',
        contentBase64: firstImage.toString('base64'),
      })
    );
    const importedFont = getData(
      await mutate('resources.visual.import', {
        resourceName: fontName,
        kind: 'font',
        contentBase64: FONT_BASE64,
      })
    );
    assert(
      importedImage &&
        importedImage.resource &&
        importedImage.resource.userAdded === true &&
        importedImage.resource.orphaned === true &&
        importedImage.visual &&
        importedImage.visual.image &&
        importedImage.visual.image.width === 32 &&
        importedImage.visual.image.height === 16 &&
        importedImage.visual.image.hasAlpha === true,
      'dx28_image_import_metadata_invalid'
    );
    assert(
      importedFont &&
        importedFont.resource &&
        importedFont.resource.userAdded === true &&
        importedFont.visual &&
        importedFont.visual.font &&
        importedFont.visual.font.format === 'ttf' &&
        importedFont.visual.font.registeredAsProjectFont === true &&
        importedFont.visual.font.usableByTextObjects === true,
      'dx28_font_import_metadata_invalid'
    );

    await mutate('objects.properties.set', {
      targetKind: 'object-definition',
      sceneName,
      objectName: imageObject.objectName,
      changes: [{ path: imageObject.property.path, value: imageName }],
    });
    await mutate('objects.properties.set', {
      targetKind: 'object-definition',
      sceneName,
      objectName: textObject.objectName,
      changes: [{ path: textObject.property.path, value: fontName }],
    });

    await mutate('scene.instances.create', {
      sceneName,
      objectName: imageObject.objectName,
      position: { x: 40, y: 40 },
    });
    await mutate('scene.instances.create', {
      sceneName,
      objectName: textObject.objectName,
      position: { x: 120, y: 40 },
    });

    let imageInspect = getData(
      await call('resources.visual.inspect', { resourceName: imageName })
    );
    const fontInspect = getData(
      await call('resources.visual.inspect', { resourceName: fontName })
    );
    assert(
      imageInspect &&
        imageInspect.resource &&
        imageInspect.resource.usedInProject === true &&
        imageInspect.resource.orphaned === false &&
        imageInspect.usages &&
        imageInspect.usages.usedInProject === true &&
        imageInspect.usages.objectUsages.some(
          usage =>
            usage.sceneName === sceneName &&
            usage.objectName === imageObject.objectName
        ),
      'dx28_image_usage_missing'
    );
    assert(
      imageInspect.structuralConstraints &&
        imageInspect.structuralConstraints.some(
          constraint =>
            constraint.structuralConstraint === 'tiled-texture' ||
            constraint.structuralConstraint === 'nine-patch-texture'
        ),
      'dx28_image_structural_constraint_missing'
    );
    assert(
      fontInspect &&
        fontInspect.resource &&
        fontInspect.resource.usedInProject === true &&
        fontInspect.resource.orphaned === false &&
        fontInspect.font &&
        fontInspect.font.textObjectUsages.some(
          usage =>
            usage.sceneName === sceneName &&
            usage.objectName === textObject.objectName
        ),
      'dx28_font_usage_missing'
    );

    const usageBeforeRelocate = usageSignature(imageInspect);
    const relocateDryRun = getData(
      await call('resources.visual.relocate', {
        resourceName: imageName,
        newResourceName: movedImageName,
        newRelativePath: `art/${movedImageName}.png`,
      })
    );
    assert(
      relocateDryRun &&
        relocateDryRun.dryRun === true &&
        relocateDryRun.newResourceName === movedImageName,
      'dx28_relocate_dry_run_invalid'
    );
    const relocated = getData(
      await mutate('resources.visual.relocate', {
        resourceName: imageName,
        newResourceName: movedImageName,
        newRelativePath: `art/${movedImageName}.png`,
        dryRun: false,
      })
    );
    assert(
      relocated &&
        relocated.relocated === true &&
        relocated.referencesPreserved === true &&
        relocated.resource &&
        relocated.resource.name === movedImageName &&
        relocated.resource.projectRelativePath === `art/${movedImageName}.png`,
      'dx28_relocate_apply_invalid'
    );

    imageInspect = getData(
      await call('resources.visual.inspect', {
        resourceName: movedImageName,
      })
    );
    assert(
      imageInspect &&
        imageInspect.resource &&
        imageInspect.resource.usedInProject === true &&
        JSON.stringify(usageSignature(imageInspect)) ===
          JSON.stringify(usageBeforeRelocate),
      'dx28_relocate_reference_not_preserved'
    );
    const oldNameAfterMove = await call(
      'resources.visual.inspect',
      { resourceName: imageName },
      { allowError: true }
    );
    const oldNameAfterMoveError = extractError(oldNameAfterMove);
    assert(
      oldNameAfterMove.isError === true &&
        oldNameAfterMoveError &&
        oldNameAfterMoveError.code === 'resource_not_found',
      'dx28_relocate_old_name_still_registered'
    );
    const usageBeforeReplace = usageSignature(imageInspect);
    const shaBeforeReplace = imageInspect.physical.sha256;
    const pathBeforeReplace = imageInspect.resource.projectRelativePath;

    const replaced = getData(
      await mutate('resources.visual.replace', {
        resourceName: movedImageName,
        contentBase64: replacementImage.toString('base64'),
      })
    );
    assert(
      replaced &&
        replaced.replaced === true &&
        replaced.referencesPreserved === true &&
        replaced.visual &&
        replaced.visual.image &&
        replaced.visual.image.width === 64 &&
        replaced.visual.image.height === 32,
      'dx28_replace_invalid'
    );

    const imageAfterReplace = getData(
      await call('resources.visual.inspect', {
        resourceName: movedImageName,
      })
    );
    assert(
      imageAfterReplace.resource.name === movedImageName &&
        imageAfterReplace.resource.projectRelativePath === pathBeforeReplace &&
        imageAfterReplace.physical.sha256 !== shaBeforeReplace &&
        JSON.stringify(usageSignature(imageAfterReplace)) ===
          JSON.stringify(usageBeforeReplace),
      'dx28_replace_semantic_diff_not_clean'
    );
    const deleteDryRun = getData(
      await call('resources.visual.delete', {
        resourceName: movedImageName,
        deleteFile: true,
      })
    );
    assert(
      deleteDryRun &&
        deleteDryRun.dryRun === true &&
        deleteDryRun.blocked === true &&
        deleteDryRun.blockReason === 'resource_in_use' &&
        deleteDryRun.wouldRemoveResource === false &&
        deleteDryRun.usages &&
        deleteDryRun.usages.usedInProject === true,
      'dx28_delete_dry_run_did_not_block'
    );

    const revisionBeforeDelete = getRevision(await call('project.status'));
    const deleteApply = await call(
      'resources.visual.delete',
      {
        resourceName: movedImageName,
        deleteFile: true,
        dryRun: false,
        expectedRevision: revisionBeforeDelete,
        idempotencyKey: `dx28-delete-in-use-${revisionBeforeDelete}`,
      },
      { allowError: true }
    );
    assert(deleteApply.isError === true, 'dx28_delete_in_use_should_fail');
    const deleteError = extractError(deleteApply);
    assert(
      deleteError && deleteError.code === 'resource_in_use',
      'dx28_delete_in_use_error_not_structured'
    );
    const revisionAfterDelete = getRevision(await call('project.status'));
    assert(
      revisionAfterDelete === revisionBeforeDelete,
      'dx28_failed_delete_changed_project_revision'
    );
    await call('resources.visual.inspect', { resourceName: movedImageName });

    const packaging = getData(await call('resources.packaging.inspect', {}));
    const imagePackaging = (packaging.resources || []).find(
      resource => resource.name === movedImageName
    );
    const fontPackaging = (packaging.resources || []).find(
      resource => resource.name === fontName
    );
    for (const entry of [imagePackaging, fontPackaging]) {
      assert(entry && entry.willPackage === true, 'dx28_packaging_missing');
      assert(
        entry.runtimeResolution &&
          entry.runtimeResolution.preview === entry.exportedFilename &&
          entry.runtimeResolution.web === entry.exportedFilename &&
          entry.runtimeResolution.desktop === entry.exportedFilename &&
          entry.runtimeResolution.mobile === entry.exportedFilename,
        'dx28_runtime_resolution_invalid'
      );
    }

    const validation = getData(
      await call('validation.run', {
        includeNativeReport: false,
        includeAssets: true,
      })
    );
    const validationErrors =
      validation && Array.isArray(validation.errors)
        ? validation.errors.length
        : validation && Number.isInteger(validation.errorCount)
        ? validation.errorCount
        : validation &&
          validation.summary &&
          Number.isInteger(validation.summary.errors)
        ? validation.summary.errors
        : 0;
    assert(validationErrors === 0, 'dx28_validation_has_errors');

    await call('scene.open', { sceneName, mode: 'scene' });
    const preview = getData(
      await call('preview.start', {
        numberOfWindows: 1,
        waitUntilReady: true,
        readyTimeoutMs: 10000,
      })
    );
    assert(
      preview && preview.state === 'ready' && preview.runtimeReady === true,
      'dx28_preview_not_ready'
    );
    previewOpen = true;

    let previewWindow = null;
    for (let attempt = 0; attempt < 30 && !previewWindow; attempt++) {
      previewWindow = findPreviewWindow(
        getData(await call('desktop.windows.list'))
      );
      if (!previewWindow) await wait(100);
    }
    assert(
      previewWindow && typeof previewWindow.url === 'string',
      'dx28_preview_window_missing'
    );
    const previewImageBytes = await readRuntimeBytes(
      previewWindow.url,
      imagePackaging.exportedFilename
    );
    const previewFontBytes = await readRuntimeBytes(
      previewWindow.url,
      fontPackaging.exportedFilename
    );
    assert(
      crypto
        .createHash('sha256')
        .update(previewImageBytes)
        .digest('hex') === imageAfterReplace.physical.sha256,
      'dx28_preview_image_packaging_mismatch'
    );
    assert(
      crypto
        .createHash('sha256')
        .update(previewFontBytes)
        .digest('hex') === fontInspect.physical.sha256,
      'dx28_preview_font_packaging_mismatch'
    );

    await closePreview();

    const evidence = sanitizeForReplay({
      kind: 'dx28-visual-resource-clean-room',
      generatedAt: new Date().toISOString(),
      protocolVersion: session.protocolVersion,
      cleanRoom: {
        repositoryImplementationOrTestsReadDuringScenario: false,
        repositoryReadGuard: true,
        authoringInputSource: 'live MCP discovery and public tools',
      },
      discovery: {
        imageObjectType: imageObject.objectType,
        imagePropertyPath: imageObject.property.path,
        textObjectType: textObject.objectType,
        fontPropertyPath: textObject.property.path,
      },
      import: {
        image: {
          resourceName: imageName,
          projectRelativePath: importedImage.resource.projectRelativePath,
          mimeType: importedImage.visual.physical.mimeType,
          width: importedImage.visual.image.width,
          height: importedImage.visual.image.height,
          hasAlpha: importedImage.visual.image.hasAlpha,
        },
        font: {
          resourceName: fontName,
          projectRelativePath: importedFont.resource.projectRelativePath,
          format: importedFont.visual.font.format,
          family: importedFont.visual.font.family,
          usableByTextObjects: importedFont.visual.font.usableByTextObjects,
        },
      },
      relocation: {
        dryRunBlockedMutation: true,
        applied: true,
        resourceName: movedImageName,
        projectRelativePath: imageAfterReplace.resource.projectRelativePath,
        referencesPreserved: true,
      },
      replacement: {
        referencesPreserved: true,
        usagesUnchanged: true,
        shaChanged: true,
        width: imageAfterReplace.image.width,
        height: imageAfterReplace.image.height,
      },
      deletion: {
        dryRunBlocked: true,
        applyRejected: true,
        errorCode: deleteError.code,
        revisionUnchanged: true,
      },
      packaging: {
        image: imagePackaging.runtimeResolution,
        font: fontPackaging.runtimeResolution,
        previewBytesVerified: true,
      },
      preview: {
        ready: true,
        runtimeReady: true,
        validationErrors,
      },
      replay,
    });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

    await call('safety.transactions.rollback', { transactionId });
    transactionId = null;
    await session.close();
    session = await connect('after-rollback');

    const afterRollbackStatus = getData(await call('project.status'));
    assert(
      afterRollbackStatus &&
        Array.isArray(afterRollbackStatus.sceneNames) &&
        !afterRollbackStatus.sceneNames.includes(sceneName),
      'dx28_transaction_rollback_scene_survived'
    );
    const afterRollbackPersistence = getData(
      await call('project.persistence.status')
    );
    assert(
      afterRollbackPersistence &&
        afterRollbackPersistence.persisted &&
        afterRollbackPersistence.persisted.serializedHash ===
          baselinePersistedHash &&
        afterRollbackPersistence.hasUnsavedChanges === false,
      'dx28_transaction_rollback_not_clean'
    );

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;
    await session.close();
    session = null;
    fs.rmSync(rootDir, { recursive: true, force: true });

    return {
      ok: true,
      protocolVersion: evidence.protocolVersion,
      imageObjectType: imageObject.objectType,
      imagePropertyPath: imageObject.property.path,
      textObjectType: textObject.objectType,
      fontPropertyPath: textObject.property.path,
      imageResourceName: movedImageName,
      fontResourceName: fontName,
      previewReady: true,
      previewPackagingVerified: true,
      replaceReferencesPreserved: true,
      replaceUsagesUnchanged: true,
      deleteInUseBlocked: true,
      transactionRollbackClean: true,
      evidencePath,
    };
  } finally {
    try {
      if (session && previewOpen) {
        await session.call('preview.close-all', {});
      }
    } catch (_) {}
    try {
      if (session && transactionId) {
        await session.call('safety.transactions.rollback', { transactionId });
      }
    } catch (_) {}
    try {
      if (session && projectOpen) {
        await session.call('project.close', { discardUnsavedChanges: true });
      }
    } catch (_) {}
    try {
      if (session) await session.close();
    } catch (_) {}
    fs.rmSync(rootDir, { recursive: true, force: true });
    restoreRepositoryReads();
  }
};

if (require.main === module) {
  let label = 'live';
  let evidencePath;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--label') label = args[++index];
    else if (args[index] === '--evidence') evidencePath = args[++index];
    else throw new Error('unknown_argument:' + args[index]);
  }
  run({ label, ...(evidencePath ? { evidencePath } : {}) })
    .then(result => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch(error => {
      process.stderr.write(
        'MCP DX-28 visual resource scenario failed: ' +
          (error && error.stack ? error.stack : String(error)) +
          '\n'
      );
      process.exitCode = 1;
    });
}

module.exports = {
  assertVisualToolSchemas,
  chooseResourceProperty,
  extractError,
  makePng,
  usageSignature,
  run,
};
