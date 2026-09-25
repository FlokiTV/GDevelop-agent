const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { connectLiveGDevelopMcp, sanitizeForReplay } = require('./McpClient');

const SCENE_NAME = 'DX16TextResourceAcceptance';
const LOCALE_RESOURCE_NAME = 'locales/es.json';
const LOCALE_RELATIVE_PATH = 'locales/es.json';
const REQUIRED_TOOLS = [
  'project.status',
  'project.create',
  'project.save-as',
  'project.save',
  'project.close',
  'editor.functions.create-scene',
  'scene.open',
  'resources.text.create',
  'resources.text.read',
  'resources.text.update',
  'resources.packaging.inspect',
  'validation.run',
  'preview.status',
  'preview.start',
  'preview.close-all',
  'desktop.windows.list',
  'export.html5',
];

const wait = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const getData = result =>
  result && result.data
    ? result.data
    : result &&
      result.structuredContent &&
      result.structuredContent.data
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
      : null;
  assert(Number.isInteger(revision), 'dx16_missing_project_revision');
  return revision;
};

const readRuntimeResource = async (previewUrl, exportedFilename) => {
  const resourceUrl = new URL(exportedFilename, previewUrl);
  if (resourceUrl.protocol === 'file:') {
    return fs.readFileSync(fileURLToPath(resourceUrl), 'utf8');
  }
  const response = await fetch(resourceUrl);
  if (!response.ok) {
    throw new Error(
      `dx16_preview_resource_http_error:${response.status}:${resourceUrl.href}`
    );
  }
  return response.text();
};

const findPreviewWindow = windows =>
  Array.isArray(windows)
    ? windows.find(window => window && window.previewWindow === true)
    : null;

