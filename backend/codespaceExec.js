'use strict';

/**
 * codespaceExec.js — Codespace execution bridge
 * ------------------------------------------------------------------
 * Provides:
 *   - execInCodespace(codespaceName, command, { cwd })  → run a shell command
 *     inside a live GitHub Codespace via the GitHub CLI (`gh`) managed SSH tunnel.
 *   - ensureCodespaceRunning(codespaceName)              → check state via GitHub
 *     REST API, start if needed, poll until Available.
 *   - Auxiliary GitHub REST helpers (listCodespacesForRepo, createCodespace,
 *     listMachines, getCodespaceState) reused by tools.js and server.js.
 *
 * WHY `gh codespace ssh`?
 *   GitHub's REST API does NOT expose a simple "run a shell command in a
 *   codespace" endpoint. The real-world, documented approach to script into a
 *   running codespace non-interactively is the GitHub CLI (`gh`), authenticated
 *   via the `GH_TOKEN` environment variable (gh reads GH_TOKEN automatically —
 *   no `gh auth login` interactive flow needed).
 *
 *   Reference: https://cli.github.com/manual/gh_codespace_ssh
 *
 *   The one-off command form is:
 *     gh codespace ssh --codespace <name> -- <shell command>
 *   which opens a managed SSH tunnel, runs the command, and returns
 *   stdout/stderr + exit code. This is the simplest robust approach.
 *
 * ASSUMPTION (noted for easy adjustment):
 *   The exact flags for non-interactive command execution via `gh codespace ssh`
 *   can vary slightly by gh CLI version. The command construction is isolated
 *   in buildGhArgs() below — adjust in ONE place if the exact flag differs.
 */

const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || process.env.GITHUB_ACCESS_TOKEN || '';
const GITHUB_SANDBOX_REPO = process.env.GITHUB_SANDBOX_REPO || ''; // "owner/repo"
const CODESPACE_MACHINE_TYPE = process.env.CODESPACE_MACHINE_TYPE || 'largePremiumLinux';
const CODESPACE_EXEC_TIMEOUT = parseInt(process.env.CODESPACE_EXEC_TIMEOUT || '60000', 10);

const GITHUB_API = 'https://api.github.com';

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-Github-Api-Version': '2022-11-28',
  };
}

/**
 * Get the state of a codespace by name.
 * GET /user/codespaces/{codespace_name}
 * @returns {Promise<object|null>} codespace object or null if not found
 */
