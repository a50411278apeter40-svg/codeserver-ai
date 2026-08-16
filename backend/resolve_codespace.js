'use strict';

/**
 * resolve_codespace.js — one-shot CLI helper used by start.sh
 * ------------------------------------------------------------------
 * Resolves (finds-or-creates) the GitHub Codespace for GITHUB_SANDBOX_REPO,
 * ensures it's Available (starting it if needed), and prints EXACTLY the
 * codespace name to stdout on success — nothing else. All progress/log
 * lines go to stderr so `CS_NAME=$(node resolve_codespace.js)` in bash
 * captures a clean value.
 *
 * Exit code 0 on success (name printed), non-zero on failure (error on
 * stderr, nothing on stdout). start.sh treats failure as non-fatal — the
 * editor still works against the local folder, just without the live
 * codespace filesystem/terminal wiring.
 */

const {
  listCodespacesForRepo,
  createCodespace,
  ensureCodespaceRunning,
  CODESPACE_MACHINE_TYPE,
  GITHUB_SANDBOX_REPO,
} = require('./codespaceExec');

function log(...args) {
  console.error('[resolve_codespace]', ...args);
}

async function main() {
  if (!GITHUB_SANDBOX_REPO) {
    throw new Error('GITHUB_SANDBOX_REPO is not set');
  }

  log(`Looking for an existing codespace on ${GITHUB_SANDBOX_REPO} …`);
  const existing = await listCodespacesForRepo();
  let name;
  if (existing.length > 0) {
    name = existing[0].name;
    log(`Found existing codespace: ${name} (state: ${existing[0].state})`);
  } else {
    log(`None found — creating one (machine: ${CODESPACE_MACHINE_TYPE}) …`);
    const cs = await createCodespace({ machine: CODESPACE_MACHINE_TYPE });
    name = cs.name;
    log(`Created codespace: ${name}`);
  }

  log(`Ensuring "${name}" is Available (this can take up to ~90s on first boot) …`);
  await ensureCodespaceRunning(name, { maxRetries: 24, retryDelayMs: 5000 });
  log(`"${name}" is Available.`);

  // ONLY this goes to stdout.
  process.stdout.write(name + '\n');
}

main().catch((err) => {
  log('FAILED:', err && err.message ? err.message : String(err));
  process.exit(1);
});
