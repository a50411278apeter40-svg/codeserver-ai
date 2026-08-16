'use strict';

/**
 * tools.js — Tool definitions & dispatcher for the ReAct agent loop
 * ------------------------------------------------------------------
 * Exports:
 *   - toolDeclarations: array in Gemini function-calling format
 *     { name, description, parameters: { type: 'object', properties, required } }
 *   - dispatchTool(name, args, sessionState): routes to the right implementation,
 *     returns a plain JSON-serializable object for Gemini's functionResponse.
 *
 * CRITICAL DESIGN PRINCIPLE:
 *   EVERY tool that touches the filesystem, runs commands, or deals with the
 *   dev environment/machine executes INSIDE the live GitHub Codespace — never
 *   on the Render container itself. The Render container only hosts code-server
 *   (the editor UI) + this backend. All actual code execution / file IO for the
 *   AI happens in the Codespace via execInCodespace().
 *
 *   The only exceptions are tools that call the GitHub REST API directly
 *   (list_environments, select_environment, ensure_codespace) — those don't
 *   need shell access, they use fetch() against api.github.com.
 *
 *   ensure_codespace() is called AUTOMATICALLY by the dispatcher before any
 *   filesystem/command/environment tool runs, so the AI doesn't have to
 *   remember to do it. It's also exposed as a callable tool for explicit use.
 */

const {
  execInCodespace,
  ensureCodespaceRunning,
  listCodespacesForRepo,
  createCodespace,
  deleteCodespace,
  listMachines,
  getCodespaceState,
  GITHUB_SANDBOX_REPO,
  CODESPACE_MACHINE_TYPE,
} = require('./codespaceExec');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_FILE_READ = 200000;       // 200 KB for read_file
const MAX_CMD_OUTPUT = 20000;       // 20 KB combined stdout+stderr for run_command
const MAX_GREP_LINES = 200;         // cap search_code output lines

// Tools that require a running codespace (auto-ensure before dispatch)
const CODESPACE_TOOLS = new Set([
  'list_files', 'read_file', 'write_file', 'append_file', 'delete_file',
  'move_file', 'search_code', 'run_command',
  'git_status', 'git_diff', 'git_commit_and_push',
]);

// ---------------------------------------------------------------------------
// Gemini function-calling declarations
// ---------------------------------------------------------------------------

