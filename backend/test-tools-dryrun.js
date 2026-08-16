#!/usr/bin/env node
'use strict';

/**
 * test-tools-dryrun.js — Dry-run test for tools.js dispatchTool
 * ------------------------------------------------------------------
 * Mocks execInCodespace (monkeypatch) to return canned outputs, then verifies
 * dispatchTool produces sensible structured results without throwing.
 *
 * Run: node backend/test-tools-dryrun.js
 */

// We need to mock execInCodespace BEFORE tools.js requires it.
// Strategy: require codespaceExec.js, replace its execInCodespace with a mock,
// then require tools.js (which already destructured execInCodespace at require
// time — so we must patch before require, OR we can use the exported reference).
//
// Since tools.js does: const { execInCodespace, ... } = require('./codespaceExec')
// the binding is captured at require time. To mock it, we patch the property
// on the codespaceExec module's exports BEFORE tools.js is required.

const codespaceExec = require('./codespaceExec');

// ---------------------------------------------------------------------------
// Mock execInCodespace
// ---------------------------------------------------------------------------
const mockOutputs = {};
let mockCallLog = [];

codespaceExec.execInCodespace = async function (codespaceName, command, options = {}) {
  mockCallLog.push({ codespaceName, command, options });

  // Check for specific canned outputs keyed by a substring match on command
  for (const [key, output] of Object.entries(mockOutputs)) {
    if (command.includes(key)) {
      return output;
    }
  }

  // Default mock response
  return {
    stdout: `mock output for: ${command}`,
    stderr: '',
    exitCode: 0,
  };
};

// Also mock the GitHub REST helpers that tools.js calls during ensureCodespace
codespaceExec.listCodespacesForRepo = async () => [{ name: 'mock-codespace', state: 'Available' }];
codespaceExec.ensureCodespaceRunning = async (name) => ({ name, state: 'Available' });
codespaceExec.createCodespace = async (opts) => ({ name: 'mock-codespace', state: 'Available', machine: { name: opts.machine } });
codespaceExec.getCodespaceState = async (name) => ({ name, state: 'Available', machine: { name: 'test' } });
codespaceExec.listMachines = async () => [
  { name: 'basicLinux', display_name: '2 cores, 8 GB RAM, 32 GB storage', cpus: 2, memory_in_bytes: 8589934592, storage_in_bytes: 34359738368, operating_system: 'linux' },
  { name: 'largePremiumLinux', display_name: '16 cores, 64 GB RAM, 128 GB storage', cpus: 16, memory_in_bytes: 68719476736, storage_in_bytes: 137438953472, operating_system: 'linux' },
];

