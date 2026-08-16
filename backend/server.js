'use strict';

/**
 * codeserver-ai backend server
 * ------------------------------------------------------------------
 * Responsibilities:
 *   1. POST /api/chat          – stream Gemini AI chat (SSE) to the extension webview
 *   2. POST /api/codespaces     – create a GitHub Codespace on GITHUB_SANDBOX_REPO
 *      GET  /api/codespaces/machines – list available machine types
 *      GET  /api/codespaces          – list codespaces for the repo
 *      POST /api/codespaces/:id/start
 *      POST /api/codespaces/:id/stop
 *      DELETE /api/codespaces/:id
 *   3. GET  /api/health         – health check
 *   4. Catch-all reverse proxy  – forward everything else (incl. WebSockets) to
 *      code-server at 127.0.0.1:8080
 *
 * Node 20+ has a global `fetch`; no need for node-fetch.
 */

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000;
const CODE_SERVER_TARGET = process.env.CODE_SERVER_TARGET || 'http://127.0.0.1:8080';

// ---------------------------------------------------------------------------
// Config / env
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemma-4-31b-it';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_SANDBOX_REPO = process.env.GITHUB_SANDBOX_REPO || ''; // "owner/repo"
const CODESPACE_MACHINE_TYPE = process.env.CODESPACE_MACHINE_TYPE || 'largePremiumLinux';

const GITHUB_API = 'https://api.github.com';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '2mb' }));

// Simple request logging
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-Github-Api-Version': '2022-11-28',
  };
}

/**
 * Build the Gemini generateContent request body.
 *
 * ASSUMPTION (adjust if the model API differs):
 * The documented Gemini generateContent shape is:
 *   { contents: [{ role: "user"|"model", parts: [{ text: "..." }] }] }
 * We optionally prepend the active file content as an extra "user" turn that
 * acts as context. Gemini doesn't have a dedicated system message in the
 * basic generateContent call for Gemma models, so we fold context into the
 * first user part.
 */
function buildGeminiBody(messages, context) {
  // messages: [{ role: 'user'|'assistant', content: '...' }, ...]
  // Map "assistant" -> "model" for Gemini.
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content || '' }],
  }));

  // Weave in active-file context if provided.
  if (context && context.activeFile) {
    const ctxText =
      `You are an AI pair-programmer inside a VS Code web environment.\n` +
      `The user currently has this file open:\n` +
      `--- ${context.activeFile.name || 'active file'} ---\n` +
      `${context.activeFile.content || ''}\n` +
      `--- end file ---\n` +
      `Use this context when answering.\n`;

    // Prepend as a model instruction carried in the first user message.
    if (contents.length > 0 && contents[0].role === 'user') {
      contents[0].parts[0].text = ctxText + contents[0].parts[0].text;
    } else {
      contents.unshift({ role: 'user', parts: [{ text: ctxText }] });
    }
  }

  return {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
    },
  };
}

// ---------------------------------------------------------------------------
// Routes: health
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    gemini_model: GEMINI_MODEL,
    gemini_configured: !!GEMINI_API_KEY,
    github_configured: !!GITHUB_TOKEN,
    sandbox_repo: GITHUB_SANDBOX_REPO,
    machine_type: CODESPACE_MACHINE_TYPE,
    code_server_target: CODE_SERVER_TARGET,
  });
});

// ---------------------------------------------------------------------------
// Routes: AI chat (Gemini streaming)
// ---------------------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  const { messages, context } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured' });
  }

  // SSE headers for the extension webview.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (Render nginx)
  res.flushHeaders();

  const geminiBody = buildGeminiBody(messages, context);
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

  const abortController = new AbortController();
  let streamFinished = false;
  // Only abort the upstream Gemini request if the CLIENT disconnects early.
  // (Using req.on('close') is wrong here: the incoming request stream closes
  // as soon as its small JSON body has been fully read, which happens almost
  // immediately — long before our response is done. res.on('close') fires
  // when the underlying connection actually goes away.)
  res.on('close', () => {
    if (!streamFinished) abortController.abort();
  });

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
      signal: abortController.signal,
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.write(`data: ${JSON.stringify({ error: 'Gemini API error', status: upstream.status, detail: errText })}\n\n`);
      return res.end();
    }

    if (!upstream.body) {
      res.write(`data: ${JSON.stringify({ error: 'No response body from Gemini' })}\n\n`);
      return res.end();
    }

    /**
     * Parse Gemini's SSE stream.
     * Gemini (alt=sse) sends lines like:
     *   data: {"candidates":[{"content":{"parts":[{"text":"hello"}],"role":"model"}}],...}
     *
     * We re-emit simplified `data: {token}\n\n` where token is the text delta.
     * ASSUMPTION: each SSE data event is a complete JSON object; if a data
     * line spans multiple raw chunks we buffer until newline.
     */
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);

        if (!line) continue;
        if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim();
          if (dataStr === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          try {
            const parsed = JSON.parse(dataStr);
            // Extract text delta from candidates[0].content.parts[*].text
            const candidates = parsed.candidates || [];
            for (const cand of candidates) {
              const parts = (cand.content && cand.content.parts) || [];
              for (const part of parts) {
                // Skip internal "thinking" parts (Gemma 4 thinking mode) — only
                // stream the real answer text to the chat UI.
                if (part.text && !part.thought) {
                  res.write(`data: ${JSON.stringify(part.text)}\n\n`);
                }
              }
            }
            // (usageMetadata / promptFeedback intentionally not relayed — the
            // webview only cares about actual answer text and errors.)
          } catch (e) {
            // Non-JSON data line — skip but don't crash the stream.
            console.warn('Could not parse SSE data line:', dataStr.slice(0, 120));
          }
        }
      }
    }

    // Signal stream completion to the client.
    streamFinished = true;
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    streamFinished = true;
    console.error('Chat streaming error:', err);
    // If headers already sent we can only write SSE.
    try {
      res.write(`data: ${JSON.stringify({ error: 'Streaming failed', detail: err.message })}\n\n`);
    } catch (_) {
      // ignore
    }
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Routes: GitHub Codespaces management
// ---------------------------------------------------------------------------

