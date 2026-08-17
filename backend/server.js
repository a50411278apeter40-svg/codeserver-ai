'use strict';

/**
 * codeserver-ai backend server
 * ------------------------------------------------------------------
 * Responsibilities:
 *   1. POST /api/chat          – stream Gemini AI chat (SSE) to the extension webview
 *      Now implements a ReAct-style tool-using agent loop: the AI can call tools
 *      (list_files, read_file, write_file, run_command, git, etc.) that execute
 *      INSIDE the live GitHub Codespace. Tool calls and results are streamed as
 *      SSE events; the final text answer is streamed as before.
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
const httpProxy = require('http-proxy');
const https = require('https');
const zlib = require('zlib');
const compression = require('compression');

// Tool-using agent: declarations + dispatcher (exec via codespace bridge)
const { toolDeclarations, dispatchTool } = require('./tools');

const app = express();
const PORT = process.env.PORT || 10000;
const CODE_SERVER_TARGET = process.env.CODE_SERVER_TARGET || 'http://127.0.0.1:8080';

// Tracks the keepalive self-ping loop's status for /api/health visibility.
const keepaliveState = { lastPingAt: null, lastStatus: null, count: 0 };

// ---------------------------------------------------------------------------
// Config / env
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemma-4-31b-it';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_ACCESS_TOKEN || '';
const GITHUB_SANDBOX_REPO = process.env.GITHUB_SANDBOX_REPO || ''; // "owner/repo"
const CODESPACE_MACHINE_TYPE = process.env.CODESPACE_MACHINE_TYPE || 'largePremiumLinux';

const GITHUB_API = 'https://api.github.com';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

// ReAct loop config
const MAX_TOOL_CALLS = parseInt(process.env.MAX_TOOL_CALLS || '8', 10);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Gzip compression (both directions), to cut bandwidth on Render's metered
// network and stay well under request/bandwidth limits.
//
// OUTGOING (server -> client): `compression` gzips any response whose
// Content-Type is compressible AND whose request sent `Accept-Encoding: gzip`
// (virtually all browsers). This also transparently compresses the reverse-
// proxied code-server HTTP traffic (its JS/CSS/HTML bundles) below, because
// http-proxy's `.web()` pipes the upstream response through this same `res`
// object — the compression middleware has already monkey-patched
// res.write/res.end by the time that happens, so it gzips those bytes too.
//
// EXCLUDED: /api/chat (SSE stream) — gzip needs to buffer bytes to build its
// compression window, which would add latency / break the token-by-token
// streaming feel of the AI chat. Also excluded: anything already compressed
// (images, fonts, etc — `compression`'s default filter already skips these
// via its content-type based `compressible` check) and WebSocket upgrades
// (upgrades never go through Express's HTTP response pipeline at all, so
// this middleware doesn't apply to them — WS compression is negotiated
// separately below via permessage-deflate passthrough).
app.use(
  compression({
    filter: (req, res) => {
      if (req.path === '/api/chat') return false;
      return compression.filter(req, res);
    },
  })
);

// INCOMING (client -> server): transparently gunzip request bodies that
// arrive with `Content-Encoding: gzip` or `deflate`, BEFORE express.json()
// parses them. Most clients don't compress small JSON request bodies, but
// this makes it work if the extension webview (or anything else) starts
// sending compressed request bodies to save upload bandwidth.
app.use((req, res, next) => {
  const enc = (req.headers['content-encoding'] || '').toLowerCase();
  if (enc !== 'gzip' && enc !== 'deflate') return next();

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const compressed = Buffer.concat(chunks);
    const decompress = enc === 'gzip' ? zlib.gunzip : zlib.inflate;
    decompress(compressed, (err, decoded) => {
      if (err) {
        console.error('Failed to decompress request body:', err.message);
        return res.status(400).json({ error: 'Invalid ' + enc + ' request body' });
      }
      // Replace the stream with the decoded body so express.json() (which
      // reads req the normal streaming way) sees plain bytes. Simplest way:
      // stash it and let a tiny custom parser below read it directly.
      req._decodedBody = decoded;
      delete req.headers['content-encoding'];
      req.headers['content-length'] = String(decoded.length);
      next();
    });
  });
});

// If we already decoded a gzip/deflate body above, feed it to express.json's
// underlying parser via a fake readable instead of re-reading req (which has
// already fully drained). Otherwise fall through to the normal body parser.
app.use((req, res, next) => {
  if (!req._decodedBody) return next();
  const { Readable } = require('stream');
  const fakeReq = Readable.from([req._decodedBody]);
  fakeReq.headers = req.headers;
  fakeReq.method = req.method;
  fakeReq.url = req.url;
  express.json({ limit: '2mb' })(fakeReq, res, (err) => {
    if (err) return next(err);
    req.body = fakeReq.body;
    next();
  });
});

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
 *
 * @param {Array} messages - [{ role: 'user'|'assistant', content: '...' }, ...]
 * @param {object} context - optional { activeFile: { name, content } }
 * @param {boolean} includeTools - if true, add tools (functionDeclarations) to body
 * @returns {object} Gemini request body
 */
