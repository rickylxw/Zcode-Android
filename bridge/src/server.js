import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as appserver from './appserver.js';
import { ensureCliConfig, lanAddresses, loadBridgeConfig, paths } from './config.js';
import * as archive from './archive.js';
import * as bqueue from './bqueue.js';
import { initialRunningSet, LogTail } from './logtail.js';
import { listModels } from './selection.js';
import * as store from './store.js';
import { getJob, pendingNewJobs, runTurn, runningJobForSession, stopJob } from './zcode.js';

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_VERSION = '0.3.0';
const startedAt = Date.now();

const cfg = loadBridgeConfig(bridgeRoot);
const bootInfo = ensureCliConfig();

// ---------- 回合引擎 ----------
// appserver = 常驻 app-server 子进程，ZCode Protocol 驱动（字符级流式、共享运行时，见
// docs/appserver-reverse-progress.md）；headless = 每回合 spawn 无头 CLI（回退路径）。
// 通过 bridge.config.json 的 "engine" 字段或环境变量 BRIDGE_ENGINE 切换。
const ENGINE = (process.env.BRIDGE_ENGINE || cfg.engine || 'appserver').toLowerCase() === 'headless' ? 'headless' : 'appserver';

const jobById = (jobId) => (ENGINE === 'appserver' ? appserver.appServerJob(jobId) : getJob(jobId));
const jobForSession = (sid) => (ENGINE === 'appserver' ? appserver.appServerRunningForSession(sid) : runningJobForSession(sid));
const pendingJobs = () => (ENGINE === 'appserver' ? appserver.appServerPendingNewJobs() : pendingNewJobs());
const stopById = (jobId) => (ENGINE === 'appserver' ? appserver.appServerStop(jobId) : stopJob(jobId));

function startTurn(opts) {
  if (ENGINE !== 'appserver') return runTurn(opts);
  return appserver.appServerTurn({ ...opts, onEvent: onAppServerEvent });
}

// ---------- 运行中判定（真源：ZCode 运行日志的 turn 事件） ----------
// 覆盖任意端发起的回合（桌面/手机/其他客户端），桥接重启时从当日日志回放种子。
// 被强杀的回合没有 turn.completed 事件 → 记录可能卡住，
// 因此记录最后活动时间，由 reaper 定期回收空闲超 8 分钟的条目。
const RUNNING_IDLE_MS = 8 * 60 * 1000;
const runningSessions = new Map(); // sessionId -> 最后一次相关日志事件的时间戳
for (const sid of initialRunningSet()) runningSessions.set(sid, Date.now());

function mergedQueue(sessionId) {
  const phone = bqueue.list(sessionId).map((x) => ({ id: x.id, source: 'phone', text: x.text, timeCreated: x.ts }));
  const desktop = store.queuedInputs(sessionId).map((x) => ({ ...x, source: 'desktop' }));
  return [...phone, ...desktop];
}

/** 手机队列自动投递：会话空闲时逐条用无头 --resume 真正发送 */
const delivering = new Set();

async function tryDeliverQueued() {
  const entries = Object.entries(bqueue.allQueued()).filter(([, items]) => items.length > 0);
  if (entries.length) console.log('[queue-deliver] 扫描：', entries.map(([sid, items]) => sid.slice(5, 13) + '×' + items.length).join(', '));
  for (const [sid, items] of entries) {
    if (delivering.has(sid)) continue;
    if (runningSessions.has(sid) || jobForSession(sid)) {
      console.log(`[queue-deliver] 跳过运行中会话: ${sid.slice(5, 13)} (running=${runningSessions.has(sid)}, job=${jobForSession(sid)?.id ?? 'none'})`);
      continue;
    }
    const session = store.getSession(sid);
    if (!session) {
      bqueue.clear(sid);
      continue;
    }
    const item = items[0];
    delivering.add(sid);
    bqueue.remove(sid, item.id);
    broadcast({ type: 'session_updated', sessionId: sid });
    broadcastStatus();
    try {
      await startTurn({
        sessionId: sid,
        directory: session.directory,
        prompt: item.text,
        mode: 'yolo',
        onJob: (job) => {
          if (job.sessionId) {
            sessionToJob.set(job.sessionId, job.id);
            markRunning(job.sessionId); // 注意：必须用 markRunning；runningSessions 是 Map，
            // 这里曾经的 .add 会同步抛 TypeError，且发生在回合注册进 turns 表之后，
            // 导致回合对象永久泄漏、队列从此全部被 job 门禁拦截（投递假死）
          }
        },
      });
    } catch (e) {
      console.error('[queue-deliver] 投递失败，已放回队首:', e?.message ?? e);
      bqueue.addFront(sid, item.text, item.ts); // 失败放回队首
      broadcast({ type: 'session_updated', sessionId: sid });
    } finally {
      delivering.delete(sid);
      broadcast({ type: 'session_updated', sessionId: sid });
      broadcastStatus();
      setTimeout(tryDeliverQueued, 2000); // 队列里还有下一条就继续
    }
    return; // 一次投递一条
  }
}