// Now require tools.js AFTER patching
const { dispatchTool, toolDeclarations } = require('./tools');

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n=== tools.js dry-run tests ===\n');
  mockCallLog = [];

  // Test 1: toolDeclarations should be a non-empty array
  console.log('Test: toolDeclarations');
  assert(Array.isArray(toolDeclarations), 'toolDeclarations is an array');
  assert(toolDeclarations.length >= 14, `toolDeclarations has ${toolDeclarations.length} tools (expected ≥14)`);
  assert(
    toolDeclarations.every((t) => t.name && t.description && t.parameters && t.parameters.type === 'object'),
    'all declarations have name, description, and parameters.type=object'
  );

  // Test 2: list_files
  console.log('\nTest: list_files');
  mockOutputs['ls -la'] = {
    stdout: 'total 16\ndrwxr-xr-x 3 root root 4096 Jan 1 00:00 .\n-rw-r--r-- 1 root root  100 Jan 1 00:00 app.js',
    stderr: '',
    exitCode: 0,
  };
  const listResult = await dispatchTool('list_files', { path: '.' }, {});
  assert(listResult.exitCode === 0, 'list_files returns exitCode 0');
  assert(typeof listResult.stdout === 'string', 'list_files returns stdout string');
  assert(listResult.stdout.includes('app.js'), 'list_files stdout includes expected file');
  assert(listResult.path === '.', 'list_files echoes path');

  // Test 3: write_file (base64 approach)
  console.log('\nTest: write_file');
  mockOutputs['base64 -d'] = {
    stdout: '',
    stderr: '',
    exitCode: 0,
  };
  const writeResult = await dispatchTool('write_file', { path: '/workspace/test.js', content: 'console.log("hello world");\n' }, {});
  assert(writeResult.exitCode === 0, 'write_file returns exitCode 0');
  assert(writeResult.path === '/workspace/test.js', 'write_file echoes path');
  assert(writeResult.bytesWritten > 0, 'write_file reports bytesWritten > 0');

  // Verify the base64 approach was used in the command
  const writeCall = mockCallLog.find((c) => c.command.includes('base64 -d'));
  assert(writeCall, 'write_file uses base64 -d in command');
  assert(writeCall.command.includes('> '), 'write_file uses redirect to write file');
  assert(writeCall.command.includes('mkdir -p'), 'write_file creates parent dirs');

  // Test 4: run_command
  console.log('\nTest: run_command');
  mockCallLog = [];
  mockOutputs['npm test'] = {
    stdout: '> myproject@1.0.0 test\n> jest\n\nPASS  src/app.test.js\n✓ works (5ms)\nTests: 1 passed, 1 total',
    stderr: '',
    exitCode: 0,
  };
  const cmdResult = await dispatchTool('run_command', { command: 'npm test', cwd: '/workspace' }, {});
  assert(cmdResult.exitCode === 0, 'run_command returns exitCode 0');
  assert(typeof cmdResult.stdout === 'string', 'run_command returns stdout string');
  assert(cmdResult.stdout.includes('PASS'), 'run_command stdout includes test output');
  assert(cmdResult.command === 'npm test', 'run_command echoes command');
  assert(cmdResult.cwd === '/workspace', 'run_command echoes cwd');

  // Test 5: search_code
  console.log('\nTest: search_code');
  mockCallLog = [];
  mockOutputs['grep'] = {
    stdout: 'src/app.js:10:const x = 42;\nsrc/utils.js:5:const x = 100;',
    stderr: '',
    exitCode: 0,
  };
  const searchResult = await dispatchTool('search_code', { query: 'const x', path: 'src' }, {});
  assert(searchResult.exitCode === 0, 'search_code returns exitCode 0');
  assert(typeof searchResult.stdout === 'string', 'search_code returns stdout string');
  assert(searchResult.stdout.includes('src/app.js'), 'search_code output includes file path');
  assert(searchResult.query === 'const x', 'search_code echoes query');

  // Verify the grep command was constructed correctly
  const grepCall = mockCallLog.find((c) => c.command.includes('grep'));
  assert(grepCall, 'search_code uses grep command');
  assert(grepCall.command.includes('--exclude-dir=node_modules'), 'search_code excludes node_modules');
  assert(grepCall.command.includes('--exclude-dir=.git'), 'search_code excludes .git');
  assert(grepCall.command.includes('head -200'), 'search_code caps output with head -200');

  // Test 6: read_file (with truncation guard)
  console.log('\nTest: read_file');
  mockCallLog = [];
  mockOutputs['head -c'] = {
    stdout: 'file content here\nline 2\nline 3',
    stderr: '',
    exitCode: 0,
  };
  const readResult = await dispatchTool('read_file', { path: '/workspace/app.js' }, {});
  assert(readResult.exitCode === 0, 'read_file returns exitCode 0');
  assert(readResult.content.includes('file content here'), 'read_file returns content');
  assert(readResult.path === '/workspace/app.js', 'read_file echoes path');

  // Test 7: delete_file (safety guard)
  console.log('\nTest: delete_file safety');
  const delRootResult = await dispatchTool('delete_file', { path: '/' }, {});
  assert(delRootResult.error !== undefined, 'delete_file refuses "/" path');
  assert(delRootResult.error.includes('Refusing to delete'), 'delete_file returns safety message');

  const delDotResult = await dispatchTool('delete_file', { path: '.' }, {});
  assert(delDotResult.error !== undefined, 'delete_file refuses "." path');

  // Test 8: git_status
  console.log('\nTest: git_status');
  mockCallLog = [];
  mockOutputs['git status'] = {
    stdout: 'On branch main\nnothing to commit, working tree clean',
    stderr: '',
    exitCode: 0,
  };
  const gitResult = await dispatchTool('git_status', {}, {});
  assert(gitResult.exitCode === 0, 'git_status returns exitCode 0');
  assert(gitResult.stdout.includes('On branch main'), 'git_status stdout includes branch info');

  // Test 9: ensure_codespace
  console.log('\nTest: ensure_codespace');
  const ensureResult = await dispatchTool('ensure_codespace', {}, {});
  assert(ensureResult.state === 'Available', 'ensure_codespace reports Available state');
  assert(ensureResult.codespace_name === 'mock-codespace', 'ensure_codespace returns codespace name');

  // Test 10: list_environments (GitHub REST, not exec)
  console.log('\nTest: list_environments');
  const envResult = await dispatchTool('list_environments', {}, {});
  assert(Array.isArray(envResult.machines), 'list_environments returns machines array');
  assert(envResult.machines.length >= 2, 'list_environments returns multiple machines');
  assert(envResult.machines[0].name !== undefined, 'list_environments machine has name field');

  // Test 11: unknown tool
  console.log('\nTest: unknown tool');
  const unknownResult = await dispatchTool('nonexistent_tool', {}, {});
  assert(unknownResult.error !== undefined, 'unknown tool returns error');
  assert(unknownResult.error.includes('Unknown tool'), 'unknown tool error message is clear');

  // Test 12: codespace name caching
  console.log('\nTest: sessionState codespace caching');
  const sessionState = {};
  mockCallLog = [];
  mockOutputs['ls -la'] = {
    stdout: 'drwxr-xr-x 2 root root 4096 .',
    stderr: '',
    exitCode: 0,
  };
  await dispatchTool('list_files', { path: '.' }, sessionState);
  assert(sessionState.codespaceName === 'mock-codespace', 'sessionState caches codespace name after first tool call');

  // Summary
  console.log('\n=== Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) {
    console.log('\n  ❌ Some tests failed!');
    process.exit(1);
  } else {
    console.log('\n  ✅ All tests passed!');
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
