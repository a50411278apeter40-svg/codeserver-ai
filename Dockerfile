# =============================================================================
# codeserver-ai Dockerfile
# Single-stage build on top of codercom/code-server (real VS Code in browser)
# Adds: Node.js 20 backend (Express), preinstalled AI-chat extension,
#       GitHub CLI (gh) for codespace exec bridge.
# =============================================================================

FROM codercom/code-server:latest

USER root

# ---------------------------------------------------------------------------
# Install Node.js 20.x (code-server base image is Debian-based)
# Using NodeSource setup script for an official Node 20 deb repo.
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && node --version && npm --version \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Install GitHub CLI (gh)
# Needed by the backend's codespace exec bridge (codespaceExec.js) to run
# shell commands inside live GitHub Codespaces via `gh codespace ssh`.
# Auth: gh reads the GH_TOKEN env var automatically — no `gh auth login`
# interactive flow needed. GH_TOKEN is set at runtime from GITHUB_TOKEN
# (see codespaceExec.js which sets GH_TOKEN from process.env.GITHUB_TOKEN).
# Official install docs: https://github.com/cli/cli/blob/trunk/docs/install_linux.md
# ---------------------------------------------------------------------------
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && gh --version \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Create a workspace folder for code-server to open
# ---------------------------------------------------------------------------
RUN mkdir -p /home/coder/project && chown -R coder:coder /home/coder

# ---------------------------------------------------------------------------
# Install backend
# ---------------------------------------------------------------------------
WORKDIR /app/backend
COPY backend/package.json ./
COPY backend/package-lock.json* ./
RUN npm install --omit=dev

COPY backend/ ./

# ---------------------------------------------------------------------------
# Preinstall the AI-chat VS Code extension (.vsix)
# Guard with `|| true` so the build still succeeds when the vsix is a
# placeholder empty file during early scaffolding.
# ---------------------------------------------------------------------------
COPY extensions/ai-chat/ai-chat-0.0.1.vsix /tmp/ai-chat-0.0.1.vsix
RUN code-server --install-extension /tmp/ai-chat-0.0.1.vsix || true

# ---------------------------------------------------------------------------
# Startup script
# ---------------------------------------------------------------------------
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# ---------------------------------------------------------------------------
# Environment placeholders (set real values in Render dashboard or render.yaml)
# ---------------------------------------------------------------------------
# GOOGLE_API_KEY (or GEMINI_API_KEY) must be set as a secret in the Render dashboard.
# ENV GOOGLE_API_KEY=
ENV GEMINI_MODEL=gemma-4-31b-it
# ENV GITHUB_TOKEN=
# GITHUB_TOKEN is used both for GitHub REST API calls AND for gh CLI auth.
# codespaceExec.js sets GH_TOKEN from GITHUB_TOKEN at runtime.
# ENV GITHUB_SANDBOX_REPO=owner/repo
ENV CODESPACE_MACHINE_TYPE=largePremiumLinux

# The Node backend listens on PORT (Render injects PORT). Render maps its
# external traffic to this port. code-server runs internally on 8080 and is
# only reachable via the backend's reverse proxy.
ENV PORT=10000

EXPOSE 10000

WORKDIR /app

# ---------------------------------------------------------------------------
# IMPORTANT FIX
# The codercom/code-server base image bakes its own ENTRYPOINT:
#   ENTRYPOINT ["/usr/bin/entrypoint.sh", "--bind-addr", "0.0.0.0:8080", "."]
# When only CMD is set (as this file used to do), Docker keeps the base
# image's ENTRYPOINT and appends our CMD as EXTRA positional args to it —
# which that entrypoint then forwards straight into `code-server` itself.
# So "/app/start.sh" was never executed as a script; it was passed to
# code-server as a stray workspace-path argument, and code-server started
# with ITS OWN default config (password auth) — exactly the "Welcome to
# code-server / check the config file for the password" screen users saw.
# Overriding ENTRYPOINT here fully replaces the base image's entrypoint so
# our start.sh (which launches code-server with --auth none + our backend)
# actually runs as the container's real startup command.
# ---------------------------------------------------------------------------
ENTRYPOINT ["/app/start.sh"]