// List available machine types for the configured repo
app.get('/api/codespaces/machines', async (_req, res) => {
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN is not configured' });
  if (!GITHUB_SANDBOX_REPO) return res.status(500).json({ error: 'GITHUB_SANDBOX_REPO is not configured' });

  const url = `${GITHUB_API}/repos/${GITHUB_SANDBOX_REPO}/codespaces/machines`;
  try {
    const r = await fetch(url, { headers: githubHeaders() });
    const body = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: 'GitHub API error', detail: safeJson(body) });
    const machines = JSON.parse(body);
    res.json({
      configured_machine_type: CODESPACE_MACHINE_TYPE,
      machines: machines.machines || machines,
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach GitHub API', detail: err.message });
  }
});

// List codespaces for the configured repo
app.get('/api/codespaces', async (_req, res) => {
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN is not configured' });
  if (!GITHUB_SANDBOX_REPO) return res.status(500).json({ error: 'GITHUB_SANDBOX_REPO is not configured' });

  const url = `${GITHUB_API}/repos/${GITHUB_SANDBOX_REPO}/codespaces`;
  try {
    const r = await fetch(url, { headers: githubHeaders() });
    const body = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: 'GitHub API error', detail: safeJson(body) });
    res.json(JSON.parse(body));
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach GitHub API', detail: err.message });
  }
});

// Create a codespace on the configured repo
app.post('/api/codespaces', async (req, res) => {
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN is not configured' });
  if (!GITHUB_SANDBOX_REPO) return res.status(500).json({ error: 'GITHUB_SANDBOX_REPO is not configured' });

  const url = `${GITHUB_API}/repos/${GITHUB_SANDBOX_REPO}/codespaces`;
  const payload = {
    machine: req.body.machine || CODESPACE_MACHINE_TYPE,
    // Optionally allow a branch / devcontainer path override
    ...(req.body.branch ? { ref: req.body.branch } : {}),
    ...(req.body.display_name ? { display_name: req.body.display_name } : {}),
  };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: 'GitHub API error', detail: safeJson(body) });
    res.status(201).json(JSON.parse(body));
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach GitHub API', detail: err.message });
  }
});

// Start a codespace
app.post('/api/codespaces/:id/start', async (req, res) => {
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN is not configured' });
  const url = `${GITHUB_API}/user/codespaces/${encodeURIComponent(req.params.id)}/start`;
  try {
    const r = await fetch(url, { method: 'POST', headers: githubHeaders() });
    const body = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: 'GitHub API error', detail: safeJson(body) });
    res.json(JSON.parse(body));
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach GitHub API', detail: err.message });
  }
});

// Stop a codespace
app.post('/api/codespaces/:id/stop', async (req, res) => {
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN is not configured' });
  const url = `${GITHUB_API}/user/codespaces/${encodeURIComponent(req.params.id)}/stop`;
  try {
    const r = await fetch(url, { method: 'POST', headers: githubHeaders() });
    const body = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: 'GitHub API error', detail: safeJson(body) });
    res.json(JSON.parse(body));
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach GitHub API', detail: err.message });
  }
});

// Delete a codespace
app.delete('/api/codespaces/:id', async (req, res) => {
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN is not configured' });
  const url = `${GITHUB_API}/user/codespaces/${encodeURIComponent(req.params.id)}`;
  try {
    const r = await fetch(url, { method: 'DELETE', headers: githubHeaders() });
    if (r.status === 202 || r.status === 204) return res.status(204).end();
    const body = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: 'GitHub API error', detail: safeJson(body) });
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach GitHub API', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function safeJson(str) {
  try { return JSON.parse(str); } catch (_) { return str; }
}

// ---------------------------------------------------------------------------
// Catch-all reverse proxy -> code-server (127.0.0.1:8080)
// ---------------------------------------------------------------------------
const codeServerProxy = createProxyMiddleware({
  target: CODE_SERVER_TARGET,
  changeOrigin: true,
  ws: true, // WebSocket support — critical for code-server terminal/editor sync
  logLevel: 'warn',
  onError: (err, req, res) => {
    console.error('Proxy error:', err.message);
    if (res && !res.headersSent && typeof res.status === 'function') {
      res.status(502).json({ error: 'code-server proxy error', detail: err.message });
    }
  },
});

// Attach proxy for all non-API paths.
// (API routes above are registered first, so they take precedence.)
app.use('/', codeServerProxy);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`codeserver-ai backend listening on :${PORT}`);
  console.log(`  Proxying non-API requests to ${CODE_SERVER_TARGET}`);
  console.log(`  Gemini model: ${GEMINI_MODEL} (key ${GEMINI_API_KEY ? 'set' : 'MISSING'})`);
  console.log(`  GitHub sandbox repo: ${GITHUB_SANDBOX_REPO || '(not set)'}  machine: ${CODESPACE_MACHINE_TYPE}`);
});

// Explicitly attach the proxy's upgrade handler so WebSocket upgrades reach code-server.
// createProxyMiddleware with ws:true listens to the 'upgrade' event on the
// server automatically, but we also wire it manually as a safety net.
server.on('upgrade', (req, socket, head) => {
  if (codeServerProxy.upgrade) {
    codeServerProxy.upgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});
