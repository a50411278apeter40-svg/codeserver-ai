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
  listMachines,
  CODESPACE_MACHINE_TYPE,
  GITHUB_SANDBOX_REPO,
} = require('./codespaceExec');

function log(...args) {
  console.error('[resolve_codespace]', ...args);
}


/**
 * Picks a machine type the repo is actually allowed to use.
 * GitHub restricts available machine sizes per repo/org/plan — a hardcoded
 * preference (e.g. CODESPACE_MACHINE_TYPE=largePremiumLinux) can 400 with
 * "not allowed for this repository" on accounts without access to that
 * tier. Strategy: ask GitHub what's actually available for this repo, use
 * the preferred type if it's in that list, otherwise fall back to the
 * biggest one that IS available (by memory), so we still get the most
 * capable machine the account is entitled to instead of just failing.
 */
async function resolveMachineType() {
  try {
    const machines = await listMachines();
    if (!machines || machines.length === 0) {
      log('listMachines() returned no options — falling back to CODESPACE_MACHINE_TYPE as-is.');
      return CODESPACE_MACHINE_TYPE;
    }
    log(`Available machines for ${GITHUB_SANDBOX_REPO}: ${machines.map((m) => m.name).join(', ')}`);
    const preferred = machines.find((m) => m.name === CODESPACE_MACHINE_TYPE);
    if (preferred) return preferred.name;

    const biggest = machines
      .slice()
      .sort((a, b) => (b.memory_in_bytes || 0) - (a.memory_in_bytes || 0))[0];
    log(`Preferred "${CODESPACE_MACHINE_TYPE}" not available — using "${biggest.name}" instead (biggest available).`);
    return biggest.name;
  } catch (err) {
    log(`Could not list machines (${err.message}) — falling back to CODESPACE_MACHINE_TYPE as-is.`);
    return CODESPACE_MACHINE_TYPE;
  }
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
    const machine = await resolveMachineType();
    log(`None found — creating one (machine: ${machine}) …`);
    const cs = await createCodespace({ machine });
    name = cs.name;
    log(`Created codespace: ${name}`);
  }

  // First-time provisioning of a brand-new codespace (installing the
  // devcontainer's features — node, python, github-cli — into the
  // universal:2 base image), or resuming one that's still mid-provisioning
  // from a previous run, can genuinely take several minutes, not seconds.
  // Waking an already-Available/Shutdown codespace back up returns almost
  // immediately regardless, so a generous budget here costs nothing on the
  // fast path — only actually waits this long when provisioning really is
  // still in progress.
  const maxRetries = 90; // 90 * 5s = 450s (~7.5 min)
  log(`Ensuring "${name}" is Available (up to ~${maxRetries * 5}s budget) …`);
  await ensureCodespaceRunning(name, { maxRetries, retryDelayMs: 5000 });
  log(`"${name}" is Available.`);

  // ONLY this goes to stdout.
  process.stdout.write(name + '\n');
}

main().catch((err) => {
  log('FAILED:', err && err.message ? err.message : String(err));
  process.exit(1);
});
