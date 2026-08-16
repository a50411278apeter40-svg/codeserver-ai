# codeserver-ai

Self-hosted, browser-based **real VS Code** coding platform with an AI chat
assistant and GitHub Codespaces sandbox execution — deployed as a single
Docker web service on [Render](https://render.com).

Think "Claude Code, but web-based": you open a browser, get a full VS Code
editor (the actual upstream Microsoft VS Code, packaged by
[codercom/code-server](https://github.com/coder/code-server)), chat with a
Google Gemini (Gemma) model about your code, and let the AI spin up a live
GitHub Codespace to execute and test its suggestions.

---

## Architecture

```
                          ┌──────────────────────────────────────────────┐
                          │            Render web service (Docker)        │
                          │                                              │
  Browser  ────────────►  │  Node backend (Express)  :PORT (10000)       │
  (VS Code webview,       │  ├─ /api/chat      → Gemini API (SSE stream) │  ──►  Google Gemini
   chat panel)            │  ├─ /api/codespaces → GitHub Codespaces API  │  ──►  GitHub API
                          │  └─ /* (proxy)     → code-server :8080       │
                          │                         (real VS Code)      │
                          └──────────────────────────────────────────────┘
                                                │
                                                ▼
                         GitHub Codespace (sandbox) — code execution
                         created from GITHUB_SANDBOX_REPO template
```

**Components:**

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Editor | `codercom/code-server` (real VS Code) | In-browser IDE on internal port 8080 |
| Backend | Node.js 20 + Express | API gateway, AI proxy, Codespaces manager, reverse proxy |
| AI | Google Gemini API (Gemma model) | Streaming chat completions via SSE |
| Sandbox | GitHub Codespaces REST API | Create/start/stop/delete live dev sandboxes |
| Extension | `ai-chat` VS Code extension (.vsix) | Chat webview inside VS Code that calls the backend |
| Deploy | Render Blueprint (Docker) | Single web service, autoscaled |

---

## Setup

### 1. Get a Gemini API key

1. Visit [Google AI Studio](https://aistudio.google.com/apikey).
2. Create an API key.
3. Note the key — you'll set it as `GEMINI_API_KEY`.

### 2. Create a GitHub PAT

1. Go to [GitHub Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens).
2. Create a **classic** token with scopes:
   - `repo` (full control of private repos)
   - `codespace` (Codespaces read/write)
3. Note the token — you'll set it as `GITHUB_TOKEN`.

### 3. Create a template repo for Codespaces

1. Create a new GitHub repo (e.g. `youruser/sandbox-template`).
2. Add a `.devcontainer/devcontainer.json` (can be minimal).
3. This is your `GITHUB_SANDBOX_REPO` (`owner/repo`).

### 4. Set environment variables

In the Render dashboard (or in `.env` for local dev), set:

| Variable | Required | Example |
|----------|----------|---------|
| `GEMINI_API_KEY` | ✅ | `AIza...` |
| `GITHUB_TOKEN` | ✅ | `ghp_...` |
| `GITHUB_SANDBOX_REPO` | ✅ | `youruser/sandbox-template` |
| `GEMINI_MODEL` | optional | `gemma-3-27b-it` (default) |
| `CODESPACE_MACHINE_TYPE` | optional | `largePremiumLinux` (default) |

### 5. Deploy via Render Blueprint

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Blueprint**.
3. Select the repo; Render detects `render.yaml`.
4. Set the secret env vars (`GEMINI_API_KEY`, `GITHUB_TOKEN`, `GITHUB_SANDBOX_REPO`) in the dashboard.
5. Deploy. The service URL gives you VS Code in the browser + AI chat.

---

## How the AI chat + Codespaces sandbox work together

1. **Chat:** The `ai-chat` VS Code extension renders a webview chat panel. When
   the user sends a message, the extension POSTs to `/api/chat` on the backend.
   The backend builds a Gemini `generateContent` request (optionally weaving in
   the active file's content as context), calls the Gemini `streamGenerateContent`
   SSE endpoint, and re-streams simplified `data: {token}` SSE events back to the
   extension's webview.

2. **Sandbox execution:** The AI may suggest code that needs to be run and
   tested. The extension (or the backend directly) can call the Codespaces
   endpoints to create a live GitHub Codespace from the configured template
   repo (`GITHUB_SANDBOX_REPO`) on a high-spec machine
   (`CODESPACE_MACHINE_TYPE`, default `largePremiumLinux`). The Codespace runs
   the AI-suggested code as a real, isolated dev environment — not inside the
   Render container.

3. **Codespaces API endpoints** exposed by the backend:

   | Method | Path | Description |
   |--------|------|-------------|
   | `POST` | `/api/codespaces` | Create a codespace on the template repo |
   | `GET` | `/api/codespaces/machines` | List available machine types (pick the best) |
   | `GET` | `/api/codespaces` | List codespaces for the repo |
   | `POST` | `/api/codespaces/:id/start` | Start a stopped codespace |
   | `POST` | `/api/codespaces/:id/stop` | Stop a running codespace |
   | `DELETE` | `/api/codespaces/:id` | Delete a codespace |

4. **Reverse proxy:** All non-`/api` traffic is transparently proxied to
   `code-server` (the real VS Code instance) running inside the same container
   on port 8080. WebSocket upgrades are supported so the editor, terminal, and
   file sync all work in real time.

---

## Project layout

```
codeserver-ai/
├── Dockerfile              # Single-stage: code-server + Node 20 backend
├── render.yaml             # Render Blueprint spec
├── start.sh                # Launches code-server (bg) + Node backend (fg)
├── .env.example            # All env vars documented
├── README.md               # This file
├── backend/
│   ├── package.json
│   └── server.js           # Express: AI chat, Codespaces, reverse proxy
└── extensions/
    └── ai-chat/
        └── ai-chat-0.0.1.vsix  # VS Code extension (built separately)
```

---

## Local development

```bash
cd backend
npm install
# Set env vars (copy .env.example → .env)
node server.js
```

For a full local test with code-server, run the Docker build:

```bash
docker build -t codeserver-ai .
docker run -p 10000:10000 \
  -e GEMINI_API_KEY=... \
  -e GITHUB_TOKEN=... \
  -e GITHUB_SANDBOX_REPO=owner/repo \
  codeserver-ai
```

Then open `http://localhost:10000` in your browser.

---

## Notes

- The `ai-chat` extension `.vsix` is built by a separate task. The Dockerfile
  installs it at build time; a placeholder file is included so the build
  succeeds during early scaffolding.
- Gemini request/response shapes are implemented defensively per the
  documented `generateContent` format. Inline comments in `server.js` mark
  assumptions for easy adjustment.
- `CODESPACE_MACHINE_TYPE` defaults to `largePremiumLinux` (highest tier) but
  is fully overridable via env var. Use `GET /api/codespaces/machines` to see
  what's actually available for your repo/plan.
