// Codex (headless) as an engine for background agents: `codex exec --json` runs the model loop, and our tools reach it
// as a stdio MCP server, so every file, command and URL still goes through safety.mjs and the Allow prompts, and plan
// and finish work as on the other routes. Codex's own shell, web search and image viewer are off and its sandbox is
// read-only (a maker or organizer with actions allowed may write in its own folder only), so it has no way around them. CodexAgent has the surface agentrun.mjs uses of gg-agent's Agent.
//
// The MCP server Codex starts is a small relay (`node -e RELAY <socket>`): it pipes Codex's stdio to a local socket
// this worker listens on, where the tools run (createToolBridge, shared with the Claude Code route).
// Flags, events and config keys: codex-rs/exec/src/cli.rs, sdk/typescript/src/{events,items,exec}.ts and
// codex-rs/config/src/mcp_types.rs at rust-v0.155.1.
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AgentStream } from '@kenkaiiii/gg-agent';
import { createToolBridge } from './claudecode.mjs';

export const MCP_SERVER = 'jarvis';
// The models offered when this Codex can't say which ones the account has (codex-rs/models-manager/models.json,
// visibility "list"), newest first. gpt-5.5 is left out: it's listed but not every account can use it.
export const CODEX_MODELS = [
  { id: 'gpt-6-astra', name: 'GPT-6-Astra' }, { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }, { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
];
/** The models to offer: the account's own catalog from the probe, else CODEX_MODELS. */
export const codexModels = (state) => (state?.models?.length ? state.models : CODEX_MODELS);
const STDERR_TAIL_CHARS = 4_000;
const KILL_GRACE_MS = 3_000;
// Codex built-ins that would reach files, commands, the web or other apps without safety.mjs. apply_patch has no
// feature key at rust-v0.155.1 (apply_patch_freeform is a removed, ignored flag; the tool comes with the model's
// apply_patch_tool_type), so its writes are left to the sandbox (read-only, or confined to the agent's folder).
const FEATURES_OFF = ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'apps', 'plugins', 'browser_use', 'computer_use', 'image_generation', 'tool_search_always_defer_mcp_tools'];
// CommonJS for `node -e`; argv's last entry is the socket.
const RELAY = 'const s=require("net").connect(process.argv.at(-1));process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",()=>process.exit(1));s.on("close",()=>process.exit(0))';

const NOT_FOUND = 'Codex CLI not found. Install it: npm i -g @openai/codex';
const SIGNED_OUT = 'Codex is signed out. Run codex login in a terminal.';

// Newline-delimited JSON from a stream's chunks: onMessage gets each line that parses, blank or broken lines are skipped.
const ndjson = (onMessage) => {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      onMessage(m);
    }
  };
};

const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(',')}]` : typeof v === 'string' ? JSON.stringify(v) : String(v));
const run = (bin, args, timeout = 10_000) => new Promise((resolve) => {
  execFile(bin, args, { timeout, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});

/** The Codex CLI to run: { bin, args } (args go before codex's own). On Windows npm's codex.cmd can't be spawned
 *  without a shell, so its script is run with this Node instead. */
export function resolveCodex(env = process.env) {
  if (process.platform !== 'win32') return { bin: 'codex', args: [] };
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    if (!fs.existsSync(path.join(dir, 'codex.cmd'))) continue;
    const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) return { bin: process.execPath, args: [js] };
  }
  return { bin: 'codex.exe', args: [] };
}

/** Whether Codex can run here: { ok: true, version } or { ok: false, reason } (shown on the disabled option). */
export async function probeCodex({ bin, args = [] } = resolveCodex()) {
  const v = await run(bin, [...args, '--version']);
  if (v.error?.code === 'ENOENT' || (v.error && !v.stdout)) return { ok: false, reason: NOT_FOUND };
  const s = await run(bin, [...args, 'login', 'status']);
  if (s.error) return { ok: false, reason: SIGNED_OUT };
  const models = catalog(await run(bin, [...args, 'debug', 'models'], 20_000));
  return { ok: true, version: v.stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? v.stdout.trim(), ...(models.length ? { models } : {}) };
}
// `codex debug models`: the account's model catalog (refreshed from the server), the ones it lists, in its order.
function catalog({ error, stdout }) {
  if (error) return [];
  let list; try { list = JSON.parse(stdout).models; } catch { return []; }
  return (Array.isArray(list) ? list : []).filter((m) => m?.visibility === 'list' && typeof m.slug === 'string')
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9)).map((m) => ({ id: m.slug, name: String(m.display_name || m.slug) }));
}

/** A Codex failure in words that say what to do. */
export function codexError(text, model) {
  const t = String(text ?? '').trim();
  if (/model.{0,80}(not supported|isn't supported|not available|does not exist)|unknown model|model_not_found/i.test(t)) {
    return `Codex can't use the model ${model} on this account. Pick another Codex model on the Subagents page.`;
  }
  if (/not logged in|not signed in|codex login|401|unauthori[sz]ed/i.test(t)) return SIGNED_OUT;
  return `Codex stopped: ${t.slice(-300) || 'it exited without a reason'}`;
}

