import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ensureCliConfig, lanAddresses, loadBridgeConfig, paths } from './config.js';
import * as archive from './archive.js';
import { LogTail } from './logtail.js';
import { listModels } from './selection.js';
import * as store from './store.js';
import { getJob, pendingNewJobs, runTurn, runningJobForSession, stopJob } from './zcode.js';

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_VERSION = '0.2.1';

const cfg = loadBridgeConfig(bridgeRoot);
const bootInfo = ensureCliConfig();

// ---------- 进度事件路由 ----------
// LogTail 事件只有 sessionId。桥接自己发起的「新会话」回合在结果出来前不知道 sess_id，
// 所以首条未知会话的进度事件到达时，用「目录匹配 + 创建时间晚于 job 启动」反查 SQLite 绑定。
const jobSubscribers = new Map(); // jobId -> Set<ws>
const sessionSubscribers = new Map(); // sessionId -> Set<ws>
const sessionToJob = new Map(); // sessionId -> jobId（绑定后的路由表）

const logTail = new LogTail(onLogEvent);

function onLogEvent(sessionId, event) {
  let jobId = sessionToJob.get(sessionId);
  if (!jobId) {
    for (const job of pendingNewJobs()) {
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
  const targets = new Set();
  for (const ws of sessionSubscribers.get(sessionId) ?? []) targets.add(ws);
  if (jobId) for (const ws of jobSubscribers.get(jobId) ?? []) targets.add(ws);
  for (const ws of targets) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'progress', sessionId, jobId: jobId ?? null, event }));
  }
}

function subscribeSession(ws, sessionId) {
  if (!sessionSubscribers.has(sessionId)) sessionSubscribers.set(sessionId, new Set());
  sessionSubscribers.get(sessionId).add(ws);
  const job = runningJobForSession(sessionId);
  if (job) {
    if (!jobSubscribers.has(job.id)) jobSubscribers.set(job.id, new Set());
    jobSubscribers.get(job.id).add(ws);
  }
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
    const sessions = store.listSessions({ directory, limit, archived }).map((s) => ({
      ...s,
      running: runningJobForSession(s.id) != null,
      archived: store.isSessionArchived(s.id),
      archivedAt: archive.archivedAt(s.id),
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
    return send(200, { session: withArchive, running: runningJobForSession(session.id) != null, messages: store.getMessages(session.id) });
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

  const stopMatch = url.pathname.match(/^\/api\/sessions\/(sess_[\w-]+)\/stop$/);
  if (stopMatch && req.method === 'POST') {
    const job = runningJobForSession(stopMatch[1]);
    if (!job) return send(409, { error: '该会话没有正在执行的任务' });
    stopJob(job.id);
    return send(200, { ok: true, jobId: job.id });
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

  if (msg.type === 'prompt') {
    const { requestId, sessionId = null, directory, prompt, mode, model } = msg;
    if (!directory || !prompt) {
      return ws.send(JSON.stringify({ type: 'error', requestId, message: '缺少 directory 或 prompt' }));
    }
    runTurn({
      sessionId,
      directory,
      prompt,
      mode,
      model: typeof model === 'string' && model ? model : null,
      onJob: (job) => {
        if (job.sessionId) sessionToJob.set(job.sessionId, job.id);
        // 发起者自动订阅该回合的进度；jobId 同时下发给手机端，支持随时 stop_job
        if (!jobSubscribers.has(job.id)) jobSubscribers.set(job.id, new Set());
        jobSubscribers.get(job.id).add(ws);
        ws.send(JSON.stringify({ type: 'prompt_accepted', requestId, jobId: job.id }));
      },
    })
      .then((result) => {
        if (result.sessionId) sessionToJob.delete(result.sessionId); // 回合结束，路由表防泄漏
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
        ws.send(JSON.stringify({ type: 'error', requestId, code: err.code, message: err.message }));
      });
    return;
  }

  if (msg.type === 'stop_job' && typeof msg.jobId === 'string') {
    return ws.send(JSON.stringify({ type: 'stopped', jobId: msg.jobId, ok: stopJob(msg.jobId) }));
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
  ws.send(JSON.stringify({ type: 'hello', bridge: BRIDGE_VERSION }));
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('close', () => unsubscribeAll(ws));
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

server.listen(cfg.port, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log('┌─────────────────────────────────────────────────┐');
  console.log('│            ZCode Bridge 已启动                  │');
  console.log('└─────────────────────────────────────────────────┘');
  if (bootInfo.created) console.log(`  已为无头模式生成 CLI 配置: ${bootInfo.model}`);
  console.log(`  ZCode CLI : ${paths.zcodeCjs}`);
  console.log(`  配对 token: ${cfg.token}   （配置文件 bridge/bridge.config.json 可改）`);
  console.log('  手机 App 中填写以下任一地址：');
  for (const ip of ips) console.log(`    http://${ip}:${cfg.port}   token: ${cfg.token}`);
  console.log('  ⚠ 同一局域网内任何知道 token 的设备都能控制本机，请勿泄露 token');
});
