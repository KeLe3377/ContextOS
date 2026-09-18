// ContextOS probe: codex app-server stdio JSON-RPC capabilities.
// Read-only for existing threads; writes ONLY to a brand-new probe thread in a temp cwd.
// Output logs: scripts/probe-output/probe-<timestamp>.jsonl
// Usage: node scripts/probe-codex-appserver.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SCRIPT_DIR, 'probe-output');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const PROBE_CWD = path.join(os.tmpdir(), 'codex-probe-cwd');
fs.mkdirSync(PROBE_CWD, { recursive: true });

const t0 = Date.now();
const log = (kind, data) => {
  const rec = { t: Date.now() - t0, kind, ...data };
  fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
  console.log(`[${String(rec.t).padStart(6)}ms] ${kind}`, typeof data === 'object' ? JSON.stringify(data).slice(0, 220) : data);
};

const child = spawn('codex', ['app-server'], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => log('stderr', { text: String(d).slice(0, 300) }));

let buf = '';
const pending = new Map();
let nextId = 1;
const notifHandlers = [];
const onNotif = (fn) => notifHandlers.push(fn);

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('badline', { line: line.slice(0, 200) }); continue; }
    if (msg.id !== undefined && msg.method !== undefined) {
      // server -> client request (approval etc.): decline everything
      log('server-request', { id: msg.id, method: msg.method });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'declined by probe' } }) + '\n');
    } else if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    } else if (msg.method) {
      log('notif', { method: msg.method, params: JSON.stringify(msg.params).slice(0, 300) });
      for (const fn of notifHandlers) fn(msg);
    }
  }
});

const request = (method, params, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
  pending.set(id, (msg) => { clearTimeout(timer); log('response', { id, method, ok: !msg.error, body: JSON.stringify(msg.result || msg.error).slice(0, 400) }); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

const waitNotif = (method, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting ${method}`)), timeoutMs);
  onNotif((msg) => { if (msg.method === method) { clearTimeout(timer); resolve(msg.params); } });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- rollout tail watcher: size + last-byte completeness at 100ms ---
function watchRollout(filePath, tag) {
  let lastSize = -1;
  const timer = setInterval(() => {
    try {
      const st = fs.statSync(filePath);
      if (st.size !== lastSize) {
        const fd = fs.openSync(filePath, 'r');
        const b = Buffer.alloc(1);
        let lastByte = null;
        if (st.size > 0) { fs.readSync(fd, b, 0, 1, st.size - 1); lastByte = b[0]; }
        fs.closeSync(fd);
        log('rollout-append', { tag, size: st.size, delta: lastSize < 0 ? st.size : st.size - lastSize, tailComplete: lastByte === 10 });
        lastSize = st.size;
      }
    } catch { /* not created yet */ }
  }, 100);
  return () => clearInterval(timer);
}

const run = async () => {
  // 1. initialize
  const init = await request('initialize', { clientInfo: { name: 'contextos-probe', version: '0.1.0' } });
  log('phase', { n: 1, msg: 'initialized', server: JSON.stringify(init).slice(0, 300) });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');

  // 2. thread/list filtered by D:\project (read-only)
  const list = await request('thread/list', { cwd: 'D:\\project', limit: 10 });
  for (const th of list.data || []) {
    log('thread-list-item', { id: th.id, cwd: th.cwd, status: th.status, source: th.source, name: th.name, updatedAt: th.updatedAt, path: th.path });
  }

  // 3. thread/start in temp cwd
  const started = await request('thread/start', { cwd: PROBE_CWD, approvalPolicy: 'never', sandbox: 'read-only' });
  const thread = started.thread;
  log('phase', { n: 3, msg: 'thread started', id: thread.id, path: thread.path, status: thread.status });
  const stopWatch = watchRollout(thread.path, 'live');

  // 4. turn/start with trivial prompt
  const turnDone1 = waitNotif('turn/completed', 120000);
  const turn = await request('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'Reply with exactly: PROBE_APPSERVER_OK' }],
  }, 20000);
  log('phase', { n: 4, msg: 'turn started', turnId: turn.turn?.id, status: turn.turn?.status });
  const done1 = await turnDone1;
  log('phase', { n: 4, msg: 'turn completed', status: done1.turn?.status, error: done1.turn?.error || null });
  await sleep(500); // let final flush land
  stopWatch();

  // 5. rollout tail content check
  const st1 = fs.statSync(thread.path);
  const fd = fs.openSync(thread.path, 'r');
  const tailBuf = Buffer.alloc(Math.min(4096, st1.size));
  fs.readSync(fd, tailBuf, 0, tailBuf.length, Math.max(0, st1.size - tailBuf.length));
  fs.closeSync(fd);
  const tailLines = tailBuf.toString('utf8').split('\n').filter(Boolean);
  log('phase', { n: 5, msg: 'rollout tail', size: st1.size, lastLineTypes: tailLines.slice(-4).map((l) => { try { return JSON.parse(l).type; } catch { return 'malformed'; } }) });

  // 6. queue semantics: queue a message via CLI, then turn/start and watch consumption
  await new Promise((resolve, reject) => {
    const q = spawn('codex', ['queue', '--thread', thread.id, '--message', 'QUEUE_MARKER_CONTEXTOS_2'], { shell: true });
    q.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('queue exit ' + code))));
    q.stdout?.on('data', (d) => log('queue-cli', { out: String(d).slice(0, 200) }));
    q.stderr?.on('data', (d) => log('queue-cli-err', { out: String(d).slice(0, 200) }));
  });
  await sleep(300);
  log('phase', { n: 6, msg: 'queued via CLI' });

  const turnDone2 = waitNotif('turn/completed', 120000);
  await request('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'Reply with exactly: PROBE_TURN2_OK' }],
  }, 20000);
  const done2 = await turnDone2;
  log('phase', { n: 6, msg: 'turn2 completed', status: done2.turn?.status });

  // 7. did turn2 consume the queue? read final items via thread/read
  const read = await request('thread/read', { threadId: thread.id, includeTurns: true });
  const userTexts = [];
  for (const tn of read.thread?.turns || []) {
    for (const it of tn.items || []) {
      if (it.type === 'userMessage' || it.type === 'user_message') {
        userTexts.push(JSON.stringify(it).slice(0, 200));
      }
    }
  }
  log('phase', { n: 7, msg: 'thread user messages', count: (read.thread?.turns || []).length, userTexts });

  child.kill();
  log('phase', { n: 8, msg: 'done', log: LOG });
  process.exit(0);
};

run().catch((e) => { log('fatal', { error: e.message }); child.kill(); process.exit(1); });