// write: Codex's own file edits (apply_patch) may land in its folder (-C) and nowhere else: not /tmp, not $TMPDIR,
// no extra roots, no network. Everything else still goes through our tools and safety.mjs.
const CONFINED = ['exclude_slash_tmp=true', 'exclude_tmpdir_env_var=true', 'network_access=false', 'writable_roots=[]'];
/** The arguments for one `codex exec` turn: a new thread, or `resume` of the last one. write: a workspace-write
 *  sandbox confined to cwd (a type that makes files, with actions allowed); otherwise read-only. */
export function codexArgs({ model, cwd, mcp, threadId, write = false }) {
  return [
    'exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', write ? 'workspace-write' : 'read-only', '-C', cwd,
    ...(write ? CONFINED.flatMap((c) => ['-c', `sandbox_workspace_write.${c}`]) : []),
    ...(model ? ['-m', model] : []),
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    ...FEATURES_OFF.flatMap((f) => ['-c', `features.${f}=false`]),
    '-c', `mcp_servers.${MCP_SERVER}={command=${toml(mcp.command)},args=${toml(mcp.args)},required=true,default_tools_approval_mode="approve",startup_timeout_sec=30,tool_timeout_sec=${mcp.timeoutSec}}`,
    ...(threadId ? ['resume', threadId] : []), '-',
  ];
}

