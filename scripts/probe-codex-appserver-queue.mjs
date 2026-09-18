// ContextOS probe 3: writer-lock semantics + queue drain on an IDLE loaded thread.
// A = app-server holding the thread (simulates Desktop with thread open).
// B = second app-server (read attempts). CLI = codex queue (simulates ContextOS input path).
// Usage: node scripts/probe-codex-appserver-queue.mjs [threadId]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THREAD_ID = process.argv[2] || '01a0b3e2-f844-7940-97de-e8ece300bea3';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SCRIPT_DIR, 'probe-output');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, `probe-queue-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

const t0 = Date.now();
const log = (kind, data) => {
  const rec = { t: Date.now() - t0, kind, ...data };
  fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
  console.log(`[${String(rec.t).padStart(6)}ms] ${kind}`, JSON.stringify(data).slice(0, 240));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(name) {
  const child = spawn('codex', ['app-server'], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  const notifHandlers = [];
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && msg.method !== undefined) {
        log('server-request', { client: name, method: msg.method });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'declined by probe' } }) + '\n');
      } else if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p(msg); }
      } else if (msg.method) {
        if (!/rateLimits|mcpServer\/startupStatus/.test(msg.method)) {
          log('notif', { client: name, method: msg.method, params: JSON.stringify(msg.params).slice(0, 200) });
        }
        for (const fn of notifHandlers) fn(msg);
      }
    }
  });
  return {
    name, child,
    request(method, params, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} timeout ${method}`)); }, timeoutMs);
        pending.set(id, (msg) => { clearTimeout(timer); log('response', { client: name, method, ok: !msg.error, body: JSON.stringify(msg.result || msg.error).slice(0, 300) }); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    waitNotif(method, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name} timeout waiting ${method}`)), timeoutMs);
        notifHandlers.push((msg) => { if (msg.method === method) { clearTimeout(timer); resolve(msg.params); } });
      });
    },
    kill() { child.kill(); },
  };
}

const cli = (args) => new Promise((resolve) => {
  const p = spawn('codex', args, { shell: true });
  let out = '';
  p.stdout?.on('data', (d) => { out += d; });
  p.stderr?.on('data', (d) => { out += d; });
  p.on('exit', (code) => resolve({ code, out: out.trim().slice(0, 300) }));
});

const run = async () => {
  const A = makeClient('A-holder');
  await A.request('initialize', { clientInfo: { name: 'contextos-probe-holder', version: '0.1.0' } });
  A.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  await A.request('thread/resume', { threadId: THREAD_ID, approvalPolicy: 'never', sandbox: 'read-only' });
  log('phase', { n: 1, msg: 'A holds thread (idle, no turn running)' });

  // B: read-only attempts while A holds the writer lock
  const B = makeClient('B-reader');
  await B.request('initialize', { clientInfo: { name: 'contextos-probe-reader', version: '0.1.0' } });
  B.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  try {
    const r = await B.request('thread/read', { threadId: THREAD_ID, includeTurns: false });
    log('phase', { n: 2, msg: 'B thread/read OK while A holds lock', status: r.thread?.status, updatedAt: r.thread?.updatedAt });
  } catch (e) {
    log('phase', { n: 2, msg: 'B thread/read FAILED', error: e.message.slice(0, 200) });
  }
  try {
    await B.request('thread/resume', { threadId: THREAD_ID });
    log('phase', { n: 2, msg: 'B thread/resume unexpectedly OK' });
  } catch (e) {
    log('phase', { n: 2, msg: 'B thread/resume rejected as expected', error: e.message.slice(0, 160) });
  }
  const lst = await B.request('thread/list', { limit: 5 });
  const mine = (lst.data || []).find((t) => t.id === THREAD_ID);
  log('phase', { n: 2, msg: 'B thread/list view of locked thread', status: mine?.status, source: mine?.source });

  // Queue drain on idle loaded thread: queue from CLI, watch A for automatic turn
  const aQueueNotif = A.waitNotif('thread/queueChanged', 45000).then(() => 'queueChanged').catch(() => 'no-queueChanged');
  const aTurnStart = A.waitNotif('turn/started', 45000).then((p) => p).catch(() => null);
  const aTurnDone = A.waitNotif('turn/completed', 120000).then((p) => p).catch(() => null);
  const q = await cli(['queue', '--thread', THREAD_ID, '--message', 'Reply with exactly: QUEUE_DRAIN_OK']);
  log('phase', { n: 3, msg: 'queued via CLI while A idle-holds thread', exit: q.code, out: q.out.slice(0, 160) });
  const [qc, ts] = await Promise.all([aQueueNotif, aTurnStart]);
  log('phase', { n: 3, msg: 'A reaction to queued message', queueNotif: qc, autoTurnStarted: !!ts, turnId: ts?.turn?.id || null });
  if (ts) {
    const td = await aTurnDone;
    const text = (td?.turn?.items || []).filter((i) => i.type === 'agentMessage').map((i) => i.text).join(' ').slice(0, 100);
    log('phase', { n: 3, msg: 'queue-drained turn completed', status: td?.turn?.status, finalText: text });
  }

  // Lock release: A unsubscribes, B retries resume
  try {
    await A.request('thread/unsubscribe', { threadId: THREAD_ID }, 15000);
    log('phase', { n: 4, msg: 'A unsubscribed' });
  } catch (e) {
    log('phase', { n: 4, msg: 'A unsubscribe failed', error: e.message.slice(0, 160) });
  }
  await sleep(1000);
  try {
    await B.request('thread/resume', { threadId: THREAD_ID }, 15000);
    log('phase', { n: 4, msg: 'B resume OK after A unsubscribe (lock released)' });
  } catch (e) {
    log('phase', { n: 4, msg: 'B resume still rejected after A unsubscribe', error: e.message.slice(0, 160) });
  }

  A.kill(); B.kill();
  log('phase', { n: 5, msg: 'done', log: LOG });
  process.exit(0);
};

run().catch((e) => { log('fatal', { error: e.message }); process.exit(1); });