function isRunning(sessionId) {
  return runningSessions.has(sessionId) || jobForSession(sessionId) != null;
}

function markRunning(sessionId, ts = Date.now()) {
  const isNew = !runningSessions.has(sessionId);
  runningSessions.set(sessionId, ts);
  if (isNew) broadcastStatus();
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, ts] of runningSessions) {
    if (now - ts > RUNNING_IDLE_MS) {
      runningSessions.delete(sid);
      broadcast({ type: 'session_updated', sessionId: sid }); // 让手机刷新掉「运行中」
      broadcastStatus();
    }
  }
}, 30_000).unref?.();

// 手机队列投递触发：周期扫描空闲会话的待发送队列
setInterval(() => {
  console.log('[queue-deliver] tick');
  tryDeliverQueued().catch((e) => console.error('[queue-deliver] 错误:', e?.message));
}, 30_000).unref?.();

// ---------- 进度事件路由 ----------
// LogTail 事件只有 sessionId。桥接自己发起的「新会话」回合在结果出来前不知道 sess_id，
// 所以首条未知会话的进度事件到达时，用「目录匹配 + 创建时间晚于 job 启动」反查 SQLite 绑定。
const jobSubscribers = new Map(); // jobId -> Set<ws>
const sessionSubscribers = new Map(); // sessionId -> Set<ws>
const sessionToJob = new Map(); // sessionId -> jobId（绑定后的路由表）
const streamPumps = new Map(); // jobId -> 轮询定时器（泵自检 job 存活性，结束自动清除）

// ---------- mini 桌面看板（/mini） ----------
// mini 页面的 WS 连接带 client=mini 标记，发 watch 后订阅全局状态：所有运行中会话的
// 进度/流式快照 + 手机连接状态。其余 WS 客户端视为手机端，用于「手机在线」指示。
const watchers = new Set();
let phoneLastSeenAt = null; // 最近一次手机端 WS 断开的时刻

// 每会话最近事件环形缓冲：看板详情时间线的数据源（watcher 中途加入也有历史可看）
const recentEvents = new Map(); // sessionId -> event[]
function recordEvent(sessionId, event) {
  let arr = recentEvents.get(sessionId);
  if (!arr) {
    arr = [];
    recentEvents.set(sessionId, arr);
    if (recentEvents.size > 200) recentEvents.delete(recentEvents.keys().next().value);
  }
  arr.push(event);
  if (arr.length > 30) arr.shift();
}

function phoneCount() {
  let n = 0;
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN && ws.clientKind !== 'mini') n++;
  return n;
}

