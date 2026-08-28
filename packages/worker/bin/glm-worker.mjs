#!/usr/bin/env node
// glm-worker — the delegation worker for the glm-mcp shell family (#90).
//
// glm-task, glm-review and glm-answer used to shell out to bin/claude-glm,
// which ends in `exec claude`: on a machine with Codex or Antigravity but no
// Claude Code, delegation died with "claude: not found" before the model was
// ever reached (#89). This worker drives the Claude Agent SDK instead, which
// vendors its own CLI binary, so nothing on the delegation path needs a host
// CLI installed.
//
// It lives in its own package because the vendored binary is ~199MB: glm-mcp
// is a small stdio server whose consumers mostly never delegate, and it must
// not carry that weight (see verify-worker.mjs rule 5). The bin/glm-worker
// shim at the repo root execs this file.
//
// The command line is the surface the delegation path already spoke, so the
// swap at each call site was one line:
//
//   -p <prompt>              headless prompt (or pass the prompt positionally)
//   --resume <session_id>    continue a prior session
//   --max-turns <n>          stop the agent loop after n turns
//   --permission-mode <m>    passed through to the SDK
//   --allowedTools <t>...    variadic list, as glm-task passes it
//   --add-dir <dir>          extra writable directory (repeatable)
//   --model <m>              model override (default: glm-5.3 via the env)
//   --output-format stream-json --verbose
//
// With --output-format stream-json, stdout is one JSON object per line — the
// SDK's message stream, serialized. Exactly one of those lines is the
// {"type":"result",...} object glm-task parses into the ledger; it is not
// promised to be the last line (the SDK may emit informational messages after
// the result, and this worker serializes whatever arrives), but glm-task finds
// it by scanning every line, so placement does not matter to it. Without it,
// stdout is the final result text alone, which is what glm-review greps a
// VERDICT line out of. Either way stderr carries diagnostics, never results.

import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const USAGE = `usage: glm-worker [-p <prompt>] [options]

  -p <prompt>              headless prompt (or pass the prompt positionally)
  --resume <session_id>    continue a prior session
  --max-turns <n>          stop the agent loop after n turns
  --permission-mode <m>    passed through to the SDK
  --allowedTools <t>...    variadic tool allowlist
  --add-dir <dir>          extra writable directory (repeatable)
  --model <m>              model override (default: glm-5.3 via the env)
  --output-format <fmt>    stream-json for the message stream, text (default)
                           for the final result text alone
  --verbose                accepted for compatibility; the stream always
                           carries every message
  -h, --help               this text`;

// ------------------------------------------------------------- the endpoint
// The same resolution order as bin/claude-glm, with one difference that
// matters: values already in the environment WIN. claude-glm exports its own
// unconditionally, which is right for an interactive launcher and wrong for a
// worker that scripts drive — scripts/verify-worker.mjs points
// ANTHROPIC_BASE_URL at a local stub, and an operator may front z.ai with a
// proxy. Only resolve a key when nobody handed us one.
function resolveZaiKey() {
  if (process.env.ZAI_API_KEY) return process.env.ZAI_API_KEY.trim();
  try {
    const key = readFileSync(join(homedir(), '.config/zai/api-key'), 'utf8').trim();
    if (key) return key;
  } catch { /* no key file */ }
  // the key zcode already stores
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.zcode/v2/config.json'), 'utf8'));
    const key = cfg?.provider?.['builtin:zai-coding-plan']?.options?.apiKey;
    if (key) return key;
  } catch { /* no zcode config */ }
  return '';
}

process.env.ANTHROPIC_BASE_URL ||= 'https://api.z.ai/api/anthropic';
const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || resolveZaiKey();
if (!apiKey) {
  console.error('No z.ai API key. Put one in ~/.config/zai/api-key or export ZAI_API_KEY.');
  process.exit(1);
}
process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
// A key from another Anthropic setup beside the token would route the request
// somewhere the operator did not choose.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

// The same defaults bin/claude-glm applies, each overridable by exporting it
// first. CLAUDE_CONFIG_DIR matters most: sessions are stored under it, so
// glm-answer can only resume a session the worker recorded if both use the
// same isolated config directory rather than the operator's real one.
process.env.CLAUDE_CONFIG_DIR ||= join(homedir(), '.claude-glm');
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ||= 'glm-5.3';
process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ||= 'glm-5.3';
process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||= 'glm-4.7';
process.env.CLAUDE_CODE_SUBAGENT_MODEL ||= 'glm-5.3';
// GLM-5.3 has a 1M context; auto-compact at the default threshold would
// discard context the model could still hold.
process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ||= '1000000';
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ||= '32000';
process.env.API_TIMEOUT_MS ||= '3000000';
// Without this the CLI also issues a title-generation request that is not
// part of the agent loop — a call the delegated task never asked to pay for.
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ||= '1';