function buildGeminiBody(messages, context, includeTools) {
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

  const body = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
    },
  };

  // Add tool declarations for the ReAct loop when requested.
  if (includeTools && toolDeclarations.length > 0) {
    body.tools = [{ functionDeclarations: toolDeclarations }];
    // AUTO mode: model decides whether to call a tool or respond with text.
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  return body;
}

// ---------------------------------------------------------------------------
// Routes: health
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    build: process.env.RENDER_GIT_COMMIT || 'unknown',
    gemini_model: GEMINI_MODEL,
    gemini_configured: !!GEMINI_API_KEY,
    github_configured: !!GITHUB_TOKEN,
    sandbox_repo: GITHUB_SANDBOX_REPO,
    machine_type: CODESPACE_MACHINE_TYPE,
    code_server_target: CODE_SERVER_TARGET,
    tool_count: toolDeclarations.length,
    max_tool_calls: MAX_TOOL_CALLS,
    keepalive: keepaliveState,
  });
});

// ---------------------------------------------------------------------------
// Routes: AI chat (Gemini streaming + ReAct tool loop)
// ---------------------------------------------------------------------------
/**
 * ReAct loop flow:
 * 1. Build the initial Gemini request with tool declarations.
 * 2. Call :generateContent (non-streaming) — simpler for parsing function calls.
 * 3. Inspect candidates[0].content.parts for functionCall parts (skip thought:true).
 * 4. If functionCall parts found:
 *    a. Emit SSE {"tool_call": {name, args}} for each.
 *    b. Call dispatchTool for each tool.
 *    c. Emit SSE {"tool_result": {name, result}} for each.
 *    d. Append the model's functionCall turn + a user functionResponse turn to contents.
 *    e. Loop back to step 2 (cap at MAX_TOOL_CALLS).
 * 5. If no functionCall (text only): chunk the text and stream it as SSE
 *    data: "..." events (same format as before), then emit [DONE].
 *
 * DESIGN CHOICE: Using :generateContent (non-streaming) for ALL turns including
 * the final text answer. This is simpler and more robust than mixing streaming
 * and non-streaming endpoints. The final text is chunked into small pieces and
 * emitted as SSE events to simulate streaming. (Gemini's generateContent returns
 * the full response at once, so true token-by-token streaming isn't available
 * with this endpoint — but the latency is typically acceptable and the simpler
 * code is worth the tradeoff. The original pure-streaming path is kept as a
 * fallback for when tools are not requested.)
 */