function statusSnapshot() {
  const running = [];
  for (const [sid, ts] of runningSessions) {
    let s = null;
    try {
      s = store.getSession(sid);
    } catch {}
    // 桥接自己发起的回合有精确 startedAt；桌面端驱动的回合退化为最近一次事件时间
    const job = jobForSession(sid);
    running.push({
      sessionId: sid,
      title: s?.title ?? null,
      directory: s?.directory ?? null,
      jobId: job?.id ?? sessionToJob.get(sid) ?? null,
      mode: job?.mode ?? null,
      model: job?.model ?? null,
      prompt: job?.prompt ? String(job.prompt).slice(0, 200) : null,
      since: job?.startedAt ?? ts,
      events: recentEvents.get(sid) ?? [],
      queueItems: mergedQueue(sid).slice(0, 10).map((q) => ({ source: q.source, text: String(q.text).slice(0, 160) })),
    });
  }
  for (const job of pendingJobs()) {
    // 尚未绑定 sessionId 的桥接新任务（create 完成前）也列为运行中
    running.push({
      sessionId: null,
      title: null,
      directory: job.directory,
      jobId: job.id,
      mode: job.mode ?? null,
      model: job.model ?? null,
      prompt: job.prompt ? String(job.prompt).slice(0, 200) : null,
      since: job.startedAt,
      events: [],
      queueItems: [],
    });
  }
  const queued = {};
  for (const [sid, items] of Object.entries(bqueue.allQueued())) queued[sid] = (queued[sid] ?? 0) + items.length;
  for (const [sid, n] of store.queuedCounts()) queued[sid] = (queued[sid] ?? 0) + n;
  return {
    bridge: { version: BRIDGE_VERSION, engine: ENGINE, startedAt },
    phone: { connected: phoneCount(), lastSeenAt: phoneLastSeenAt },
    running,
    queued,
  };
}

function broadcastStatus() {
  const s = JSON.stringify({ type: 'status', ...statusSnapshot() });
  for (const ws of watchers) {
    if (ws.readyState === ws.OPEN) ws.send(s);
  }
}

function progressTargets(sessionId, jobId) {
  const targets = new Set(watchers);
  for (const ws of sessionSubscribers.get(sessionId) ?? []) targets.add(ws);
  if (jobId) for (const ws of jobSubscribers.get(jobId) ?? []) targets.add(ws);
  return targets;
}

const logTail = new LogTail(onLogEvent);

function onLogEvent(sessionId, event) {
  recordEvent(sessionId, event);
  // 运行中集合随日志事件实时维护（任何事件都刷新活跃时间）
  markRunning(sessionId, Date.parse(event.timestamp) || Date.now());
  if (event.kind === 'turn_started') {
    // 跨运行时互斥（桌面优先）：日志里的回合若不是本桥接协议事件里的，说明桌面端
    // （或其他运行时）开始驱动该会话 → 中止本方回合让位
    if (ENGINE === 'appserver') appserver.appServerYieldToForeignTurn(sessionId, event.turnId);
    // 桌面端/CLI 发起的回合：广播给手机端（会话列表运行标记 + 聊天页进入运行态）
    broadcast({ type: 'session_updated', sessionId });
    broadcastStatus();
    ensurePassivePump(sessionId);
  }
  if (event.kind === 'turn_completed') {
    runningSessions.delete(sessionId);
    stopPassivePump(sessionId);
    // 关键同步点：回合结束必须广播，否则正在看该会话的手机端不知道要拉取新消息
    broadcast({ type: 'session_updated', sessionId });
    broadcastStatus();
    setTimeout(() => tryDeliverQueued().catch(() => {}), 3000);
  }

  let jobId = sessionToJob.get(sessionId);
  if (!jobId) {
    for (const job of pendingJobs()) {
      let s = null;
      try {
        s = store.getSession(sessionId);
      } catch {
        break;
      }
      if (s && s.directory === job.directory && s.timeCreated >= job.startedAt - 2000) {
        job.sessionId = sessionId;
        sessionToJob.set(sessionId, job.id);
        jobId = job.id;
        break;
      }
    }
  }
  for (const ws of progressTargets(sessionId, jobId)) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'progress', sessionId, jobId: jobId ?? null, event }));
  }
}

/** app-server 引擎的进度事件：与 onLogEvent 同一套路由（运行集合、订阅扇出、队列投递触发） */
function onAppServerEvent(sessionId, event) {
  recordEvent(sessionId, event);
  markRunning(sessionId);
  if (event.kind === 'turn_started') {
    broadcast({ type: 'session_updated', sessionId }); // 非发起端的观看者也要进入运行态
    broadcastStatus();
  }
  if (event.kind === 'turn_completed') {
    runningSessions.delete(sessionId);
    broadcast({ type: 'session_updated', sessionId }); // 非发起端的观看者拉取最终消息
    broadcastStatus();
    setTimeout(() => tryDeliverQueued().catch(() => {}), 3000);
  }

  let jobId = sessionToJob.get(sessionId);
  if (!jobId) {
    // appserver 的 job 在 create 后即持有最终 sessionId：按运行中任务精确匹配补建路由
    const job = jobForSession(sessionId);
    if (job) {
      sessionToJob.set(sessionId, job.id);
      jobId = job.id;
    }
  }
  for (const ws of progressTargets(sessionId, jobId)) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'progress', sessionId, jobId: jobId ?? null, event }));
  }
}