const toolDeclarations = [
  {
    name: 'list_files',
    description: 'List files and directories at the given path inside the codespace. Returns ls -la output.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list. Defaults to "." (codespace root).' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file inside the codespace. Large files are truncated to 200KB.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file inside the codespace with the given content. Parent directories are created automatically. Safe for arbitrary content including quotes, backticks, and newlines.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write.' },
        content: { type: 'string', description: 'The full content to write to the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'append_file',
    description: 'Append content to an existing file (or create it) inside the codespace. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to append to.' },
        content: { type: 'string', description: 'The content to append.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file or directory inside the codespace. Refuses to delete "/" or "." for safety.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete (file or directory, recursive).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file/directory inside the codespace.',
    parameters: {
      type: 'object',
      properties: {
        src: { type: 'string', description: 'Source path.' },
        dest: { type: 'string', description: 'Destination path.' },
      },
      required: ['src', 'dest'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for a text pattern in files under a path inside the codespace using grep. Excludes node_modules and .git directories. Results capped at 200 lines.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text pattern to search for.' },
        path: { type: 'string', description: 'Directory to search in. Defaults to "." (codespace root).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'run_command',
    description: 'Run an arbitrary shell command inside the codespace. This is the tool for running code, installing packages, running tests, building, etc. Combined stdout+stderr is capped at 20KB. Always returns the exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        cwd: { type: 'string', description: 'Working directory for the command. Defaults to codespace home.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'git_status',
    description: 'Show git working tree status inside the codespace.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'git_diff',
    description: 'Show git diff (unstaged changes) for a path inside the codespace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to diff. Defaults to "." (entire repo).' },
      },
    },
  },
  {
    name: 'git_commit_and_push',
    description: 'Stage all changes, commit with a message, and push to the remote branch inside the codespace.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message.' },
        branch: { type: 'string', description: 'Branch to push to. Defaults to the current branch.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'list_environments',
    description: 'List available GitHub Codespace machine types (compute environments/specs) for the configured sandbox repo. Uses the GitHub REST API, not shell execution.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'select_environment',
    description: 'Select or change the compute environment (machine type) for the codespace. NOTE: GitHub Codespaces machine type changes require the codespace to be RECREATED — there is no in-place resize via REST for arbitrary state. If no codespace exists, creates one with the specified machine. If one exists on a different machine, set force=true to delete and recreate it (this destroys the current codespace and its data). Without force, returns a message explaining the tradeoff.',
    parameters: {
      type: 'object',
      properties: {
        machine_type: { type: 'string', description: 'The machine type identifier (e.g. "largePremiumLinux", "basicLinux").' },
        codespace_name: { type: 'string', description: 'Existing codespace name if changing its machine. Omit to auto-resolve.' },
        force: { type: 'boolean', description: 'If true and a codespace exists on a different machine, delete and recreate it. WARNING: this destroys the current codespace data.' },
      },
      required: ['machine_type'],
    },
  },
  {
    name: 'ensure_codespace',
    description: 'Ensure a GitHub Codespace exists for the sandbox repo and is running (Available). If no codespace exists, creates one with the default machine type. If one exists but is stopped, starts it and waits until Available. Call this before any file or command operations — though the system auto-calls it for you.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// Session state: codespace name resolution (lazy, cached per session)
// ---------------------------------------------------------------------------

/**
 * Resolve the codespace name for the configured sandbox repo.
 * 1. If sessionState.codespaceName is cached, return it.
 * 2. Otherwise, list codespaces for the repo.
 * 3. If found, cache the name and return it.
 * 4. If none found, create one (default machine type), cache, and return.
 *
 * @param {object} sessionState - mutable per-session state { codespaceName }
 * @returns {Promise<string>} codespace name
 */
async function resolveCodespaceName(sessionState) {
  if (sessionState.codespaceName) return sessionState.codespaceName;

  // Try to find an existing codespace for the repo
  const codespaces = await listCodespacesForRepo();
  if (codespaces.length > 0) {
    // Pick the first available codespace
    sessionState.codespaceName = codespaces[0].name;
    return sessionState.codespaceName;
  }

  // No codespace exists — create one with the default machine type
  const cs = await createCodespace({ machine: CODESPACE_MACHINE_TYPE });
  sessionState.codespaceName = cs.name;
  return sessionState.codespaceName;
}

/**
 * Ensure the codespace is running (Available). Resolves the name if needed,
 * then calls ensureCodespaceRunning.
 *
 * @param {object} sessionState
 * @returns {Promise<{ codespaceName: string, state: string }>}
 */
async function ensureCodespace(sessionState) {
  const codespaceName = await resolveCodespaceName(sessionState);
  const cs = await ensureCodespaceRunning(codespaceName);
  return { codespaceName: cs.name, state: cs.state };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/**
 * Truncate a string to maxLen chars, appending a truncation notice.
 */
function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... [truncated at ${maxLen} chars]`;
}

/**
 * Base64-encode content for safe transfer to the codespace.
 * Avoids shell-escaping hell for arbitrary code with quotes/backticks/newlines.
 */
function toBase64(str) {
  return Buffer.from(str, 'utf-8').toString('base64');
}

/**
 * Escape a string for safe use inside single quotes in a shell command.
 * (Used for grep query and file paths that go into single-quoted contexts.)
 */
function shellSingleQuote(str) {
  return String(str).replace(/'/g, "'\\''");
}

// ---- Filesystem tools (all via execInCodespace) ----

async function tool_list_files(args, sessionState) {
  const path = args.path || '.';
  const safePath = shellSingleQuote(path);
  const result = await execInCodespace(sessionState.codespaceName, `ls -la ${safePath}`);
  return {
    path,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function tool_read_file(args, sessionState) {
  const path = args.path;
  if (!path) return { error: 'path is required' };
  const safePath = shellSingleQuote(path);
  // Guard huge files: pipe through head -c 200000
  const result = await execInCodespace(
    sessionState.codespaceName,
    `head -c ${MAX_FILE_READ} ${safePath}`
  );
  let content = result.stdout;
  let truncated = false;
  if (content.length >= MAX_FILE_READ) {
    truncated = true;
    content = content + `\n... [file truncated at ${MAX_FILE_READ} bytes]`;
  }
  return {
    path,
    exitCode: result.exitCode,
    content,
    stderr: result.stderr,
    truncated,
  };
}

async function tool_write_file(args, sessionState) {
  const path = args.path;
  if (!path) return { error: 'path is required' };
  if (args.content === undefined || args.content === null) return { error: 'content is required' };

  const b64 = toBase64(args.content);
  const safePath = shellSingleQuote(path);
  // mkdir -p $(dirname <path>) && echo '<base64>' | base64 -d > <path>
  const result = await execInCodespace(
    sessionState.codespaceName,
    `mkdir -p "$(dirname ${safePath})" && echo '${b64}' | base64 -d > ${safePath}`
  );
  return {
    path,
    exitCode: result.exitCode,
    bytesWritten: result.exitCode === 0 ? Buffer.byteLength(args.content, 'utf-8') : 0,
    stderr: result.stderr,
  };
}

async function tool_append_file(args, sessionState) {
  const path = args.path;
  if (!path) return { error: 'path is required' };
  if (args.content === undefined || args.content === null) return { error: 'content is required' };

  const b64 = toBase64(args.content);
  const safePath = shellSingleQuote(path);
  const result = await execInCodespace(
    sessionState.codespaceName,
    `mkdir -p "$(dirname ${safePath})" && echo '${b64}' | base64 -d >> ${safePath}`
  );
  return {
    path,
    exitCode: result.exitCode,
    stderr: result.stderr,
  };
}

async function tool_delete_file(args, sessionState) {
  const path = args.path;
  if (!path) return { error: 'path is required' };
  // Safety: refuse '/' or '.' or empty
  if (path === '/' || path === '.' || path === '') {
    return { error: 'Refusing to delete root path for safety', path };
  }
  const safePath = shellSingleQuote(path);
  const result = await execInCodespace(
    sessionState.codespaceName,
    `rm -rf ${safePath}`
  );
  return {
    path,
    exitCode: result.exitCode,
    stderr: result.stderr,
  };
}

async function tool_move_file(args, sessionState) {
  const src = args.src;
  const dest = args.dest;
  if (!src) return { error: 'src is required' };
  if (!dest) return { error: 'dest is required' };
  const safeSrc = shellSingleQuote(src);
  const safeDest = shellSingleQuote(dest);
  const result = await execInCodespace(
    sessionState.codespaceName,
    `mv ${safeSrc} ${safeDest}`
  );
  return {
    src,
    dest,
    exitCode: result.exitCode,
    stderr: result.stderr,
  };
}

async function tool_search_code(args, sessionState) {
  const query = args.query;
  if (!query) return { error: 'query is required' };
  const path = args.path || '.';
  const safeQuery = shellSingleQuote(query);
  const safePath = shellSingleQuote(path);
  const result = await execInCodespace(
    sessionState.codespaceName,
    `grep -rn --exclude-dir=node_modules --exclude-dir=.git ${safeQuery} ${safePath} | head -${MAX_GREP_LINES}`
  );
  let truncated = false;
  let stdout = result.stdout;
  // Check if we hit the line cap
  const lineCount = stdout.split('\n').filter((l) => l.trim()).length;
  if (lineCount >= MAX_GREP_LINES) {
    truncated = true;
  }
  return {
    query,
    path,
    exitCode: result.exitCode,
    stdout: truncate(stdout, MAX_CMD_OUTPUT),
    stderr: result.stderr,
    truncated,
    note: result.exitCode === 1 ? 'No matches found (grep exit code 1)' : undefined,
  };
}

async function tool_run_command(args, sessionState) {
  const command = args.command;
  if (!command) return { error: 'command is required' };
  const cwd = args.cwd;
  const result = await execInCodespace(sessionState.codespaceName, command, { cwd });
  const combined = (result.stdout || '') + (result.stderr ? '\n[stderr]\n' + result.stderr : '');
  return {
    command,
    cwd: cwd || '~',
    exitCode: result.exitCode,
    stdout: truncate(result.stdout, MAX_CMD_OUTPUT),
    stderr: truncate(result.stderr, MAX_CMD_OUTPUT),
    output: truncate(combined, MAX_CMD_OUTPUT),
  };
}

// ---- Git tools (all via execInCodespace) ----

async function tool_git_status(args, sessionState) {
  const result = await execInCodespace(sessionState.codespaceName, 'git status');
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function tool_git_diff(args, sessionState) {
  const path = args.path || '.';
  const safePath = shellSingleQuote(path);
  const result = await execInCodespace(
    sessionState.codespaceName,
    `git diff -- ${safePath}`
  );
  return {
    path,
    exitCode: result.exitCode,
    stdout: truncate(result.stdout, MAX_CMD_OUTPUT),
    stderr: result.stderr,
  };
}

async function tool_git_commit_and_push(args, sessionState) {
  const message = args.message;
  if (!message) return { error: 'message is required' };
  const safeMsg = shellSingleQuote(message);
  const branchPart = args.branch ? `origin ${shellSingleQuote(args.branch)}` : 'origin HEAD';
  const result = await execInCodespace(
    sessionState.codespaceName,
    `git add -A && git commit -m ${safeMsg} && git push ${branchPart}`
  );
  return {
    message,
    branch: args.branch || '(current)',
    exitCode: result.exitCode,
    stdout: truncate(result.stdout, MAX_CMD_OUTPUT),
    stderr: truncate(result.stderr, MAX_CMD_OUTPUT),
  };
}

// ---- Environment tools (GitHub REST API, not exec) ----

async function tool_list_environments(_args, _sessionState) {
  try {
    const machines = await listMachines();
    return {
      machines: machines.map((m) => ({
        name: m.name,
        display_name: m.display_name,
        prebuild_storage_in_bytes: m.prebuild_storage_in_bytes,
        operating_system: m.operating_system,
        storage_in_bytes: m.storage_in_bytes,
        cpus: m.cpus,
        memory_in_bytes: m.memory_in_bytes,
      })),
      configured_machine_type: CODESPACE_MACHINE_TYPE,
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function tool_select_environment(args, sessionState) {
  const machineType = args.machine_type;
  if (!machineType) return { error: 'machine_type is required' };
  const force = args.force || false;

  try {
    // Check if a codespace already exists
    const codespaceName = args.codespace_name || sessionState.codespaceName;
    let existingCs = null;
    if (codespaceName) {
      existingCs = await getCodespaceState(codespaceName);
    } else {
      const codespaces = await listCodespacesForRepo();
      if (codespaces.length > 0) {
        existingCs = codespaces[0];
        sessionState.codespaceName = existingCs.name;
      }
    }

    if (!existingCs) {
      // No codespace exists — create one with the requested machine type
      const cs = await createCodespace({ machine: machineType });
      sessionState.codespaceName = cs.name;
      return {
        action: 'created',
        codespace_name: cs.name,
        machine_type: machineType,
        state: cs.state,
        message: `Created new codespace "${cs.name}" with machine type "${machineType}".`,
      };
    }

    // Codespace exists — check if it's on the requested machine
    const currentMachine = existingCs.machine?.display_name || existingCs.machine?.name || 'unknown';
    if (currentMachine === machineType) {
      return {
        action: 'no_change_needed',
        codespace_name: existingCs.name,
        machine_type: machineType,
        message: `Codespace "${existingCs.name}" is already on machine type "${machineType}".`,
      };
    }

    // Different machine — need to delete and recreate
    if (!force) {
      return {
        action: 'requires_force',
        codespace_name: existingCs.name,
        current_machine: currentMachine,
        requested_machine: machineType,
        message: `Codespace "${existingCs.name}" is on machine "${currentMachine}". Changing machine type requires deleting and recreating the codespace (this destroys all data). Set force=true to proceed.`,
      };
    }

    // Force: delete and recreate
    await deleteCodespace(existingCs.name);
    sessionState.codespaceName = null; // clear cache
    const newCs = await createCodespace({ machine: machineType });
    sessionState.codespaceName = newCs.name;
    return {
      action: 'recreated',
      old_codespace_name: existingCs.name,
      new_codespace_name: newCs.name,
      machine_type: machineType,
      state: newCs.state,
      message: `Deleted old codespace and created new one "${newCs.name}" with machine type "${machineType}".`,
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function tool_ensure_codespace(_args, sessionState) {
  try {
    const result = await ensureCodespace(sessionState);
    return {
      codespace_name: result.codespaceName,
      state: result.state,
      message: `Codespace "${result.codespaceName}" is ${result.state}.`,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

const toolImplementations = {
  list_files: tool_list_files,
  read_file: tool_read_file,
  write_file: tool_write_file,
  append_file: tool_append_file,
  delete_file: tool_delete_file,
  move_file: tool_move_file,
  search_code: tool_search_code,
  run_command: tool_run_command,
  git_status: tool_git_status,
  git_diff: tool_git_diff,
  git_commit_and_push: tool_git_commit_and_push,
  list_environments: tool_list_environments,
  select_environment: tool_select_environment,
  ensure_codespace: tool_ensure_codespace,
};

/**
 * Dispatch a tool call by name.
 *
 * For filesystem/command/environment tools, automatically ensures the codespace
 * is running first (so the AI doesn't have to remember to call ensure_codespace).
 *
 * @param {string} name - tool name
 * @param {object} args - tool arguments
 * @param {object} sessionState - mutable { codespaceName } (cached per session)
 * @returns {Promise<object>} JSON-serializable result for Gemini functionResponse
 */
async function dispatchTool(name, args, sessionState) {
  if (!sessionState) sessionState = {};
  args = args || {};

  const impl = toolImplementations[name];
  if (!impl) {
    return { error: `Unknown tool: ${name}` };
  }

  try {
    // Auto-ensure codespace is running before any fs/command/env tool
    if (CODESPACE_TOOLS.has(name)) {
      await ensureCodespace(sessionState);
    }

    const result = await impl(args, sessionState);
    return result;
  } catch (err) {
    return {
      error: `Tool "${name}" failed: ${err.message}`,
      stack: err.stack,
    };
  }
}

module.exports = {
  toolDeclarations,
  dispatchTool,
  resolveCodespaceName,
  ensureCodespace,
};
