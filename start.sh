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

# Give code-server a moment to bind before the backend starts proxying.
sleep 2

echo "[start.sh] code-server PID: ${CODE_SERVER_PID}"
echo "[start.sh] Starting Node backend on :${PORT:-10000} …"

# Run the backend in the foreground (main process).
# Forward signals so SIGTERM/SIGINT from Render reach the backend.
exec node backend/server.js
