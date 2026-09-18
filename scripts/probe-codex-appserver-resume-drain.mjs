// ContextOS probe 5: does thread/resume drain a pending queued message without any turn/start?
// Probe thread currently has QUEUE_DRAIN_OK_SAY_IT_BACK pending from probe 4.
// Usage: node scripts/probe-codex-appserver-resume-drain.mjs [threadId]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THREAD_ID = process.argv[2] || '01a0b3e2-f844-7940-97de-e8ece300bea3';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SCRIPT_DIR, 'probe-output');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, `probe-resume-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

const t0 = Date.now();
const log = (kind, data) => {
  const rec = { t: Date.now() - t0, kind, ...data };
  fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
  console.log(`[${String(rec.t).padStart(6)}ms] ${kind}`, JSON.stringify(data).slice(0, 240));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'declined by probe' } }) + '\n');
    } else if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    } else if (msg.method) {
      if (!/rateLimits|mcpServer\/startupStatus/.test(msg.method)) {
        log('notif', { method: msg.method, params: JSON.stringify(msg.params).slice(0, 200) });
      }
      for (const fn of notifHandlers) fn(msg);
    }
  }
});
const request = (method, params, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
  pending.set(id, (msg) => { clearTimeout(timer); log('response', { method, ok: !msg.error, body: JSON.stringify(msg.result || msg.error).slice(0, 200) }); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const waitNotif = (method, timeoutMs) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), timeoutMs);
  notifHandlers.push((msg) => { if (msg.method === method) { clearTimeout(timer); resolve(msg.params); } });
});

const run = async () => {
  await request('initialize', { clientInfo: { name: 'contextos-probe-resume-drain', version: '0.1.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');

  const turnStarted = waitNotif('turn/started', 30000);
  await request('thread/resume', { threadId: THREAD_ID, approvalPolicy: 'never', sandbox: 'read-only' });
  log('phase', { n: 1, msg: 'resumed thread with pending queue; waiting 30s for auto-drain (no turn/start issued)' });
  const ts = await turnStarted;
  if (ts) {
    log('phase', { n: 2, msg: 'RESUME DRAINED THE QUEUE: turn auto-started', turnId: ts.turn?.id });
    const done = await waitNotif('turn/completed', 120000);
    const text = (done?.turn?.items || []).filter((i) => i.type === 'agentMessage').map((i) => i.text).join(' ').slice(0, 100);
    log('phase', { n: 2, msg: 'drained turn completed', status: done?.turn?.status, finalText: text });
  } else {
    log('phase', { n: 2, msg: 'resume did NOT drain the queue within 30s (drain triggers only at turn completion)' });
  }
  child.kill();
  log('phase', { n: 3, msg: 'done', log: LOG });
  process.exit(0);
};
run().catch((e) => { log('fatal', { error: e.message }); child.kill(); process.exit(1); });
