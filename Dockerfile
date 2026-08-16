# =============================================================================
# codeserver-ai Dockerfile
# Single-stage build on top of codercom/code-server (real VS Code in browser)
# Adds: Node.js 20 backend (Express), preinstalled AI-chat extension.
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
# ENV GITHUB_SANDBOX_REPO=owner/repo
ENV CODESPACE_MACHINE_TYPE=largePremiumLinux

# The Node backend listens on PORT (Render injects PORT). Render maps its
# external traffic to this port. code-server runs internally on 8080 and is
# only reachable via the backend's reverse proxy.
ENV PORT=10000

EXPOSE 10000

WORKDIR /app

CMD ["/app/start.sh"]
