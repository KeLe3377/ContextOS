// ContextOS probe 4: queue drain on idle loaded thread (fixed quoting) + lock release on process exit.
// Usage: node scripts/probe-codex-appserver-queue2.mjs [threadId]
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THREAD_ID = process.argv[2] || '01a0b3e2-f844-7940-97de-e8ece300bea3';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SCRIPT_DIR, 'probe-output');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, `probe-q2-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

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

// execFile avoids shell quoting issues entirely
const cli = (args) => new Promise((resolve) => {
  execFile('codex', args, { shell: true }, (err, stdout, stderr) => {
    resolve({ code: err ? err.code ?? 1 : 0, out: (stdout + stderr).trim().slice(0, 300) });
  });
});

const run = async () => {
  const A = makeClient('A-holder');
  await A.request('initialize', { clientInfo: { name: 'contextos-probe-holder2', version: '0.1.0' } });
  A.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  await A.request('thread/resume', { threadId: THREAD_ID, approvalPolicy: 'never', sandbox: 'read-only' });
  log('phase', { n: 1, msg: 'A idle-holds thread' });

  // queue from CLI while A holds the thread idle; watch for auto-drain
  const aQueueNotif = A.waitNotif('thread/queueChanged', 30000).then(() => true).catch(() => false);
  const aTurnStart = A.waitNotif('turn/started', 30000).then((p) => p).catch(() => null);
  const aTurnDone = A.waitNotif('turn/completed', 120000).then((p) => p).catch(() => null);
  const q = await cli(['queue', '--thread', THREAD_ID, '--message', 'QUEUE_DRAIN_OK_SAY_IT_BACK']);
  log('phase', { n: 2, msg: 'queued via CLI (fixed quoting)', exit: q.code, out: q.out.slice(0, 160) });
  const [qc, ts] = await Promise.all([aQueueNotif, aTurnStart]);
  log('phase', { n: 2, msg: 'idle-drain observation', queueChangedNotif: qc, autoTurnStarted: !!ts, turnId: ts?.turn?.id || null });
  if (ts) {
    const td = await aTurnDone;
    const text = (td?.turn?.items || []).filter((i) => i.type === 'agentMessage').map((i) => i.text).join(' ').slice(0, 100);
    log('phase', { n: 2, msg: 'drained turn completed', status: td?.turn?.status, finalText: text });
  }

  // lock release on process exit: kill A, then B tries resume
  A.kill();
  await sleep(2000);
  const B = makeClient('B-takeover');
  await B.request('initialize', { clientInfo: { name: 'contextos-probe-takeover', version: '0.1.0' } });
  B.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  try {
    await B.request('thread/resume', { threadId: THREAD_ID }, 15000);
    log('phase', { n: 3, msg: 'B resume OK after A process exit (stale lock cleaned)' });
  } catch (e) {
    log('phase', { n: 3, msg: 'B resume rejected even after A exit', error: e.message.slice(0, 160) });
  }

  B.kill();
  log('phase', { n: 4, msg: 'done', log: LOG });
  process.exit(0);
};

run().catch((e) => { log('fatal', { error: e.message }); process.exit(1); });