// ---------- 被动流式泵（桌面端/CLI 发起的回合） ----------
// 这些回合没有 bridge job、job 泵覆盖不到；会话被手机订阅且运行中时，每秒从共享
// SQLite 取最新助手消息快照推给订阅者（桌面端落库即推送），回合结束补发收尾帧。
const passivePumps = new Map(); // sessionId -> interval

function ensurePassivePump(sessionId) {
  if (passivePumps.has(sessionId)) return;
  if (jobForSession(sessionId)) return; // bridge 自己的回合由 job 泵负责
  if ((sessionSubscribers.get(sessionId)?.size ?? 0) === 0 && watchers.size === 0) return; // 没人看就不泵
  let lastSig = '';
  const pump = setInterval(() => {
    if ((sessionSubscribers.get(sessionId)?.size ?? 0) === 0 && watchers.size === 0) {
      // 订阅者全走了，泵失去意义
      stopPassivePump(sessionId, false);
      return;
    }
    let snap;
    try {
      snap = store.getStreamingSnapshot(sessionId);
    } catch {
      return;
    }
    const sig = snap.text.length + '/' + snap.reasoning.length;
    if (sig === lastSig) return;
    lastSig = sig;
    const targets = new Set(watchers);
    for (const w of sessionSubscribers.get(sessionId) ?? []) targets.add(w);
    for (const w of targets) {
      if (w.readyState === w.OPEN) {
        w.send(JSON.stringify({ type: 'stream', sessionId, jobId: null, text: snap.text, reasoning: snap.reasoning }));
      }
    }
  }, 1000);
  passivePumps.set(sessionId, pump);
}

function stopPassivePump(sessionId, finalFlush = true) {
  const pump = passivePumps.get(sessionId);
  if (!pump) return;
  passivePumps.delete(sessionId);
  clearInterval(pump);
  if (!finalFlush) return;
  setTimeout(() => {
    let snap;
    try {
      snap = store.getStreamingSnapshot(sessionId);
    } catch {
      return;
    }
    const targets = new Set(watchers);
    for (const w of sessionSubscribers.get(sessionId) ?? []) targets.add(w);
    for (const w of targets) {
      if (w.readyState === w.OPEN) {
        w.send(JSON.stringify({ type: 'stream', sessionId, jobId: null, text: snap.text, reasoning: snap.reasoning }));
      }
    }
  }, 1500);
}

function subscribeSession(ws, sessionId) {
  if (!sessionSubscribers.has(sessionId)) sessionSubscribers.set(sessionId, new Set());
  sessionSubscribers.get(sessionId).add(ws);
  const job = jobForSession(sessionId);
  if (job) {
    if (!jobSubscribers.has(job.id)) jobSubscribers.set(job.id, new Set());
    jobSubscribers.get(job.id).add(ws);
  }
  // 回合进行到一半才进来的观看者：补起被动泵（job 泵由 onJob 已负责）
  if (runningSessions.has(sessionId)) ensurePassivePump(sessionId);
}

function unsubscribeAll(ws) {
  for (const set of sessionSubscribers.values()) set.delete(ws);
  for (const set of jobSubscribers.values()) set.delete(ws);
}

