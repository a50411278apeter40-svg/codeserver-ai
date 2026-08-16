#!/usr/bin/env bash
set -e

# =============================================================================
# codeserver-ai startup script
#
# IMPORTANT ORDERING: the Node backend must bind to $PORT and respond on
# /api/health as fast as possible, no matter what code-server is doing —
# Render's health check hits the backend's port, and if nothing binds there
# quickly, Render marks the whole deploy "unhealthy" / 502s forever, even if
# code-server itself would have come up fine a bit later. So:
#   1. Launch code-server in the background (it can take a while to boot).
#   2. Start the Node backend RIGHT AWAY in the foreground (main process) —
#      it passes Render's health check immediately.
#   3. Until code-server finishes booting, the backend's reverse-proxy error
#      handler (in server.js) shows a friendly "still starting…" page instead
#      of failing outright — so the editor UI just needs a refresh once
#      code-server catches up, without ever blocking startup.
# =============================================================================

# Raise the file-descriptor limit. VS Code's file watcher (fs.watch) opens
# one watch handle per directory it tracks, and the default container limit
# (often 1024 or lower on Render) gets exhausted fast, which is why the logs
# were full of "EMFILE: too many open files" warnings. Best-effort — some
# sandboxes cap how high this can go, hence `|| true`.
ulimit -n 65536 2>/dev/null || ulimit -n 8192 2>/dev/null || true
echo "[start.sh] File descriptor limit: $(ulimit -n)"

echo "[start.sh] Launching code-server on 0.0.0.0:8080 (background) …"

# IMPORTANT: code-server auto-detects the platform's $PORT env var (Render
# injects PORT=10000) and binds to THAT instead of our explicit --bind-addr
# flag, completely ignoring --bind-addr. That caused code-server to grab
# port 10000 for itself, so the Node backend then crashed on startup with
# EADDRINUSE (both trying to bind :10000), crash-looping the whole container.
# Fix: unset PORT only inside the subshell that launches code-server, so it
# can't see it and falls back to --bind-addr 0.0.0.0:8080. The outer shell
# (and the `exec node backend/server.js` below) keeps PORT intact for the
# Node backend, which is the process that should own $PORT.
(
  unset PORT
  exec code-server \
    --bind-addr 0.0.0.0:8080 \
    --auth none \
    --disable-workspace-trust \
    /home/coder/project
) > /tmp/code-server.log 2>&1 &

CODE_SERVER_PID=$!
echo "[start.sh] code-server PID: ${CODE_SERVER_PID} (logs: /tmp/code-server.log)"

# Small watcher, purely informational — logs when code-server becomes
# reachable (or if it dies), but never blocks the backend from starting.
(
  for i in $(seq 1 120); do
    if curl -fsS -o /dev/null "http://127.0.0.1:8080/" 2>/dev/null; then
      echo "[start.sh] code-server became reachable after ~${i}s."
      exit 0
    fi
    if ! kill -0 "${CODE_SERVER_PID}" 2>/dev/null; then
      echo "[start.sh] code-server process exited early — check /tmp/code-server.log"
      exit 1
    fi
    sleep 1
  done
  echo "[start.sh] code-server still not reachable after 120s — check /tmp/code-server.log"
) &

echo "[start.sh] Starting Node backend on :${PORT:-10000} (foreground/main process) …"

# Run the backend in the foreground (main process, PID 1's child via exec).
# Forward signals so SIGTERM/SIGINT from Render reach the backend.
exec node backend/server.js
