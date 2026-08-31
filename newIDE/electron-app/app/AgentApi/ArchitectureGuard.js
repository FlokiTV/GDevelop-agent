const { spawnSync } = require('child_process');
const path = require('path');

const ALLOWED_PREFIXES = [
  'newIDE/app/src/AgentApi/',
  'newIDE/electron-app/app/AgentApi/',
  'newIDE/app/src/AgentIntegration/',
  'newIDE/electron-app/app/AgentIntegration/',
];

const ALLOWED_UPSTREAM_HOOKS = new Set([
  'newIDE/app/src/MainFrame/index.js',
  'newIDE/electron-app/app/main.js',
  'newIDE/electron-app/app/PreviewWindow.js',
]);

const normalizeRepositoryPath = filePath => String(filePath).replace(/\\/g, '/');

const isAllowedAgentChange = filePath => {
  const normalized = normalizeRepositoryPath(filePath);
  return (
    ALLOWED_UPSTREAM_HOOKS.has(normalized) ||
    ALLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix))
  );
};

const findDisallowedAgentChanges = files =>
  files
    .map(normalizeRepositoryPath)
    .filter(Boolean)
    .filter(filePath => !isAllowedAgentChange(filePath));

const listChangedFiles = ({ repoRoot, baseRef }) => {
  const result = spawnSync(
    'git',
    ['diff', '--name-only', baseRef],
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
      console.error('[AgentApi architecture guard] Disallowed upstream changes:');
      for (const filePath of result.disallowedFiles) {
        console.error(`- ${filePath}`);
      }
      process.exitCode = 1;
    } else {
      console.log(
        `[AgentApi architecture guard] OK: ${result.changedFiles.length} changed files; upstream hooks limited to ${result.allowedUpstreamHooks.length}.`
      );
    }
  } catch (error) {
    console.error(
      `[AgentApi architecture guard] ${
        error && error.message ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_PREFIXES,
  ALLOWED_UPSTREAM_HOOKS,
  normalizeRepositoryPath,
  isAllowedAgentChange,
  findDisallowedAgentChanges,
  listChangedFiles,
  runArchitectureGuard,
};
