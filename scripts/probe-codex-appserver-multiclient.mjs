// ContextOS probe 2: multi-client concurrency + steer/interrupt on codex app-server.
// Spawns TWO app-server instances (A simulates ContextOS, B simulates Desktop),
// both resume the same probe thread, then A starts a turn while B watches.
// Usage: node scripts/probe-codex-appserver-multiclient.mjs [threadId]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THREAD_ID = process.argv[2] || '01a0b3e2-f844-7940-97de-e8ece300bea3';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(SCRIPT_DIR, 'probe-output');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, `probe-mc-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

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
    name,
    child,
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

const run = async () => {
  const A = makeClient('A-contextos');
  const B = makeClient('B-desktop-sim');

  for (const c of [A, B]) {
    await c.request('initialize', { clientInfo: { name: `contextos-probe-${c.name}`, version: '0.1.0' } });
    c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  }
  log('phase', { n: 1, msg: 'both clients initialized' });

  // both clients resume the SAME thread
  await A.request('thread/resume', { threadId: THREAD_ID, approvalPolicy: 'never', sandbox: 'read-only' });
  await B.request('thread/resume', { threadId: THREAD_ID, approvalPolicy: 'never', sandbox: 'read-only' });
  log('phase', { n: 2, msg: 'both clients resumed same thread', threadId: THREAD_ID });

  // A starts a turn; does B see it?
  const aDone = A.waitNotif('turn/completed', 120000);
  const bDone = B.waitNotif('turn/completed', 120000).then((p) => ({ seen: true, p })).catch((e) => ({ seen: false, err: e.message }));
  await A.request('turn/start', { threadId: THREAD_ID, input: [{ type: 'text', text: 'Reply with exactly: MULTICLIENT_A_OK' }] });
  const [aRes, bRes] = await Promise.all([aDone, bDone]);
  log('phase', { n: 3, msg: 'A turn finished', aStatus: aRes.turn?.status, bSawTurnCompleted: bRes.seen });
  await sleep(500);

  // B starts a turn; does A see it?
  const aDone2 = A.waitNotif('turn/completed', 120000).then((p) => ({ seen: true, p })).catch((e) => ({ seen: false, err: e.message }));
  const bDone2 = B.waitNotif('turn/completed', 120000);
  await B.request('turn/start', { threadId: THREAD_ID, input: [{ type: 'text', text: 'Reply with exactly: MULTICLIENT_B_OK' }] });
  const [aRes2, bRes2] = await Promise.all([aDone2, bDone2]);
  log('phase', { n: 4, msg: 'B turn finished', bStatus: bRes2.turn?.status, aSawTurnCompleted: aRes2.seen });
  await sleep(500);

  // turn/steer: start a slow turn on A, steer it mid-flight
  const steerDone = A.waitNotif('turn/completed', 120000);
  const slowTurn = await A.request('turn/start', { threadId: THREAD_ID, input: [{ type: 'text', text: 'Write a 150-word poem about autumn rain.' }] });
  const slowTurnId = slowTurn.turn?.id;
  await sleep(1500);
  try {
    await A.request('turn/steer', {
      threadId: THREAD_ID,
      expectedTurnId: slowTurnId,
      input: [{ type: 'text', text: 'Ignore the poem. Reply with exactly: STEER_OK' }],
    }, 15000);
    log('phase', { n: 5, msg: 'steer accepted' });
  } catch (e) {
    log('phase', { n: 5, msg: 'steer rejected', error: e.message.slice(0, 200) });
  }
  const steerRes = await steerDone;
  const steerText = (steerRes.turn?.items || []).filter((i) => i.type === 'agentMessage').map((i) => i.text).join(' ').slice(0, 120);
  log('phase', { n: 5, msg: 'steer turn completed', status: steerRes.turn?.status, finalText: steerText });
  await sleep(500);

  // turn/interrupt: start a slow turn on A, interrupt it
  const intDone = A.waitNotif('turn/completed', 60000);
  const slowTurn2 = await A.request('turn/start', { threadId: THREAD_ID, input: [{ type: 'text', text: 'Write a 300-word essay about the history of shipping ports.' }] });
  await sleep(1500);
  try {
    await A.request('turn/interrupt', { threadId: THREAD_ID, turnId: slowTurn2.turn?.id }, 15000);
    log('phase', { n: 6, msg: 'interrupt accepted' });
  } catch (e) {
    log('phase', { n: 6, msg: 'interrupt rejected', error: e.message.slice(0, 200) });
  }
  const intRes = await intDone;
  log('phase', { n: 6, msg: 'interrupted turn completed', status: intRes.turn?.status });

  // final integrity check: B reads the thread, counts turns
  const read = await B.request('thread/read', { threadId: THREAD_ID, includeTurns: false });
  log('phase', { n: 7, msg: 'final read by B', status: read.thread?.status, updatedAt: read.thread?.updatedAt });

  A.kill(); B.kill();
  log('phase', { n: 8, msg: 'done', log: LOG });
  process.exit(0);
};

run().catch((e) => { log('fatal', { error: e.message }); process.exit(1); });