// ----------------------------------------------------------------- the args
const args = process.argv.slice(2);
let prompt = '';
let resume = '';
let maxTurns;
let permissionMode = '';
let model = '';
let outputFormat = 'text';
const allowedTools = [];
const addDirs = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const value = () => {
    if (i + 1 >= args.length) { console.error(`glm-worker: ${a} needs a value`); process.exit(2); }
    return args[++i];
  };
  switch (a) {
    case '-p': case '--print': prompt = value(); break;
    case '--resume': resume = value(); break;
    case '--max-turns': maxTurns = Number(value()); break;
    case '--permission-mode': permissionMode = value(); break;
    case '--model': model = value(); break;
    case '--output-format': outputFormat = value(); break;
    case '--add-dir': addDirs.push(value()); break;
    case '--allowedTools': case '--allowed-tools':
      // Variadic, exactly as glm-task passes it: tool names until the next
      // flag. No tool name starts with "-".
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) allowedTools.push(args[++i]);
      if (allowedTools.length === 0) { console.error('glm-worker: --allowedTools needs at least one tool'); process.exit(2); }
      break;
    case '--verbose': break; // the stream always carries every message
    case '-h': case '--help': console.log(USAGE); process.exit(0);
    default:
      if (a.startsWith('-')) { console.error(`glm-worker: unknown option ${a}`); console.error(USAGE); process.exit(2); }
      prompt = prompt ? `${prompt}\n${a}` : a; // positional, as claude accepts
  }
}
if (!prompt) { console.error('glm-worker: no prompt given (-p <prompt>)'); process.exit(2); }

// ---------------------------------------------------------------- the stream
const streamJSON = outputFormat === 'stream-json';
let lastResult = null;

// The host CLI's result line always carried an `error` field; the SDK's does
// not (it has `errors: string[]` on error results instead). glm-task reads
// res.get("error") when a run failed without result text, so the worker
// restores the field rather than porting every consumer.
const withErrorField = (message) => {
  if (!('error' in message)) {
    message.error = message.is_error
      ? (message.errors?.join('\n') || message.result || message.subtype || '')
      : false;
  }
  // `result` too, and for the same reason. The SDK's SDKResultError variants
  // carry `errors` and NO `result` at all — so a native SDK failure produced a
  // record missing the one field glm-task reads for what the agent said, and
  // the row recorded an empty string for a run that had plenty to say. The
  // host CLI's line always had it; consumers were written against that.
  if (!('result' in message)) {
    message.result = message.is_error
      ? (message.errors?.join('\n') || message.subtype || '')
      : '';
  }
  return message;
};

// Exit without losing the last write. glm-task and glm-answer read this
// worker's output through a pipe (`| tee "$log" | trace`; glm-review
// redirects to a file), and process.exit() terminates without draining writes
// still queued for a pipe. A record queued behind stream output that has not
// finished draining is dropped by it — reproduced here: a mid-run death
// behind a busy pipe lost even a 200-byte record 50 times out of 50. So each
// write is completed to the OS first (the callback fires once the bytes are
// in the kernel's buffer, where exit can no longer lose them), and only then
// does the exit land.
const exitFlushed = (code, writes) => Promise.all(
  writes.map(([stream, data]) => new Promise((resolve) => { stream.write(data, () => resolve()); })),
).then(() => process.exit(code));

try {
  for await (const message of query({
    prompt,
    options: {
      cwd: process.cwd(),
      ...(resume ? { resume } : {}),
      ...(Number.isFinite(maxTurns) ? { maxTurns } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(model ? { model } : {}),
      ...(allowedTools.length ? { allowedTools } : {}),
      ...(addDirs.length ? { additionalDirectories: addDirs } : {}),
    },
  })) {
    if (message?.type === 'result') lastResult = withErrorField(message);
    if (streamJSON) process.stdout.write(`${JSON.stringify(message)}\n`);
  }
} catch (err) {
  // The stream died mid-run. Emit a result-shaped line anyway — glm-task
  // records the run from that line, and its absence would leave the ledger
  // row with null turns, null duration and no session, which reads as
  // "nothing happened" rather than "this broke".
  const msg = err?.message ?? String(err);
  const detail = `glm-worker: ${msg}`;
  const writes = [[process.stderr, `${detail}\n`]];
  if (streamJSON) {
    // Same field set as every other result path — `error` included, because
    // glm-task's projection reads it off the result line too.
    writes.push([process.stdout, `${JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: detail, error: detail,
      session_id: resume || lastResult?.session_id || null,
      num_turns: lastResult?.num_turns ?? null, duration_ms: null,
    })}\n`]);
  }
  await exitFlushed(1, writes);
}

if (!lastResult) {
  await exitFlushed(1, [
    [process.stderr, 'glm-worker: the agent loop ended without a result message\n'],
  ]);
}

// Text mode is glm-review's surface: the verdict line it greps for must be
// the last line of prose on stdout, not buried in a JSON object.
if (!streamJSON) {
  const text = typeof lastResult.result === 'string' ? lastResult.result : '';
  // The detail may live in `error` rather than `result`, and glm-review scans
  // this output for capacity language: finding it ends as exit 3, which
  // glm-task records as no_capacity (a wait), while a bare "run failed" ends
  // as exit 2 — parked permanently by the caller. The detail itself, not a
  // generic string, is what must arrive.
  if (lastResult.is_error) console.error(text || lastResult.error || 'glm-worker: the run failed');
  else if (text) process.stdout.write(`${text}\n`);
}

process.exitCode = lastResult.is_error ? 1 : 0;