// ---------- REST ----------
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const send = (code, data) => json(res, code, data);

  if (url.pathname === '/api/ping' && req.method === 'GET') {
    return send(200, { ok: true, bridge: BRIDGE_VERSION, projects: store.listProjects().length });
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    return send(200, statusSnapshot()); // mini 桌面看板用（bridge/README 同款字段：running/queued/phone）
  }

  if (url.pathname === '/api/projects' && req.method === 'GET') {
    return send(200, { projects: store.listProjects() });
  }

  if (url.pathname === '/api/models' && req.method === 'GET') {
    const models = listModels();
    if (!models) return send(500, { error: '无法确定可用的模型（provider 配置缺失）' });
    return send(200, models); // { provider, models: [id, ...] }
  }

  if (url.pathname === '/api/usage' && req.method === 'GET') {
    return send(200, { summary: store.usageSummary(), daily: store.usageDaily(7) });
  }

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const directory = url.searchParams.get('directory') ?? undefined;
    const limit = Number(url.searchParams.get('limit')) || 200;
    const archived = url.searchParams.get('archived') === '1';
    const queued = store.queuedCounts();
    const sessions = store.listSessions({ directory, limit, archived }).map((s) => ({
      ...s,
      running: isRunning(s.id),
      archived: store.isSessionArchived(s.id),
      archivedAt: archive.archivedAt(s.id),
      queuedCount: (queued.get(s.id) ?? 0) + bqueue.list(s.id).length,
    }));
    return send(200, { sessions });
  }

  const messagesMatch = url.pathname.match(/^\/api\/sessions\/(sess_[\w-]+)\/messages$/);
  if (messagesMatch && req.method === 'GET') {
    const session = store.getSession(messagesMatch[1]);
    if (!session) return send(404, { error: '会话不存在' });
    const withArchive = {
      ...session,
      archived: store.isSessionArchived(session.id),
      archivedAt: archive.archivedAt(session.id),
    };
    return send(200, {
      session: withArchive,
      running: isRunning(session.id),
      queued: mergedQueue(session.id),
      messages: store.getMessages(session.id),
    });
  }

  const archiveMatch = url.pathname.match(/^\/api\/sessions\/(sess_[\w-]+)\/archive$/);
  if (archiveMatch && req.method === 'POST') {
    const body = await readBody(req);
    const id = archiveMatch[1];
    if (!store.getSession(id)) return send(404, { error: '会话不存在' });
    if (body.archived === false && !archive.isArchived(id) && store.isSessionArchived(id)) {
      // 只有桌面归档、没有手机侧记录：无法代桌面取消
      return send(409, { error: '该会话是在电脑端 ZCode 中归档的，请在电脑端取消归档' });
    }
    archive.setArchived(id, body.archived !== false);
    broadcast({ type: 'session_updated', sessionId: id });
    return send(200, { ok: true, archived: store.isSessionArchived(id) });
  }

  const queueMatch = url.pathname.match(/^\/api\/sessions\/(sess_[\w-]+)\/queue$/);
  if (queueMatch && req.method === 'POST') {
    const body = await readBody(req);
    const id = queueMatch[1];
    if (!store.getSession(id)) return send(404, { error: '会话不存在' });
    try {
      switch (body.action) {
        case 'add':
          if (!String(body.text ?? '').trim()) return send(400, { error: '内容不能为空' });
          bqueue.add(id, String(body.text));
          // 会话空闲时立刻投递，不等 30s 扫描 tick（运行中会被 tryDeliverQueued 的门禁跳过）
          setTimeout(() => tryDeliverQueued().catch(() => {}), 500);
          break;
        case 'remove':
          if (String(body.id).startsWith('bq_')) bqueue.remove(id, String(body.id));
          else store.removeQueued(id, String(body.id));
          break;
        case 'clear':
          bqueue.clear(id);
          store.clearQueued(id);
          break;
        case 'move':
          bqueue.move(id, String(body.id), body.dir === 'up' ? 'up' : 'down');
          break;
        default:
          return send(400, { error: '未知 action' });
      }
      broadcast({ type: 'session_updated', sessionId: id });
      broadcastStatus();
      return send(200, { ok: true, queued: mergedQueue(id) });
    } catch (e) {
      return send(409, { error: e.message });
    }
  }

  const stopMatch = url.pathname.match(/^\/api\/sessions\/(sess_[\w-]+)\/stop$/);
  if (stopMatch && req.method === 'POST') {
    const sid = stopMatch[1];
    const job = jobForSession(sid);
    if (job) {
      stopById(job.id);
      return send(200, { ok: true, jobId: job.id });
    }
    // 无本方任务但运行标记残留（回合在别处已结束却没落 turn.completed 的幽灵）：
    // 就地清理标记并广播，而不是报错——看板上的「停止」此时起到的是对账作用；
    // 清理后立即尝试队列投递（残留标记期间被跳过的排队消息马上发出）
    if (runningSessions.has(sid)) {
      runningSessions.delete(sid);
      broadcastStatus();
      broadcast({ type: 'session_updated', sessionId: sid });
      setTimeout(() => tryDeliverQueued().catch(() => {}), 500);
      return send(200, { ok: true, reconciled: true, message: '该任务实际已结束，已清理运行标记' });
    }
    return send(409, { error: '该会话没有正在执行的任务' });
  }

  send(404, { error: 'not found' });
}

