const { spawnSync } = require('child_process');
const path = require('path');

const ALLOWED_PREFIXES = [
  'newIDE/app/src/AgentIntegration/',
  'newIDE/electron-app/app/AgentIntegration/',
];

const ALLOWED_UPSTREAM_HOOKS = new Set([
  'newIDE/app/src/MainFrame/index.js',
  'newIDE/electron-app/app/main.js',
  'newIDE/electron-app/app/PreviewWindow.js',
]);

const ALLOWED_DEPENDENCY_MANIFESTS = new Set([
  'newIDE/electron-app/app/package.json',
  'newIDE/electron-app/app/package-lock.json',
]);

const ALLOWED_REPOSITORY_METADATA = new Set([
  '.github/workflows/agent-integration.yml',
]);

const normalizeRepositoryPath = filePath => String(filePath).replace(/\\/g, '/');

const isAllowedAgentChange = filePath => {
  const normalized = normalizeRepositoryPath(filePath);
  return (
    ALLOWED_UPSTREAM_HOOKS.has(normalized) ||
    ALLOWED_DEPENDENCY_MANIFESTS.has(normalized) ||
    ALLOWED_REPOSITORY_METADATA.has(normalized) ||
    ALLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix))
  );
};

const findDisallowedAgentChanges = files =>
  files
    .map(normalizeRepositoryPath)
    .filter(Boolean)
    .filter(filePath => !isAllowedAgentChange(filePath));

const listChangedFiles = ({ repoRoot, baseRef }) => {
  const mergeBaseResult = spawnSync('git', ['merge-base', 'HEAD', baseRef], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (mergeBaseResult.status !== 0) {
    const error = new Error(
      `architecture_guard_merge_base_failed:${baseRef}:${
        mergeBaseResult.stderr || mergeBaseResult.stdout || 'unknown_error'
      }`
    );
    error.code = 'architecture_guard_git_diff_failed';
    throw error;
  }

  const mergeBase = mergeBaseResult.stdout.trim();
  const result = spawnSync(
    'git',
    ['diff', '--name-only', `${mergeBase}..HEAD`],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    }
  );

  if (result.status !== 0) {
    const error = new Error(
      `architecture_guard_git_diff_failed:${baseRef}:${
        result.stderr || result.stdout || 'unknown_error'
      }`
    );
    error.code = 'architecture_guard_git_diff_failed';
    throw error;
  }

  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
};

const runArchitectureGuard = ({ repoRoot, baseRef = 'upstream/master' }) => {
  const changedFiles = listChangedFiles({ repoRoot, baseRef });
  const disallowedFiles = findDisallowedAgentChanges(changedFiles);
  return {
    ok: disallowedFiles.length === 0,
    baseRef,
    changedFiles,
    disallowedFiles,
    allowedUpstreamHooks: Array.from(ALLOWED_UPSTREAM_HOOKS),
    allowedPrefixes: [...ALLOWED_PREFIXES],
  };
};

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const baseRef =
    process.argv[2] || process.env.GDEVELOP_AGENT_UPSTREAM_REF || 'upstream/master';

  try {
    const result = runArchitectureGuard({ repoRoot, baseRef });
    if (!result.ok) {
      console.error('[AgentIntegration architecture guard] Disallowed upstream changes:');
      for (const filePath of result.disallowedFiles) {
        console.error(`- ${filePath}`);
      }
      process.exitCode = 1;
    } else {
      console.log(
        `[AgentIntegration architecture guard] OK: ${result.changedFiles.length} changed files; upstream hooks limited to ${result.allowedUpstreamHooks.length}.`
      );
    }
  } catch (error) {
    console.error(
      `[AgentIntegration architecture guard] ${
        error && error.message ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_PREFIXES,
  ALLOWED_UPSTREAM_HOOKS,
  ALLOWED_DEPENDENCY_MANIFESTS,
  ALLOWED_REPOSITORY_METADATA,
  normalizeRepositoryPath,
  isAllowedAgentChange,
  findDisallowedAgentChanges,
  listChangedFiles,
  runArchitectureGuard,
};
