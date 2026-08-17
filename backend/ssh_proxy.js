'use strict';

/**
 * ssh_proxy.js — ProxyCommand wrapper for the integrated terminal's SSH.
 * ------------------------------------------------------------------
 * PROBLEM this fixes: GitHub Codespaces auto-stop after `idle_timeout_minutes`
 * of inactivity (30min for this repo). start.sh's resolve_codespace.js only
 * ensures the codespace is Available ONCE, at container boot. Every terminal
 * opened AFTER that point (a new tab, a reconnect after the browser tab was
 * idle, a fresh session on a later day) connected via a raw
 * `gh cs ssh -c <name> --stdio -- ...` ProxyCommand with no "is it actually
 * running right now?" check — if the codespace had auto-stopped since boot,
 * that ssh attempt just failed outright (exit 255), because gh's own
 * auto-resume-on-connect either isn't fast/reliable enough for OpenSSH's
 * ProxyCommand timeout, or doesn't fire in this path at all.
 *
 * FIX: this script IS the ProxyCommand now. It calls ensureCodespaceRunning()
 * (the same helper start.sh uses at boot, with a generous retry budget) to
 * wake the codespace up and wait for it to be Available BEFORE ever invoking
 * `gh cs ssh --stdio`, on every single connection attempt — new terminal,
 * reconnect, doesn't matter. Costs ~1 fast state-check API call when the
 * codespace is already running (the common case); only actually waits when
 * it truly was stopped.
 *
 * Usage (from ssh's ProxyCommand): node ssh_proxy.js <codespace-name>
 * stdin/stdout are the raw SSH stream (inherited straight through to `gh`,
 * untouched) — all diagnostic output goes to stderr / a log file so it
 * never corrupts the SSH protocol stream.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const { ensureCodespaceRunning } = require('./codespaceExec');

const CS_NAME = process.argv[2];
const LOG_PATH = '/tmp/ssh_proxy.log';

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (_) {
    /* best-effort logging only */
  }
}

async function main() {
  if (!CS_NAME) {
    log('FATAL: no codespace name passed as argv[2]');
    process.exit(1);
  }

  try {
    log(`Checking "${CS_NAME}" is Available before proxying SSH …`);
    // Up to ~3.5 min budget: instant when already Available (the common
    // case), enough runway to cover a full auto-resume from Shutdown when
    // the idle timeout kicked in since the last connection.
    await ensureCodespaceRunning(CS_NAME, { maxRetries: 70, retryDelayMs: 3000 });
    log(`"${CS_NAME}" is Available — proxying stdio via gh cs ssh.`);
  } catch (err) {
    // Don't hard-fail here — still attempt the raw ssh in case our own
    // state check was wrong or transiently flaky; gh may still succeed.
    log(`ensureCodespaceRunning() did not confirm Available (${err && err.message}) — attempting gh cs ssh anyway.`);
  }

  const logFd = fs.openSync(LOG_PATH, 'a');
  const child = spawn(
    'gh',
    ['cs', 'ssh', '-c', CS_NAME, '--stdio', '--', '-i', '/root/.ssh/codespaces.auto'],
    { stdio: ['inherit', 'inherit', logFd] },
  );

  child.on('error', (err) => {
    log(`spawn error: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    log(`gh cs ssh exited (code=${code}, signal=${signal})`);
    process.exit(code === null ? 1 : code);
  });
}

main();
