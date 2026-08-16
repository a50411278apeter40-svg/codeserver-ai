# AI Chat — VS Code Extension

A lightweight AI coding-assistant chat panel for VS Code / code-server, powered by Gemini/Gemma.

## Features

- Adds an **AI Chat** view container to the Activity Bar (chat-bubble icon).
- A webview-based chat UI: message list, multi-line textarea, and Send button.
- Streams assistant responses over **Server-Sent Events (SSE)** from a backend endpoint at `/api/chat`.
- Basic Markdown-ish rendering with fenced code block detection (``` ```lang ``` ```) and monospace styling — suited for a coding assistant.
- Automatically attaches the **active editor's file content and current selection** as `context` in each request, so you can ask "what does this code do?" about the open file.
- Commands:
  - `aiChat.focus` — Focus the AI Chat panel.
  - `aiChat.newChat` — Clear the conversation and start fresh (also available from the view title bar).
- UI subtitle notes that the assistant is **powered by Gemini/Gemma**.
- Graceful inline error bubbles if the `/api/chat` request fails.

## Request Payload

The webview POSTs the running conversation to `/api/chat`:

```json
{
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "context": {
    "activeFile": "path/to/open.ts",
    "selection": "selected text or ''"
  }
}
```

The response is a `text/event-stream` of tokens (`data: {token}` lines) which are appended live to the assistant bubble.

## Build

This extension is part of a custom Docker image that bundles code-server + this extension.

From the extension directory:

```bash
npm install
npm run compile      # tsc -> out/extension.js
npm run package      # produces ai-chat-0.0.1.vsix
```

In the Docker image the extension is typically built from source and placed in the code-server extensions directory (`~/.local/share/code-server/extensions/`), then code-server is started. Because it is a webview extension talking to a backend at the relative path `/api/chat`, it works in the browser-based code-server the same as in desktop VS Code.

## Requirements

- VS Code / code-server engine `^1.85.0`.
- A backend service exposing `POST /api/chat` returning an SSE stream.

## Extension Settings

None.

## Known Issues

- Code rendering is intentionally lightweight (fenced block detection + monospace styling) and not a full Markdown engine.
