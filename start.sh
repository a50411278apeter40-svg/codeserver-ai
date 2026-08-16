#!/usr/bin/env bash
set -e

# =============================================================================
# codeserver-ai startup script
# Launches code-server (real VS Code) in the background on :8080, then runs
# the Node backend in the foreground. The backend proxies non-API traffic to
# code-server and is the container's main process.
# =============================================================================

echo "[start.sh] Launching code-server on 0.0.0.0:8080 …"

# code-server runs with --auth none so the Node backend is the single entry point.
# The backend proxies all browser traffic to this internal instance.
code-server \
  --bind-addr 0.0.0.0:8080 \
  --auth none \
  /home/coder/project &

CODE_SERVER_PID=$!
echo "[start.sh] code-server PID: ${CODE_SERVER_PID}"

# Wait for code-server to actually be reachable before starting the backend
# proxy in front of it, instead of guessing a fixed sleep. code-server can
# take anywhere from a couple seconds to (rarely) 30+s to bind on a cold
# start / first boot (extension install, config init, etc.).
echo "[start.sh] Waiting for code-server to become reachable on :8080 …"
READY=0
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:8080/healthz" 2>/dev/null      || curl -fsS -o /dev/null "http://127.0.0.1:8080/" 2>/dev/null; then
    READY=1
    echo "[start.sh] code-server is up (after ${i}s)."
    break
  fi
  # Bail out early (with a clear log) if code-server's process already died.
  if ! kill -0 "${CODE_SERVER_PID}" 2>/dev/null; then
    echo "[start.sh] ERROR: code-server process exited before becoming ready. Check logs above."
    break
  fi
  sleep 1
done
if [ "${READY}" -ne 1 ]; then
  echo "[start.sh] WARNING: code-server did not respond within 60s — starting the backend anyway; it will show a 502 from the proxy until code-server catches up. Check the logs above for a code-server crash."
fi

echo "[start.sh] Starting Node backend on :${PORT:-10000} …"

# Run the backend in the foreground (main process).
# Forward signals so SIGTERM/SIGINT from Render reach the backend.
exec node backend/server.js