async function getCodespaceState(codespaceName) {
  const url = `${GITHUB_API}/user/codespaces/${encodeURIComponent(codespaceName)}`;
  const r = await fetch(url, { headers: githubHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub API error ${r.status}: ${await r.text()}`);
  return r.json();
}

/**
 * List codespaces for the configured sandbox repo.
 * GET /repos/{owner}/{repo}/codespaces
 * @returns {Promise<array>} array of codespace objects
 */
async function listCodespacesForRepo() {
  if (!GITHUB_SANDBOX_REPO) throw new Error('GITHUB_SANDBOX_REPO is not configured');
  const url = `${GITHUB_API}/repos/${GITHUB_SANDBOX_REPO}/codespaces`;
  const r = await fetch(url, { headers: githubHeaders() });
  if (!r.ok) throw new Error(`GitHub API error ${r.status}: ${await r.text()}`);
  const body = await r.json();
  return body.codespaces || body || [];
}

/**
 * Create a new codespace on the configured repo.
 * POST /repos/{owner}/{repo}/codespaces
 * @param {object} opts - { machine, branch, display_name }
 * @returns {Promise<object>} created codespace object
 */
async function createCodespace(opts = {}) {
  if (!GITHUB_SANDBOX_REPO) throw new Error('GITHUB_SANDBOX_REPO is not configured');
  const url = `${GITHUB_API}/repos/${GITHUB_SANDBOX_REPO}/codespaces`;
  const payload = {
    machine: opts.machine || CODESPACE_MACHINE_TYPE,
    ...(opts.branch ? { ref: opts.branch } : {}),
    ...(opts.display_name ? { display_name: opts.display_name } : {}),
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`GitHub API error ${r.status}: ${body}`);
  return JSON.parse(body);
}

/**
 * List available machine types for the configured repo.
 * GET /repos/{owner}/{repo}/codespaces/machines
 * @returns {Promise<array>} machine objects
 */
async function listMachines() {
  if (!GITHUB_SANDBOX_REPO) throw new Error('GITHUB_SANDBOX_REPO is not configured');
  const url = `${GITHUB_API}/repos/${GITHUB_SANDBOX_REPO}/codespaces/machines`;
  const r = await fetch(url, { headers: githubHeaders() });
  if (!r.ok) throw new Error(`GitHub API error ${r.status}: ${await r.text()}`);
  const body = await r.json();
  return body.machines || body || [];
}

/**
 * Delete a codespace by name.
 * DELETE /user/codespaces/{codespace_name}
 */
async function deleteCodespace(codespaceName) {
  const url = `${GITHUB_API}/user/codespaces/${encodeURIComponent(codespaceName)}`;
  const r = await fetch(url, { method: 'DELETE', headers: githubHeaders() });
  if (r.status === 202 || r.status === 204) return true;
  if (!r.ok) throw new Error(`GitHub API error ${r.status}: ${await r.text()}`);
  return true;
}

/**
 * Start a codespace if it's not already Available.
 * POST /user/codespaces/{codespace_name}/start
 * Then poll GET /user/codespaces/{codespace_name} until state === 'Available'
 * (or timeout / max retries).
 *
 * @param {string} codespaceName
 * @param {object} opts - { maxRetries, retryDelayMs } (defaults: 10, 5000)
 * @returns {Promise<object>} final codespace state object
 */
async function ensureCodespaceRunning(codespaceName, opts = {}) {
  const maxRetries = opts.maxRetries ?? 10;
  const retryDelayMs = opts.retryDelayMs ?? 5000;

  let cs = await getCodespaceState(codespaceName);
  if (!cs) {
    throw new Error(`Codespace "${codespaceName}" not found`);
  }

  if (cs.state === 'Available') return cs;

  // Start it if not already starting/available
  if (cs.state !== 'Starting' && cs.state !== 'Available') {
    const startUrl = `${GITHUB_API}/user/codespaces/${encodeURIComponent(codespaceName)}/start`;
    await fetch(startUrl, { method: 'POST', headers: githubHeaders() });
  }

  // Poll until Available or timeout
  for (let i = 0; i < maxRetries; i++) {
    await sleep(retryDelayMs);
    cs = await getCodespaceState(codespaceName);
    if (!cs) throw new Error(`Codespace "${codespaceName}" disappeared during start`);
    if (cs.state === 'Available') return cs;
    if (cs.state === 'Shutdown' || cs.state === 'Failed') {
      throw new Error(`Codespace "${codespaceName}" entered ${cs.state} state during start`);
    }
    // Still 'Starting' or 'Queued' — keep polling
  }

  throw new Error(`Codespace "${codespaceName}" did not become Available after ${maxRetries} retries`);
}

// ---------------------------------------------------------------------------
// Codespace command execution via `gh codespace ssh`
// ---------------------------------------------------------------------------

/**
 * Build the argument array for `gh codespace ssh`.
 *
 * ADJUST THIS FUNCTION IF the exact gh CLI flags change across versions.
 * Current assumption (per https://cli.github.com/manual/gh_codespace_ssh):
 *   gh codespace ssh --codespace <name> -- bash -lc "<full command string>"
 *
 * The `--` separator tells gh that everything after it is the remote command.
 * We use `bash -lc` so the remote shell sources login profile files (PATH etc.)
 * and processes the full command string as a single shell invocation.
 *
 * @param {string} codespaceName
 * @param {string} command - the shell command to run remotely
 * @param {string} cwd - working directory inside the codespace (default '~')
 * @returns {string[]} args array for execFile('gh', args)
 */
function buildGhArgs(codespaceName, command, cwd) {
  // Escape single quotes in cwd to prevent injection through the path.
  const safeCwd = (cwd || '~').replace(/'/g, "'\\''");
  const fullCommand = `cd '${safeCwd}' && ${command}`;
  return [
    'codespace', 'ssh',
    '--codespace', codespaceName,
    '--',
    'bash', '-lc', fullCommand,
  ];
}

/**
 * Execute a shell command inside a live GitHub Codespace via `gh codespace ssh`.
 *
 * Uses child_process.execFile (not exec) so the codespace name is passed as a
 * discrete arg (no shell injection on the name). The remote command is a shell
 * command by design (constructed by tool implementations).
 *
 * Environment: GH_TOKEN is set from GITHUB_TOKEN (or GITHUB_ACCESS_TOKEN).
 * `gh` reads GH_TOKEN automatically — no `gh auth login` interactive flow needed.
 *
 * @param {string} codespaceName - the codespace's name (not its numeric ID)
 * @param {string} command - shell command to run inside the codespace
 * @param {object} options - { cwd, timeout }
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 *          NEVER throws on non-zero exit codes — returns exitCode + stderr so
 *          the AI can see failures and react. Only throws on infrastructure
 *          errors (gh binary not found, timeout exceeded, etc.).
 */
async function execInCodespace(codespaceName, command, options = {}) {
  const cwd = options.cwd;
  const timeout = options.timeout ?? CODESPACE_EXEC_TIMEOUT;
  const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024; // 10 MB

  // GH_TOKEN is what gh CLI reads for non-interactive auth.
  // Set it from GITHUB_TOKEN (or GITHUB_ACCESS_TOKEN fallback).
  const ghToken = GITHUB_TOKEN;
  const env = { ...process.env, GH_TOKEN: ghToken };

  const args = buildGhArgs(codespaceName, command, cwd);

  return new Promise((resolve) => {
    execFile('gh', args, { env, timeout, maxBuffer }, (error, stdout, stderr) => {
      if (error && error.killed) {
        // Timeout — command was killed
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: -1,
          error: `Command timed out after ${timeout}ms`,
        });
        return;
      }
      // error.code is the exit code when the process exited non-zero.
      // error.errno === 'ENOENT' means `gh` binary not found.
      if (error && error.code === 'ENOENT') {
        resolve({
          stdout: stdout || '',
          stderr: `gh CLI not found: ${error.message}`,
          exitCode: -1,
          error: 'gh CLI is not installed on the container',
        });
        return;
      }
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error ? (error.code ?? 1) : 0,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  // Execution
  execInCodespace,
  buildGhArgs,
  // Codespace lifecycle
  ensureCodespaceRunning,
  getCodespaceState,
  listCodespacesForRepo,
  createCodespace,
  deleteCodespace,
  listMachines,
  // Config (re-exported for tools.js / server.js)
  githubHeaders,
  GITHUB_API,
  GITHUB_TOKEN,
  GITHUB_SANDBOX_REPO,
  CODESPACE_MACHINE_TYPE,
};