// ---------- WebSocket ----------
function handleWsMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return ws.send(JSON.stringify({ type: 'error', message: '消息不是合法 JSON' }));
  }

  if (msg.type === 'subscribe' && typeof msg.sessionId === 'string') {
    subscribeSession(ws, msg.sessionId);
    return;
  }

  // mini 看板：订阅全局状态与全部运行中会话的进度/流式快照
  if (msg.type === 'watch') {
    watchers.add(ws);
    ws.send(JSON.stringify({ type: 'status', ...statusSnapshot() }));
    return;
  }

  if (msg.type === 'prompt') {
    const { requestId, sessionId = null, directory, prompt, mode, model } = msg;
    if (!directory || !prompt) {
      return ws.send(JSON.stringify({ type: 'error', requestId, message: '缺少 directory 或 prompt' }));
    }
    // 跨运行时门禁：会话正被其他运行时（桌面端/CLI）执行且本桥接没有活跃任务时，
    // 拒绝同时执行（运行集合来自共享日志，覆盖任意端发起的回合）
    if (sessionId && !jobForSession(sessionId) && runningSessions.has(sessionId)) {
      return ws.send(
        JSON.stringify({
          type: 'error',
          requestId,
          code: 'BUSY',
          message: '电脑端正在该会话中执行任务，已拒绝同时执行。可稍后再试，或先把消息放入队列。',
        })
      );
    }
    startTurn({
      sessionId,
      directory,
      prompt,
      mode,
      model: typeof model === 'string' && model ? model : null,
      onJob: (job) => {
        if (job.sessionId) {
          sessionToJob.set(job.sessionId, job.id);
          markRunning(job.sessionId);
        }
        // 发起者自动订阅该回合的进度；jobId 同时下发给手机端，支持随时 stop_job
        if (!jobSubscribers.has(job.id)) jobSubscribers.set(job.id, new Set());
        jobSubscribers.get(job.id).add(ws);
        ws.send(JSON.stringify({ type: 'prompt_accepted', requestId, jobId: job.id }));

        // 流式泵：回合进行中每秒取最新助手消息已生成的文本，快照推给订阅者。
        // appserver 引擎优先用协议增量累积的文本（零延迟）；回退读 SQLite part 表。
        const pump = setInterval(() => {
          const j = jobById(job.id);
          if (!j) {
            clearInterval(pump);
            streamPumps.delete(job.id);
            return;
          }
          const sid = j.sessionId ?? sessionId;
          if (!sid) return; // 新会话尚未绑定 sess_id
          let snap = ENGINE === 'appserver' ? appserver.appServerStreamSnapshot(job.id) : null;
          if (!snap || (!snap.text && !snap.reasoning)) {
            try {
              snap = store.getStreamingSnapshot(sid);
            } catch {
              return;
            }
          }
          const streamTargets = new Set(watchers);
          for (const w of jobSubscribers.get(job.id) ?? []) streamTargets.add(w);
          for (const w of sessionSubscribers.get(sid) ?? []) streamTargets.add(w); // 同会话的其他观看者也能看到流
          for (const w of streamTargets) {
            if (w.readyState === w.OPEN) {
              w.send(JSON.stringify({ type: 'stream', sessionId: sid, jobId: job.id, text: snap.text, reasoning: snap.reasoning }));
            }
          }
        }, 1000);
        streamPumps.set(job.id, pump);
      },
    })
      .then((result) => {
        if (result.sessionId) {
          sessionToJob.delete(result.sessionId); // 回合结束，路由表防泄漏
          runningSessions.delete(result.sessionId);
          broadcastStatus();
          // 把会话登记进桌面任务索引，让电脑端任务列表能看到手机发起的任务
          try { store.syncTasksIndex(result.sessionId); } catch {}
        }
        ws.send(
          JSON.stringify({
            type: 'result',
            requestId,
            sessionId: result.sessionId,
            response: result.response,
            usage: result.usage,
            projection: result.projection,
          })
        );
        broadcast({ type: 'session_updated', sessionId: result.sessionId });
      })
      .catch((err) => {
        if (sessionId) {
          runningSessions.delete(sessionId);
          broadcastStatus();
        }
        ws.send(JSON.stringify({ type: 'error', requestId, code: err.code, message: err.message }));
      });
    return;
  }

  if (msg.type === 'stop_job' && typeof msg.jobId === 'string') {
    return ws.send(JSON.stringify({ type: 'stopped', jobId: msg.jobId, ok: stopById(msg.jobId) }));
  }

  ws.send(JSON.stringify({ type: 'error', message: `未知消息类型: ${msg.type}` }));
}