const run = async ({
  label = 'live',
  evidencePath = path.join(
    os.tmpdir(),
    `gdevelop-dx16-text-resources-${process.pid}.json`
  ),
} = {}) => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gdevelop-dx16-text-resource-')
  );
  const projectDir = path.join(rootDir, 'project');
  const projectFile = path.join(projectDir, 'game.json');
  const exportDir = path.join(rootDir, 'html5');
  fs.mkdirSync(projectDir, { recursive: true });

  const session = await connectLiveGDevelopMcp({
    clientId: `gdevelop-dx16-text-resources-${label}`,
  });
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

  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await session.call(name, args);
    record(name, args, result);
    if (result.isError && !allowError) {
      throw new Error(
        `${name} failed: ${JSON.stringify(
          result.structuredContent || result.content || result.data
        )}`
      );
    }
    return result;
  };

  const mutate = async (name, args = {}) => {
    const status = await call('project.status');
    const revision = getRevision(status);
    return call(name, {
      ...args,
      expectedRevision: revision,
      idempotencyKey: `dx16-${name}-${revision}-${replay.length}`,
    });
  };

  const closePreview = async () => {
    if (!previewOpen) return;
    await call('preview.close-all');
    previewOpen = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = getData(await call('preview.status'));
      if (status && status.state === 'stopped') return;
      await wait(100);
    }
    throw new Error('dx16_preview_did_not_stop');
  };

  try {
    const tools = await session.listTools();
    REQUIRED_TOOLS.forEach(name =>
      assert(
        tools.some(tool => tool.name === name),
        `dx16_missing_tool:${name}`
      )
    );

    const createTool = tools.find(
      tool => tool.name === 'resources.text.create'
    );
    const updateTool = tools.find(
      tool => tool.name === 'resources.text.update'
    );
    assert(
      createTool &&
        createTool.inputSchema &&
        createTool.inputSchema.properties &&
        createTool.inputSchema.properties.content,
      'dx16_create_schema_missing'
    );
    assert(
      updateTool &&
        updateTool.inputSchema &&
        updateTool.inputSchema.properties &&
        Array.isArray(
          updateTool.inputSchema.properties.resourceKind &&
            updateTool.inputSchema.properties.resourceKind.enum
        ),
      'dx16_update_schema_missing'
    );

    const initial = await call('project.status');
    const initialData = getData(initial);
    if (initialData && initialData.preview && initialData.preview.running) {
      await call('preview.close-all');
    }
    if (initialData && initialData.projectOpen) {
      assert(
        initialData.hasUnsavedChanges === false,
        'dx16_requires_clean_or_fresh_editor'
      );
      await call('project.close', { discardUnsavedChanges: false });
    }

    await call('project.create', {
      name: 'DX16 Text Resource Acceptance',
      idempotencyKey: 'dx16-create-project',
    });
    projectOpen = true;
    await wait(300);
    await call('project.save-as', {
      filePath: projectFile,
      name: 'DX16 Text Resource Acceptance',
    });

    await mutate('editor.functions.create-scene', {
      scene_name: SCENE_NAME,
    });
    await call('scene.open', { sceneName: SCENE_NAME, mode: 'scene' });

    const firstLocale = JSON.stringify(
      {
        locale: 'es-ES',
        greeting: 'Hola',
        fallback: 'English',
      },
      null,
      2
    );
    const created = getData(
      await mutate('resources.text.create', {
        resourceName: LOCALE_RESOURCE_NAME,
        relativePath: LOCALE_RELATIVE_PATH,
        format: 'json',
        content: firstLocale,
      })
    );
    assert(created && created.written === true, 'dx16_locale_create_failed');
    assert(created.created === true, 'dx16_locale_not_created');
    assert(
      created.resource &&
        created.resource.kind === 'json' &&
        created.resource.file === LOCALE_RELATIVE_PATH &&
        created.resource.userAdded === true &&
        created.resource.fileExists === true &&
        created.resource.insideProjectFolder === true,
      'dx16_locale_resource_registration_invalid'
    );

    const readCreated = getData(
      await call('resources.text.read', {
        resourceName: LOCALE_RESOURCE_NAME,
        parseJson: true,
      })
    );
    assert(
      readCreated &&
        readCreated.jsonValid === true &&
        readCreated.json &&
        readCreated.json.locale === 'es-ES' &&
        readCreated.json.greeting === 'Hola',
      'dx16_locale_read_after_create_invalid'
    );

    const revisionBeforeInvalid = getRevision(await call('project.status'));
    const invalidUpdate = await call(
      'resources.text.update',
      {
        resourceName: LOCALE_RESOURCE_NAME,
        format: 'json',
        content: '{"locale":"es-ES","broken":',
        expectedRevision: revisionBeforeInvalid,
        idempotencyKey: 'dx16-invalid-json-update',
      },
      { allowError: true }
    );
    assert(invalidUpdate.isError === true, 'dx16_invalid_json_was_accepted');
    const invalidPayload =
      invalidUpdate.structuredContent || invalidUpdate.data || {};
    const invalidCode =
      invalidPayload &&
      invalidPayload.error &&
      invalidPayload.error.code;
    assert(
      invalidCode === 'invalid_resource_json',
      `dx16_invalid_json_error_unexpected:${invalidCode}`
    );
    const revisionAfterInvalid = getRevision(await call('project.status'));
    assert(
      revisionAfterInvalid === revisionBeforeInvalid,
      'dx16_invalid_json_changed_revision'
    );
    const readAfterInvalid = getData(
      await call('resources.text.read', {
        resourceName: LOCALE_RESOURCE_NAME,
        parseJson: true,
      })
    );
    assert(
      readAfterInvalid.content === firstLocale,
      'dx16_invalid_json_changed_file_bytes'
    );

    const updatedLocale = JSON.stringify(
      {
        locale: 'es-ES',
        greeting: 'Buenas',
        fallback: 'English',
        version: 2,
      },
      null,
      2
    );
    const updated = getData(
      await mutate('resources.text.update', {
        resourceName: LOCALE_RESOURCE_NAME,
        format: 'json',
        content: updatedLocale,
      })
    );
    assert(
      updated &&
        updated.updated === true &&
        updated.jsonValidated === true,
      'dx16_locale_update_failed'
    );

    const packaging = getData(
      await call('resources.packaging.inspect', {
        resourceName: LOCALE_RESOURCE_NAME,
      })
    );
    assert(
      packaging &&
        Array.isArray(packaging.resources) &&
        packaging.resources.length === 1,
      'dx16_packaging_inspection_missing'
    );
    const packagedLocale = packaging.resources[0];
    assert(
      packagedLocale.packagingStatus === 'will-package' &&
        packagedLocale.willPackage === true &&
        packagedLocale.userAdded === true &&
        packagedLocale.usedInProject === false &&
        packagedLocale.orphaned === true,
      'dx16_packaging_semantics_invalid'
    );
    assert(
      packagedLocale.runtimeResolution &&
        packagedLocale.runtimeResolution.resourceName ===
          LOCALE_RESOURCE_NAME &&
        packagedLocale.runtimeResolution.loaderReference ===
          LOCALE_RESOURCE_NAME &&
        packagedLocale.runtimeResolution.exportedFile ===
          packagedLocale.exportedFilename,
      'dx16_runtime_resolution_invalid'
    );
    const exportedFilename = packagedLocale.exportedFilename;
    assert(
      typeof exportedFilename === 'string' && exportedFilename.length > 0,
      'dx16_exported_filename_missing'
    );

    const validation = getData(
      await call('validation.run', {
        includeNativeReport: false,
        includeAssets: true,
      })
    );
    assert(validation && validation.ok === true, 'dx16_validation_failed');
    const validationErrors = Array.isArray(validation.errors)
      ? validation.errors.length
      : Number.isInteger(validation.errorCount)
      ? validation.errorCount
      : 0;

    const start = getData(
      await call('preview.start', {
        numberOfWindows: 1,
        waitUntilReady: true,
        readyTimeoutMs: 10000,
      })
    );
    assert(
      start && start.state === 'ready' && start.runtimeReady === true,
      'dx16_preview_not_ready'
    );
    previewOpen = true;

    let previewWindow = null;
    for (let attempt = 0; attempt < 30 && !previewWindow; attempt++) {
      const windows = getData(await call('desktop.windows.list'));
      previewWindow = findPreviewWindow(windows);
      if (!previewWindow) await wait(100);
    }
    assert(previewWindow, 'dx16_preview_window_missing');
    assert(
      typeof previewWindow.url === 'string' && previewWindow.url,
      'dx16_preview_url_missing'
    );
    const previewContent = await readRuntimeResource(
      previewWindow.url,
      exportedFilename
    );
    assert(
      previewContent === updatedLocale,
      'dx16_preview_packaged_resource_content_mismatch'
    );
    await closePreview();

    fs.rmSync(exportDir, { recursive: true, force: true });
    const exported = getData(
      await call('export.html5', { outputDir: exportDir })
    );
    assert(
      exported &&
        path.resolve(exported.outputDir || '') === path.resolve(exportDir),
      'dx16_html5_export_failed'
    );
    const html5ResourcePath = path.join(exportDir, exportedFilename);
    assert(
      fs.existsSync(html5ResourcePath),
      'dx16_html5_packaged_resource_missing'
    );
    assert(
      fs.readFileSync(html5ResourcePath, 'utf8') === updatedLocale,
      'dx16_html5_packaged_resource_content_mismatch'
    );

    await call('project.save');
    const finalStatus = await call('project.status');
    const finalRevision = getRevision(finalStatus);
    const finalStatusData = getData(finalStatus);
    assert(
      finalStatusData && finalStatusData.hasUnsavedChanges === false,
      'dx16_project_not_clean_after_save'
    );

    const evidence = {
      kind: 'dx16-text-resources-live-acceptance',
      label,
      protocolVersion: session.protocolVersion,
      projectRevision: {
        final: finalRevision,
        invalidJsonBefore: revisionBeforeInvalid,
        invalidJsonAfter: revisionAfterInvalid,
        invalidJsonUnchanged:
          revisionBeforeInvalid === revisionAfterInvalid,
      },
      locale: {
        resourceName: LOCALE_RESOURCE_NAME,
        file: LOCALE_RELATIVE_PATH,
        jsonValid: true,
        updatedGreeting: 'Buenas',
        byteLength: updated.byteLength,
      },
      packaging: {
        status: packagedLocale.packagingStatus,
        userAdded: packagedLocale.userAdded,
        usedInProject: packagedLocale.usedInProject,
        orphaned: packagedLocale.orphaned,
        exportedFilename,
        runtimeResolution: packagedLocale.runtimeResolution,
        previewContentVerified: true,
        html5ContentVerified: true,
      },
      validationErrors,
      replay,
    };
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

    await call('project.close', { discardUnsavedChanges: false });
    projectOpen = false;

    console.log(
      JSON.stringify(
        {
          ok: true,
          label,
          protocolVersion: session.protocolVersion,
          locale: evidence.locale,
          packaging: evidence.packaging,
          invalidJsonUnchanged:
            evidence.projectRevision.invalidJsonUnchanged,
          validationErrors,
          evidencePath,
        },
        null,
        2
      )
    );
  } finally {
    if (previewOpen) {
      try {
        await session.call('preview.close-all', {});
      } catch (_) {}
    }
    if (projectOpen) {
      try {
        await session.call('project.close', {
          discardUnsavedChanges: true,
        });
      } catch (_) {}
    }
    await session.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
};

if (require.main === module) {
  let label = 'live';
  let evidencePath;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--label') label = args[++index];
    else if (args[index] === '--evidence') evidencePath = args[++index];
    else throw new Error(`unknown_argument:${args[index]}`);
  }
  run({ label, ...(evidencePath ? { evidencePath } : {}) }).catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  run,
  REQUIRED_TOOLS,
  SCENE_NAME,
  LOCALE_RESOURCE_NAME,
  getData,
  readRuntimeResource,
};