// Our tools on a local socket, one MCP session per connection (the relay Codex starts).
async function listenBridge(bridge) {
  let dir = null, where;
  if (process.platform === 'win32') where = `\\\\.\\pipe\\jarvis-codex-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  else { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-codex-')); where = path.join(dir, 'mcp.sock'); }
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    const transport = {
      send: async (m) => { if (!sock.destroyed) sock.write(`${JSON.stringify(m)}\n`); },
      start: async () => {},
    };
    sock.setEncoding('utf8');
    sock.on('data', ndjson((m) => transport.onmessage?.(m)));
    sock.on('close', () => { sockets.delete(sock); transport.onclose?.(); });
    sock.on('error', () => {});
    void bridge.config.instance.connect(transport);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(where, resolve); });
  return {
    where,
    close() {
      for (const s of sockets) s.destroy();
      server.close();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Every Codex process this worker started: they go when it goes (stopped, or the sidecar quit).
const children = new Set();
const killAll = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch {} } };
let hooked = false;
function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on('exit', killAll);
  process.once('SIGTERM', () => { killAll(); process.exit(143); });
}

// A queue the turn's two sources (Codex's events, our tool calls) push into and the stream reads from.
function eventQueue() {
  const items = [];
  let wake = null, closed = false;
  return {
    push(e) { items.push(e); wake?.(); },
    close() { closed = true; wake?.(); },
    async *drain() {
      for (;;) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise((r) => { wake = r; });
        wake = null;
      }
    },
  };
}

/** Codex events → gg-agent events. Tool calls to our server are reported by the bridge itself. */
// Codex's own command, file-change and web-search items are only shown as tool tags here; nothing here runs them.
const TOOL_OF_ITEM = { command_execution: 'run_command', file_change: 'write_file', web_search: 'web_search' };
function mapEvent(e, push) {
  if (e.type === 'item.started' && TOOL_OF_ITEM[e.item?.type]) push({ type: 'tool_call_start', toolCallId: e.item.id, name: TOOL_OF_ITEM[e.item.type], args: {} });
  else if (e.type === 'item.completed' && TOOL_OF_ITEM[e.item?.type]) push({ type: 'tool_call_end', toolCallId: e.item.id, result: '', isError: e.item.status === 'failed' });
  else if (e.type?.startsWith('item.')) push({ type: 'text_delta', text: e.item?.type === 'agent_message' ? String(e.item.text ?? '') : '' });
  else if (e.type === 'turn.completed') {
    const u = e.usage ?? {}, cached = u.cached_input_tokens ?? 0;
    push({ type: 'turn_end', usage: { inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached), outputTokens: u.output_tokens ?? 0, ...(cached ? { cacheRead: cached } : {}) } });
  }
}

/** prompt(content) → AgentStream. Options: model, system, tools, signal, cwd, write (codexArgs; a function is read
 *  again for every turn, so turning Allow actions off reaches the next one), codex ({ bin, args }). */
export class CodexAgent {
  #running = false;
  #threadId = null;
  constructor(options) { this.options = options; }
  get running() { return this.#running; }
  steer() {} // no mid-run steering: agentrun queues it as the next turn
  prompt(content) {
    if (this.#running) throw new Error('Agent is already running');
    this.#running = true;
    return new AgentStream(this.#run(content), () => { this.#running = false; });
  }
  async *#run(content) {
    const o = this.options, q = eventQueue();
    const text = typeof content === 'string' ? content : (content ?? []).map((p) => p?.text ?? '').filter(Boolean).join('\n');
    const input = this.#threadId ? text : `${o.system ? `${o.system}\n\n` : ''}${text}`;
    const bridge = createToolBridge({ tools: o.tools, signal: () => o.signal, onEvent: (e) => q.push(e) });
    const sock = await listenBridge(bridge);
    const timeoutSec = Math.ceil(bridge.config.timeout / 1000);
    const { bin, args: pre = [] } = o.codex ?? resolveCodex();
    const args = [...pre, ...codexArgs({ model: o.model, cwd: o.cwd, write: !!(typeof o.write === 'function' ? o.write() : o.write), threadId: this.#threadId, mcp: { command: process.execPath, args: ['-e', RELAY, sock.where], timeoutSec } })];
    hookExit();
    const child = spawn(bin, args, { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    let stderr = '', failure = null, lastError = '', exit = null;
    const fail = (msg) => { failure ??= codexError(msg, o.model); };
    child.on('error', (e) => fail(e.code === 'ENOENT' ? NOT_FOUND : String(e.message)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-STDERR_TAIL_CHARS); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', ndjson((e) => {
      if (e.type === 'thread.started' && e.thread_id) this.#threadId = e.thread_id;
      else if (e.type === 'error') lastError = String(e.message ?? '');
      else if (e.type === 'turn.failed') fail(e.error?.message ?? lastError);
      mapEvent(e, q.push);
    }));
    child.on('close', (code, sig) => { exit = { code, sig }; children.delete(child); q.close(); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const abort = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref(); };
    o.signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const e of q.drain()) yield e;
    } finally {
      o.signal?.removeEventListener('abort', abort);
      if (!exit) abort();
      sock.close();
    }
    if (o.signal?.aborted) return {};
    if (!failure && exit?.code !== 0) fail(lastError || stderr || `exit ${exit?.code ?? exit?.sig}`);
    if (failure) yield { type: 'error', error: new Error(failure) };
    return {};
  }
}
