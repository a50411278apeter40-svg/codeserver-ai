import * as vscode from 'vscode';

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * AI Chat — VS Code / code-server extension.
 *
 * Registers a webview view that renders a chat UI. The webview POSTs the
 * running conversation to a backend endpoint at the relative path `/api/chat`
 * and renders the streamed (SSE) tokens live. The active editor's file content
 * and current selection are attached as `context` on each request so the
 * assistant can answer questions about "this code".
 */

const BACKEND_PATH = '/api/chat';

/** Capture the active editor's file path, full text, and current selection. */
function getActiveEditorContext(): {
    activeFile: string;
    selection: string;
    fullContent: string;
} {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return { activeFile: '', selection: '', fullContent: '' };
    }
    const doc = editor.document;
    const sel = editor.selection;
    const selectionText = sel.isEmpty ? '' : doc.getText(sel);
    return {
        activeFile: doc.fileName,
        selection: selectionText,
        fullContent: doc.getText(),
    };
}

/** Build the HTML for the chat webview. */
function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    // The backend base path: code-server serves on the same origin, so we can
    // simply call the relative path. We also support an explicit backend origin
    // override via the chatBackendOrigin setting if the backend is hosted
    // elsewhere.
    const chatEndpoint = BACKEND_PATH;
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Chat</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource}; connect-src https: http://localhost:* http://127.0.0.1:*; script-src 'nonce-${nonce}';" />
  <style>
    :root {
      --bubble-user: var(--vscode-button-background, #0e639c);
      --bubble-user-fg: var(--vscode-button-foreground, #fff);
      --bubble-ai-bg: var(--vscode-editorWidget-background, #1e1e1e);
      --bubble-ai-fg: var(--vscode-editorWidget-foreground, #d4d4d4);
      --bubble-err-bg: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      --bubble-err-fg: var(--vscode-inputValidation-errorForeground, #ffd6d6);
      --border: var(--vscode-panel-border, #3c3c3c);
      --input-bg: var(--vscode-input-background, #313131);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --accent: var(--vscode-focusBorder, #007acc);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; height: 100%; width: 100%;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #cccccc);
      background: var(--vscode-sideBar-background, #252526);
      display: flex; flex-direction: column;
    }
    header {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
    }
    header h1 { margin: 0; font-size: 13px; font-weight: 600; }
    header .subtitle {
      margin: 2px 0 0 0; font-size: 11px;
      color: var(--vscode-descriptionForeground, #9d9d9d);
    }
    #messages {
      flex: 1 1 auto; overflow-y: auto; padding: 10px 12px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .bubble {
      max-width: 92%;
      padding: 8px 10px; border-radius: 8px; line-height: 1.45;
      white-space: normal; word-wrap: break-word; overflow-wrap: anywhere;
      border: 1px solid transparent;
    }
    .bubble.user {
      align-self: flex-end;
      background: var(--bubble-user); color: var(--bubble-user-fg);
    }
    .bubble.ai {
      align-self: flex-start;
      background: var(--bubble-ai-bg); color: var(--bubble-ai-fg);
    }
    .bubble.error {
      align-self: stretch; text-align: center;
      background: var(--bubble-err-bg); color: var(--bubble-err-fg);
    }
    .role-tag {
      font-size: 10px; opacity: 0.7; margin-bottom: 3px;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    pre.code {
      margin: 6px 0; padding: 8px; border-radius: 6px;
      background: rgba(0,0,0,0.35);
      border: 1px solid var(--border);
      overflow-x: auto;
    }
    pre.code code {
      font-family: var(--vscode-editor-font-family, "SF Mono", Menlo, Consolas, monospace);
      font-size: 12px; white-space: pre; line-height: 1.4;
    }
    .code-lang { font-size: 10px; opacity: 0.6; margin-bottom: 4px; display:block; }
    .typing::after { content: '▋'; animation: blink 1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    #composer {
      flex: 0 0 auto; padding: 8px 10px; border-top: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 6px;
    }
    textarea {
      width: 100%; min-height: 56px; max-height: 160px; resize: vertical;
      background: var(--input-bg); color: var(--input-fg);
      border: 1px solid var(--border); border-radius: 6px; padding: 8px;
      font-family: inherit; font-size: inherit; outline: none;
    }
    textarea:focus { border-color: var(--accent); }
    #composer-row { display: flex; align-items: center; gap: 8px; }
    #sendBtn {
      margin-left: auto;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer;
      font-size: 12px;
    }
    #sendBtn:disabled { opacity: 0.5; cursor: default; }
    #ctxHint { font-size: 10px; color: var(--vscode-descriptionForeground, #9d9d9d); }
    .ctx-on { color: var(--accent) !important; font-weight: 600; }
    .tool-row {
      align-self: stretch;
      font-family: var(--vscode-editor-font-family, "SF Mono", Menlo, Consolas, monospace);
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #9d9d9d);
      border-left: 2px solid var(--vscode-focusBorder, #007acc);
      padding: 4px 8px;
      margin: 2px 0;
      background: rgba(0,0,0,0.15);
      border-radius: 0 4px 4px 0;
    }
    .tool-call-pill {
      display: inline-block;
      white-space: pre-wrap;
      word-break: break-all;
      overflow-wrap: anywhere;
    }
    .tool-result details { margin-top: 4px; }
    .tool-result summary {
      cursor: pointer; font-size: 11px; outline: none;
    }
    .tool-result summary.ok { color: var(--vscode-testing-iconPassed, #73c991); }
    .tool-result summary.fail { color: var(--vscode-testing-iconFailed, #f48771); }
    .tool-result pre {
      margin: 4px 0 0 0; padding: 6px;
      background: rgba(0,0,0,0.25);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow-x: auto; overflow-y: auto;
      font-size: 11px;
      white-space: pre-wrap; word-break: break-all;
      max-height: 300px;
    }
  </style>
</head>
<body>
  <header>
    <h1>AI Chat</h1>
    <p class="subtitle">Coding assistant · powered by Gemini/Gemma</p>
  </header>

  <div id="messages"></div>

  <div id="composer">
    <div id="ctxHint">No active file context</div>
    <textarea id="input" placeholder="Ask about this code… (Enter to send, Shift+Enter for newline)"></textarea>
    <div id="composer-row">
      <button id="sendBtn">Send</button>
    </div>
  </div>

  <script nonce="${nonce}">
    (function () {
      const vscodeApi = acquireVsCodeApi();
      const messagesEl = document.getElementById('messages');
      const inputEl = document.getElementById('input');
      const sendBtn = document.getElementById('sendBtn');
      const ctxHint = document.getElementById('ctxHint');

      /** Conversation history sent with every request. */
      let history = [];
      let sending = false;

      function escapeHtml(s) {
        return s.replace(/[&<>"']/g, function (c) {
          return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
      }

      /**
       * Lightweight markdown-ish renderer:
       *  - Splits fenced code blocks (triple-backtick lang ... triple-backtick) and renders them in <pre><code>.
       *  - Everything else is escaped and has newlines preserved.
       */
      function renderContent(text) {
        const parts = [];
        const re = /(\`\`\`[a-zA-Z0-9_+-]*\n[\s\S]*?\`\`\`)/g;
        let last = 0; let m;
        while ((m = re.exec(text)) !== null) {
          if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) });
          const block = m[0];
          const inner = block.replace(/^\`\`\`[a-zA-Z0-9_+-]*\n/, '').replace(/\`\`\`$/, '');
          const langMatch = block.match(/^\`\`\`([a-zA-Z0-9_+-]*)/);
          const lang = langMatch ? langMatch[1] : '';
          parts.push({ code: true, text: inner, lang: lang });
          last = m.index + block.length;
        }
        if (last < text.length) parts.push({ code: false, text: text.slice(last) });

        return parts.map(function (p) {
          if (p.code) {
            const langTag = p.lang ? '<span class="code-lang">' + escapeHtml(p.lang) + '</span>' : '';
            return '<pre class="code">' + langTag + '<code>' + escapeHtml(p.text) + '</code></pre>';
          }
          return '<div>' + escapeHtml(p.text).replace(/\n/g, '<br>') + '</div>';
        }).join('');
      }

      function addBubble(role, content, opts) {
        opts = opts || {};
        const wrap = document.createElement('div');
        wrap.className = 'bubble ' + (opts.error ? 'error' : role);
        if (role !== 'user') {
          const tag = document.createElement('div');
          tag.className = 'role-tag';
          tag.textContent = opts.error ? 'Error' : (role === 'ai' ? 'Assistant' : 'System');
          wrap.appendChild(tag);
        }
        const body = document.createElement('div');
        body.className = 'content';
        if (opts.raw) { body.innerHTML = content; }
        else if (opts.error) { body.textContent = content; }
        else { body.innerHTML = renderContent(content); }
        wrap.appendChild(body);
        messagesEl.appendChild(wrap);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return { wrap: wrap, body: body };
      }

      /**
       * Render a ReAct-style tool call as a lightweight row, inserted before
       * the AI answer bubble so the trace appears as it happens.
       * Returns the unique DOM id assigned to the row.
       */
      function addToolCall(toolCall, insertBeforeEl, counter) {
        var id = 'tool-call-' + counter;
        var row = document.createElement('div');
        row.className = 'tool-row tool-call';
        row.id = id;
        var argsStr = (toolCall.args !== undefined && toolCall.args !== null)
          ? JSON.stringify(toolCall.args)
          : '{}';
        var pill = document.createElement('span');
        pill.className = 'tool-call-pill';
        pill.textContent = '\u{1F527} ' + (toolCall.name || 'unknown') + '(' + argsStr + ')';
        row.appendChild(pill);
        messagesEl.insertBefore(row, insertBeforeEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return id;
      }

      /**
       * Render a tool result below its matching tool_call row (identified by
       * callId). Collapsed by default when output is long.
       */
      function addToolResult(toolResult, callId) {
        var callRow = document.getElementById(callId);
        if (!callRow) { return; }

        var resultRow = document.createElement('div');
        resultRow.className = 'tool-row tool-result';

        var details = document.createElement('details');

        var summary = document.createElement('summary');
        var summaryText = 'Result';
        var summaryClass = '';
        if (toolResult && typeof toolResult.exitCode === 'number') {
          if (toolResult.exitCode === 0) {
            summaryText = '\u2713 exit 0';
            summaryClass = 'ok';
          } else {
            summaryText = '\u2717 exit ' + toolResult.exitCode;
            summaryClass = 'fail';
          }
        }
        if (toolResult && toolResult.name) {
          summaryText = toolResult.name + ' \u00B7 ' + summaryText;
        }
        summary.textContent = summaryText;
        if (summaryClass) { summary.className = summaryClass; }

        var resultVal = (toolResult && toolResult.result !== undefined) ? toolResult.result : toolResult;
        var resultText;
        if (typeof resultVal === 'string') {
          resultText = resultVal;
        } else {
          resultText = JSON.stringify(resultVal, null, 2);
        }

        var MAX = 4000;
        var truncated = false;
        if (resultText.length > MAX) {
          resultText = resultText.slice(0, MAX);
          truncated = true;
        }

        var pre = document.createElement('pre');
        pre.textContent = resultText + (truncated ? '\n... (truncated)' : '');

        details.appendChild(summary);
        details.appendChild(pre);

        // Collapse by default if output is long.
        details.open = (resultText.length <= 500);

        resultRow.appendChild(details);
        callRow.parentNode.insertBefore(resultRow, callRow.nextSibling);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      function setSending(state) {
        sending = state;
        sendBtn.disabled = state;
      }

      function updateCtxHint(ctx) {
        if (ctx && ctx.activeFile) {
          ctxHint.textContent = 'Context: ' + ctx.activeFile.split(/[\\/]/).pop() +
            (ctx.selection ? ' (selection)' : ' (full file)');
          ctxHint.className = 'ctx-on';
        } else {
          ctxHint.textContent = 'No active file context';
          ctxHint.className = '';
        }
      }

      async function sendMessage() {
        if (sending) return;
        const text = inputEl.value.trim();
        if (!text) return;
        inputEl.value = '';
        history.push({ role: 'user', content: text });
        addBubble('user', text);

        // Ask the extension host for fresh active-editor context right before sending.
        let context = { activeFile: '', selection: '' };
        try {
          const ctxMsg = await requestContext();
          if (ctxMsg) { context = ctxMsg; }
        } catch (e) { /* ignore — proceed with empty context */ }
        updateCtxHint(context);

        const aiBubble = addBubble('ai', '', { raw: false });
        aiBubble.body.classList.add('typing');
        let assistantText = '';
        let toolCallCounter = 0;
        let pendingToolCalls = [];

        try {
          setSending(true);
          const endpoint = ${JSON.stringify(chatEndpoint)};
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify({ messages: history, context: context })
          });
          if (!resp.ok || !resp.body) {
            throw new Error('HTTP ' + resp.status + ' ' + resp.statusText);
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // SSE events are separated by double newlines.
            const events = buffer.split(/\n\n/);
            buffer = events.pop(); // keep incomplete tail
            for (const evt of events) {
              const lines = evt.split(/\n/);
              for (const line of lines) {
                if (line.startsWith('data:')) {
                  let data = line.slice(5).trimStart();
                  if (data === '[DONE]') { continue; }
                  // The backend sends each real answer chunk as a JSON-encoded
                  // string, e.g. data: "some text". Control/error events are
                  // sent as a JSON object instead, e.g. data: {"error": "..."}.
                  // Anything else (unknown object shape) is ignored rather than
                  // ever being appended as raw text to the chat.
                  let parsed;
                  try { parsed = JSON.parse(data); } catch (e) { continue; }
                  if (typeof parsed === 'string') {
                    assistantText += parsed;
                    aiBubble.body.innerHTML = renderContent(assistantText);
                    messagesEl.scrollTop = messagesEl.scrollHeight;
                  } else if (parsed && typeof parsed.error === 'string') {
                    aiBubble.body.classList.remove('typing');
                    aiBubble.wrap.classList.add('error');
                    aiBubble.body.textContent = 'Error: ' + parsed.error + (parsed.detail ? (' — ' + JSON.stringify(parsed.detail).slice(0, 300)) : '');
                  } else if (parsed && parsed.tool_call) {
                    var tcId = addToolCall(parsed.tool_call, aiBubble.wrap, toolCallCounter);
                    toolCallCounter += 1;
                    pendingToolCalls.push({ id: tcId, name: parsed.tool_call.name });
                  } else if (parsed && parsed.tool_result) {
                    var matchIdx = -1;
                    if (parsed.tool_result.name) {
                      matchIdx = pendingToolCalls.findIndex(function (p) {
                        return p.name === parsed.tool_result.name;
                      });
                    }
                    if (matchIdx === -1 && pendingToolCalls.length > 0) {
                      matchIdx = 0;
                    }
                    if (matchIdx >= 0) {
                      var matched = pendingToolCalls[matchIdx];
                      pendingToolCalls.splice(matchIdx, 1);
                      addToolResult(parsed.tool_result, matched.id);
                    }
                  }
                  // else: unknown control/meta object — ignore silently.
                }
              }
            }
          }
          aiBubble.body.classList.remove('typing');
          if (!assistantText) {
            aiBubble.body.innerHTML = '<em>(no response)</em>';
          }
          history.push({ role: 'assistant', content: assistantText });
        } catch (err) {
          aiBubble.wrap.remove();
          addBubble('error', 'Failed to reach /api/chat: ' + (err && err.message ? err.message : String(err)), { error: true });
        } finally {
          setSending(false);
        }
      }

      /** Ask the extension host for the current active editor context. */
      function requestContext() {
        return new Promise(function (resolve, reject) {
          const id = 'ctx_' + Math.random().toString(36).slice(2);
          const handler = function (event) {
            const data = event.data;
            if (data && data.type === 'context' && data.id === id) {
              window.removeEventListener('message', handler);
              resolve({ activeFile: data.activeFile, selection: data.selection });
            }
          };
          window.addEventListener('message', handler);
          vscodeApi.postMessage({ type: 'getContext', id: id });
          // Fail-safe timeout in case the host never replies.
          setTimeout(function () {
            window.removeEventListener('message', handler);
            resolve(null);
          }, 1500);
        });
      }

      // Receive messages from the extension host.
      window.addEventListener('message', function (event) {
        const data = event.data;
        if (!data) return;
        if (data.type === 'context' || data.type === 'newChat') {
          // context handled per-request via requestContext(); newChat handled below
        }
        if (data.type === 'newChat') {
          history = [];
          messagesEl.innerHTML = '';
          updateCtxHint({ activeFile: '', selection: '' });
        }
        if (data.type === 'initialContext') {
          updateCtxHint(data.context || { activeFile: '', selection: '' });
        }
      });

      sendBtn.addEventListener('click', sendMessage);
      inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      // Auto-resize the textarea.
      inputEl.addEventListener('input', function () {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(160, inputEl.scrollHeight) + 'px';
      });

      // Ask for initial context on load.
      requestContext().then(function (ctx) {
        if (ctx) updateCtxHint(ctx);
        else updateCtxHint({ activeFile: '', selection: '' });
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * The webview view provider that creates and manages the chat panel.
 */
class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aiChatView';

    private view?: vscode.WebviewView;

    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        const extensionUri = this.context.extensionUri;

        webviewView.webview.options = {
            enableScripts: true,
            // Allow loading resources from the same origin (code-server backend).
            localResourceRoots: [extensionUri],
        };

        webviewView.webview.html = getWebviewContent(webviewView.webview, extensionUri);

        // Handle messages from the webview.
        webviewView.webview.onDidReceiveMessage(
            async (msg: { type: string; id?: string }) => {
                if (msg.type === 'getContext' && msg.id) {
                    const ctx = getActiveEditorContext();
                    webviewView.webview.postMessage({
                        type: 'context',
                        id: msg.id,
                        activeFile: ctx.activeFile,
                        selection: ctx.selection,
                    });
                }
            },
            undefined,
            this.context.subscriptions
        );

        // Update initial context proactively.
        const ctx = getActiveEditorContext();
        webviewView.webview.postMessage({
            type: 'initialContext',
            context: { activeFile: ctx.activeFile, selection: ctx.selection },
        });
    }

    /** Clear the conversation from outside (e.g. via the newChat command). */
    newChat(): void {
        if (this.view) {
            this.view.show?.(true);
            this.view.webview.postMessage({ type: 'newChat' });
        }
    }

    focus(): void {
        if (this.view) {
            this.view.show?.(true);
        }
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const provider = new ChatViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiChat.focus', () => {
            provider.focus();
            vscode.commands.executeCommand(ChatViewProvider.viewType + '.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiChat.newChat', () => {
            provider.newChat();
        })
    );
}

export function deactivate(): void {
    /* no-op */
}