function broadcast(data) {
  const s = JSON.stringify(data);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(s);
  }
}

// ---------- 启动 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://bridge.local');
  // mini 看板的本机引导：直接在电脑上打开 /mini 而没带 token 时，页面从这里自动取。
  // 仅回环地址 + 本机 Host 放行（防 DNS rebinding）；局域网设备拿不到——局域网内
  // 本来就靠 token 隔离。本机恶意进程能直接读 bridge.config.json，这里不构成额外暴露。
  if (url.pathname === '/mini/bootstrap') {
    const ra = req.socket.remoteAddress ?? '';
    const loopback = ra === '::1' || ra === '127.0.0.1' || ra === '::ffff:127.0.0.1';
    const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '');
    if (!loopback || !hostOk) return json(res, 403, { error: '仅限本机访问' });
    return json(res, 200, { ok: true, token: cfg.token, port: cfg.port });
  }
  // mini 桌面看板页面。页面本身不含机密，token 由启动器放进 URL # 片段（不会发到服务器），
  // API/WS 仍逐请求鉴权——所以这里不做校验。
  if (url.pathname === '/mini' || url.pathname === '/mini/') {
    try {
      const html = fs.readFileSync(path.join(bridgeRoot, 'src', 'mini.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('mini.html 缺失');
    }
    return;
  }
  if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${cfg.token}`) return json(res, 401, { error: '未授权：token 不正确' });
  handleApi(req, res, url).catch((e) => json(res, 500, { error: e.message }));
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://bridge.local');
  if (url.searchParams.get('token') !== cfg.token) {
    ws.close(4001, '未授权：token 不正确');
    return;
  }
  ws.isAlive = true;
  ws.clientKind = url.searchParams.get('client') === 'mini' ? 'mini' : 'phone'; // 手机在线指示的数据源
  ws.send(JSON.stringify({ type: 'hello', bridge: BRIDGE_VERSION }));
  broadcastStatus(); // 手机上线/下线（以及 mini 首连后的自身计数）对看板可见
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('close', () => {
    unsubscribeAll(ws);
    watchers.delete(ws);
    if (ws.clientKind !== 'mini') {
      phoneLastSeenAt = Date.now();
      broadcastStatus();
    }
  });
  ws.on('message', (raw) => {
    try {
      handleWsMessage(ws, raw.toString());
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });
});

// 心跳清理死连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref?.();

logTail.start();
try { store.backfillTasksIndex(); } catch {}

server.listen(cfg.port, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log('┌─────────────────────────────────────────────────┐');
  console.log('│            ZCode Bridge 已启动                  │');
  console.log('└─────────────────────────────────────────────────┘');
  if (bootInfo.created) console.log(`  已为无头模式生成 CLI 配置: ${bootInfo.model}`);
  console.log(`  回合引擎  : ${ENGINE === 'appserver' ? 'app-server（ZCode Protocol 常驻进程）' : 'headless（无头 CLI，回退模式）'}`);
  console.log(`  ZCode CLI : ${paths.zcodeCjs}`);
  console.log(`  配对 token: ${cfg.token}   （配置文件 bridge/bridge.config.json 可改）`);
  console.log('  手机 App 中填写以下任一地址：');
  for (const ip of ips) console.log(`    http://${ip}:${cfg.port}   token: ${cfg.token}`);
  console.log(`  桌面 mini 看板: http://127.0.0.1:${cfg.port}/mini#${cfg.token}   （或另开终端 npm run mini）`);
  console.log('  ⚠ 同一局域网内任何知道 token 的设备都能控制本机，请勿泄露 token');
});