app.post('/api/chat', async (req, res) => {
  const { messages, context, tools: clientWantsTools } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured' });
  }

  // Determine whether to enable the tool-using ReAct loop.
  // Default: enabled. Client can explicitly disable with tools: false.
  const useTools = clientWantsTools !== false;

  // SSE headers for the extension webview.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (Render nginx)
  res.flushHeaders();

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

  // ---- Helper: write SSE data event ----
  function sseWrite(obj) {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (_) { /* connection might be closed */ }
  }

  // ---- Helper: write SSE text chunk (same format as original: data: "..." ----
  function sseWriteText(text) {
    try {
      res.write(`data: ${JSON.stringify(text)}\n\n`);
    } catch (_) { /* connection might be closed */ }
  }

  try {
    // =====================================================================
    // PATH 1: Original simple streaming (no tools) — backward compatible
    // =====================================================================
    if (!useTools) {
      await streamSimpleChat(req, res, messages, context, abortController);
      streamFinished = true;
      return;
    }

    // =====================================================================
    // PATH 2: ReAct tool-using loop
    // =====================================================================

    // Build the initial body with tool declarations.
    const geminiBody = buildGeminiBody(messages, context, true);

    // The running contents array — we append function calls + responses as we go.
    // buildGeminiBody already created contents from messages + context.
    let contents = geminiBody.contents;

    // Per-session state for tool dispatch (caches codespace name).
    const sessionState = {};

    // The generateContent endpoint (non-streaming) for the tool loop.
    const generateUrl = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`;

    let toolCallCount = 0;

    // ---- ReAct loop ----
    for (let iteration = 0; iteration < MAX_TOOL_CALLS + 1; iteration++) {
      // Build the request body for this turn.
      const requestBody = {
        contents,
        generationConfig: geminiBody.generationConfig,
        tools: geminiBody.tools,
        toolConfig: geminiBody.toolConfig,
      };

      const upstream = await fetch(generateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: abortController.signal,
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        sseWrite({ error: 'Gemini API error', status: upstream.status, detail: errText });
        streamFinished = true;
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const responseJson = await upstream.json();

      // Extract the first candidate's parts.
      const candidates = responseJson.candidates || [];
      if (candidates.length === 0) {
        sseWrite({ error: 'Gemini returned no candidates' });
        streamFinished = true;
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const candidate = candidates[0];
      const parts = (candidate.content && candidate.content.parts) || [];

      // Separate functionCall parts from text parts (skip thought:true parts).
      const functionCalls = [];
      const textParts = [];
      for (const part of parts) {
        // Skip internal "thinking" parts (Gemma 4 thinking mode).
        if (part.thought) continue;

        if (part.functionCall) {
          functionCalls.push(part.functionCall);
        } else if (part.text) {
          textParts.push(part.text);
        }
      }

      // ---- Case A: No function calls → final text answer ----
      if (functionCalls.length === 0) {
        // Stream the final text in chunks (same format as original: data: "...")
        for (const text of textParts) {
          // Chunk into ~80 char pieces for a streaming feel.
          for (let i = 0; i < text.length; i += 80) {
            sseWriteText(text.slice(i, i + 80));
          }
        }
        streamFinished = true;
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // ---- Case B: Function calls present → execute tools, loop ----

      // Append the model's functionCall turn to contents (as-is, with functionCall parts).
      // We need to preserve the exact parts (including thought:true parts for context,
      // but we only keep functionCall + non-thought text parts for cleanliness).
      // Actually, Gemini requires the model turn to match what it returned.
      // We'll include all non-thought parts from the response.
      const modelParts = parts.filter((p) => !p.thought);
      contents.push({
        role: 'model',
        parts: modelParts,
      });

      // Process each function call, build the functionResponse turn.
      const responseParts = [];
      for (const fc of functionCalls) {
        toolCallCount++;

        // Check loop cap
        if (toolCallCount > MAX_TOOL_CALLS) {
          sseWrite({
            error: 'Max tool calls reached',
            max: MAX_TOOL_CALLS,
            message: `The agent loop reached the maximum of ${MAX_TOOL_CALLS} tool calls. Stopping to avoid runaway loops.`,
          });
          streamFinished = true;
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        const toolName = fc.name;
        const toolArgs = fc.args || {};
        const callId = fc.id; // Gemini includes an id field (e.g. "call_597169")

        // Emit tool_call SSE event so the UI can show progress.
        sseWrite({ tool_call: { name: toolName, args: toolArgs } });

        // Execute the tool.
        const result = await dispatchTool(toolName, toolArgs, sessionState);

        // Emit tool_result SSE event (truncate huge results for the UI).
        const resultStr = JSON.stringify(result);
        const truncatedResult = resultStr.length > 10000
          ? { ...result, _truncated: true, _note: 'result truncated for UI display' }
          : result;
        sseWrite({ tool_result: { name: toolName, result: truncatedResult } });

        // Build the functionResponse part for Gemini.
        // The id field must match the functionCall's id.
        const fr = {
          name: toolName,
          response: { result },
        };
        if (callId) fr.id = callId;
        responseParts.push({ functionResponse: fr });
      }

      // Append the user turn with all functionResponses.
      contents.push({
        role: 'user',
        parts: responseParts,
      });

      // Loop back to the next generateContent call.
    }

    // ---- Loop cap hit (fell through the for loop) ----
    sseWrite({
      error: 'Max tool calls reached',
      max: MAX_TOOL_CALLS,
      message: `The agent loop reached the maximum of ${MAX_TOOL_CALLS} tool calls without producing a final text answer.`,
    });
    streamFinished = true;
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    streamFinished = true;
    console.error('Chat ReAct loop error:', err);
    try {
      sseWrite({ error: 'Streaming failed', detail: err.message });
    } catch (_) { /* ignore */ }
    res.end();
  }
});

/**
 * Original simple streaming chat (no tools) — backward compatible.
 * Streams from Gemini's :streamGenerateContent SSE endpoint and re-emits
 * text chunks as data: "..." events.
 */
async function streamSimpleChat(_req, res, messages, context, abortController, _streamFinished) {
  const geminiBody = buildGeminiBody(messages, context, false);
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

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
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Chat streaming error:', err);
    // If headers already sent we can only write SSE.
    try {
      res.write(`data: ${JSON.stringify({ error: 'Streaming failed', detail: err.message })}\n\n`);
    } catch (_) {
      // ignore
    }
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Routes: GitHub Codespaces management
// ---------------------------------------------------------------------------

// List available machine types for the configured repo

// ---------------------------------------------------------------------------
// TEMPORARY DEBUG ROUTE — reads the container's startup logs so we can
// diagnose the codespace SSH/SSHFS wiring in start.sh without needing a
// separate way to shell into the Render container. Safe to remove once the
// codespace wiring is confirmed working. No auth — this is a throwaway
// sandbox diagnostics endpoint.
// ---------------------------------------------------------------------------
const fs = require('fs');
app.get('/api/debug/logs', (_req, res) => {
  function tail(path, maxLen) {
    try {
      const content = fs.readFileSync(path, 'utf8');
      return content.length > maxLen ? content.slice(content.length - maxLen) : content;
    } catch (e) {
      return `<could not read ${path}: ${e.message}>`;
    }
  }
  // Grep product.json for webview-related keys, and dump env vars that
  // could cause code-server to think it's running inside GitHub Codespaces
  // (which would make it use the app.github.dev webview/port-forwarding
  // domain scheme instead of self-hosting webviews on our own origin).
  function grepFile(path, pattern) {
    try {
      const content = fs.readFileSync(path, 'utf8');
      const re = new RegExp(pattern, 'i');
      return content.split('\n').filter((l) => re.test(l)).join('\n') || '(no matches)';
    } catch (e) {
      return `<could not read ${path}: ${e.message}>`;
    }
  }
  function findProductJson() {
    const candidates = [
      '/usr/lib/code-server/lib/vscode/product.json',
      '/usr/lib/code-server/out/vs/product.json',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    try {
      const { execSync } = require('child_process');
      const found = execSync('find / -maxdepth 6 -iname product.json 2>/dev/null | head -5').toString().trim();
      return found.split('\n')[0] || null;
    } catch (_) { return null; }
  }
  const productJsonPath = findProductJson();
  const envDump = Object.keys(process.env)
    .filter((k) => /CODESPACE|GITHUB|VSCODE|WEBVIEW|PROXY|RENDER_EXTERNAL/i.test(k))
    .map((k) => `${k}=${process.env[k]}`)
    .join('\n') || '(no matching env vars)';

  res.type('text/plain').send(
    '=== /tmp/code-server.log (tail) ===\n' + tail('/tmp/code-server.log', 20000) +
    '\n\n=== /tmp/gh_ssh_config.log ===\n' + tail('/tmp/gh_ssh_config.log', 5000) +
    '\n\n=== /tmp/sshfs.log ===\n' + tail('/tmp/sshfs.log', 5000) +
    '\n\n=== /root/.ssh/config ===\n' + tail('/root/.ssh/config', 5000) +
    '\n\n=== /root/.local/share/code-server/User/settings.json ===\n' + tail('/root/.local/share/code-server/User/settings.json', 3000) +
    '\n\n=== env vars (CODESPACE|GITHUB|VSCODE|WEBVIEW|PROXY|RENDER_EXTERNAL) ===\n' + envDump +
    '\n\n=== product.json path ===\n' + String(productJsonPath) +
    '\n\n=== product.json webview* / proxy* keys ===\n' + (productJsonPath ? grepFile(productJsonPath, 'webview|proxy|cdn|Endpoint') : '(product.json not found)')
  );
});

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
// Switched from http-proxy-middleware to the lower-level `http-proxy` library
// directly. http-proxy-middleware wraps this engine with Express-specific
// heuristics (auto-detecting the underlying HTTP server to lazily subscribe
// to 'upgrade' on, etc.) that proved unreliable here: the VS Code Management
// WebSocket connection was failing almost immediately (within ~0.5-2s, per
// client logs: "WebSocket close with status code 1006") on every attempt,
// never even reaching a stable state. Driving `http-proxy` directly with
// exactly ONE explicit 'upgrade' listener on the raw `server` is the
// standard, well-tested pattern for proxying code-server and removes all
// ambiguity about how/when the upgrade gets wired up.
const codeServerProxy = httpProxy.createProxyServer({
  target: CODE_SERVER_TARGET,
  // IMPORTANT: changeOrigin must be FALSE here. With changeOrigin:true, the
  // outgoing `Host` header gets rewritten to the proxy target (127.0.0.1:8080),
  // while the browser's `Origin` header (sent as-is, e.g.
  // "https://vscodeai.onrender.com") is left untouched. code-server checks
  // Origin against Host on WebSocket upgrades as an anti cross-site-
  // WebSocket-hijacking measure — with changeOrigin:true those two no longer
  // matched, so code-server rejected EVERY real browser WS handshake with a
  // 403 (confirmed by direct testing: identical requests without an Origin
  // header succeeded; adding a same-origin Origin header alone produced a
  // 403 with no Express/app headers, meaning code-server itself rejected it
  // before our app ever saw it). Keeping the original Host header (i.e. not
  // rewriting it) makes Host and Origin agree again, so the check passes.
  changeOrigin: false,
  ws: true,
  // code-server's management/extension-host connections are long-lived with
  // idle gaps between app-level pings — don't let a proxy-side timeout kill them.
  proxyTimeout: 0,
  timeout: 0,
});

codeServerProxy.on('error', (err, req, res) => {
  console.error('Proxy error (code-server unreachable):', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<html><body style="font-family:sans-serif;padding:2rem">' +
      '<h2>code-server is still starting…</h2>' +
      '<p>The editor backend isn\'t reachable yet. This is normal right after a ' +
      'cold start/deploy — refresh in a few seconds.</p>' +
      '<pre>' + String(err && err.message).replace(/</g, '&lt;') + '</pre>' +
      '</body></html>'
    );
  } else if (res && typeof res.destroy === 'function') {
    // `res` is actually a raw socket here for WS upgrade errors.
    res.destroy();
  }
});

// Plain HTTP requests for anything not matched by our /api routes above.
app.use('/', (req, res) => {
  codeServerProxy.web(req, res);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`codeserver-ai backend listening on :${PORT}`);
  console.log(`  Proxying non-API requests to ${CODE_SERVER_TARGET}`);
  console.log(`  Gemini model: ${GEMINI_MODEL} (key ${GEMINI_API_KEY ? 'set' : 'MISSING'})`);
  console.log(`  GitHub sandbox repo: ${GITHUB_SANDBOX_REPO || '(not set)'}  machine: ${CODESPACE_MACHINE_TYPE}`);
  console.log(`  Tools: ${toolDeclarations.length} declarations, max ${MAX_TOOL_CALLS} tool calls per turn`);
});

// Node's default server-wide socket idle timeout is 2 minutes. VS Code's
// long-lived management/extension-host WebSocket connections sit idle
// between pings — disable Node's blanket timeout so it never cuts them.
server.timeout = 0;
server.keepAliveTimeout = 0;

// Exactly ONE explicit 'upgrade' listener — forwards WebSocket upgrades
// (terminal, editor sync, extension host, etc.) to code-server.
//
// WS COMPRESSION: we deliberately do NOT pass a custom `headers` option to
// codeServerProxy.ws() here. http-proxy's ws proxying forwards the client's
// original upgrade headers (including `Sec-WebSocket-Extensions:
// permessage-deflate`, sent automatically by every modern browser) to
// code-server byte-for-byte. code-server's own `ws` server negotiates
// permessage-deflate on its end, so both directions of every proxied
// WebSocket (terminal I/O, editor/document sync, extension host RPC) are
// already gzip/deflate-compressed on the wire without us touching a single
// byte in the middle — touching the frames here would require fully
// decoding the WS protocol, which isn't worth the risk of breaking VS
// Code's reconnection logic.
server.on('upgrade', (req, socket, head) => {
  codeServerProxy.ws(req, socket, head);
});

// ---------------------------------------------------------------------------
// Keepalive self-ping
// ---------------------------------------------------------------------------
// Render's free/starter web services spin down after a period with no
// INBOUND public HTTP traffic. Pinging localhost from inside the process
// doesn't count — Render only tracks requests that actually arrive over the
// public internet at the service's external URL. So this sends a real HEAD
// request to our own public URL every 3 minutes, which Render sees as
// legitimate traffic and keeps the instance awake.
const KEEPALIVE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const KEEPALIVE_URL = process.env.RENDER_EXTERNAL_URL || 'https://vscodeai.onrender.com';

function selfPing() {
  const target = `${KEEPALIVE_URL.replace(/\/$/, '')}/api/health`;
  const req = https.request(target, { method: 'HEAD', timeout: 10000 }, (res) => {
    keepaliveState.lastPingAt = new Date().toISOString();
    keepaliveState.lastStatus = res.statusCode;
    keepaliveState.count += 1;
    console.log(`[keepalive] HEAD ${target} -> ${res.statusCode}`);
    res.resume();
  });
  req.on('error', (err) => {
    keepaliveState.lastPingAt = new Date().toISOString();
    keepaliveState.lastStatus = `error: ${err.message}`;
    keepaliveState.count += 1;
    console.log(`[keepalive] HEAD ${target} failed: ${err.message}`);
  });
  req.on('timeout', () => req.destroy());
  req.end();
}

setInterval(selfPing, KEEPALIVE_INTERVAL_MS);
// Fire one shortly after boot too, so we don't wait a full 3 minutes for
// the first proof-of-life ping in the logs.
setTimeout(selfPing, 15000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});
