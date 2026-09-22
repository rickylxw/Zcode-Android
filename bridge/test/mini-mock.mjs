// mini 看板的协议模拟器：按桥接同款消息形状（hello/status/progress/stream/usage、
// /mini/bootstrap）灌假数据，用来开发/验收 mini.html，不依赖真实桥接与 ZCode。
//   node test/mini-mock.mjs [port=8878]
// 打开 http://127.0.0.1:<port>/mini 看效果（本机引导会自动给 token，无需 # 片段）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8878;
const TOKEN = 'mock';
const startedAt = Date.now();
const MIN = 60_000;

const sessions = [
  {
    sessionId: 'sess_mockaaaa1111',
    title: '修复 WebSocket 重连的竞态',
    directory: 'E:\\Documents\\GitHub\\ZCode Android',
    since: Date.now() - 95 * 1000,
    mode: 'yolo',
    model: 'bigmodel/glm-5.3',
    prompt: 'ws-test 偶发重连风暴：close 事件里 setTimeout(connect) 没清旧定时器。请定位并修复，跑通测试。',
    queue: 2,
    queueItems: [
      { source: 'phone', text: '顺便把退避上限从 10s 降到 5s' },
      { source: 'desktop', text: '再补一个断线重连的单测' },
    ],
    events: [],
    stream: '我先把 reconnect 的退避逻辑抽出来。当前问题是 close 事件里 setTimeout(connect) 没有清理旧的定时器，会导致重连风暴：\n\n',
    tools: ['Read', 'Edit', 'Bash', 'Grep'],
    ti: 0,
  },
  {
    sessionId: 'sess_mockbbbb2222',
    title: '给队列加持久化',
    directory: 'D:\\work\\demo-app',
    since: Date.now() - 12 * 1000,
    mode: 'build',
    model: null,
    prompt: null,
    queue: 0,
    queueItems: [],
    events: [],
    stream: '',
    tools: ['Read'],
    ti: 0,
  },
];
for (const s of sessions) {
  for (let i = 5; i > 0; i--) {
    s.events.push({ kind: i % 2 ? 'tool_completed' : 'tool_started', toolName: s.tools[i % s.tools.length], durationMs: i % 2 ? 1200 * i : null, timestamp: new Date(Date.now() - i * 20_000).toISOString() });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  if (url.pathname === '/mini') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(root, 'src', 'mini.html')));
  }
  if (url.pathname === '/mini/bootstrap') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, token: TOKEN, port }));
  }
  if (url.pathname === '/api/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ summary: { today: { turns: 23, totalTokens: 1843200 }, last7Days: {}, allTime: {} }, daily: [] }));
  }
  if (url.pathname === '/api/sessions/sess_mockaaaa1111/stop') {
    console.log('[mock] 收到停止指令（忽略）');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});

const wss = new WebSocketServer({ server, path: '/ws' });
const watchers = new Set();

function snapshot() {
  return {
    bridge: { version: 'mock-0.3.0', engine: 'appserver', startedAt },
    phone: { connected: 1, lastSeenAt: Date.now() - 60_000 },
    running: sessions.map((s) => ({
      sessionId: s.sessionId, title: s.title, directory: s.directory, since: s.since,
      jobId: 'turn_' + s.sessionId.slice(5, 13), mode: s.mode, model: s.model, prompt: s.prompt,
      events: s.events, queueItems: s.queueItems,
    })),
    queued: Object.fromEntries(sessions.map((s) => [s.sessionId, s.queue]).filter(([, n]) => n > 0)),
  };
}

function broadcast(...msgs) {
  for (const ws of watchers) if (ws.readyState === ws.OPEN) for (const m of msgs) ws.send(JSON.stringify(m));
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://mock');
  if (url.searchParams.get('token') !== TOKEN) return ws.close(4001, '未授权');
  ws.send(JSON.stringify({ type: 'hello', bridge: 'mock' }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'watch') {
      watchers.add(ws);
      broadcast({ type: 'status', ...snapshot() });
      console.log('[mock] watcher 进入，开始灌数据');
    }
  });
  ws.on('close', () => watchers.delete(ws));
});

const TOOL_KINDS = ['tool_started', 'tool_completed', 'model_request'];
setInterval(() => {
  if (!watchers.size) return;
  const s = sessions[Math.random() < 0.7 ? 0 : 1];
  const kind = TOOL_KINDS[Math.floor(Math.random() * TOOL_KINDS.length)];
  const tool = s.tools[s.ti++ % s.tools.length];
  const event = { kind, toolName: kind === 'model_request' ? null : tool, durationMs: kind === 'tool_completed' ? 800 + Math.floor(Math.random() * 4000) : null, timestamp: new Date().toISOString() };
  s.events.push(event);
  if (s.events.length > 30) s.events.shift();
  s.stream += ['现在修改 reconnect 逻辑，把定时器句柄收进 store_，onopen 时清空退避。', '跑一遍测试确认 ws-test 通过。', '这里还需要处理 4001 不重试的分支。'][s.ti % 3];
  broadcast(
    { type: 'progress', sessionId: s.sessionId, jobId: null, event },
    { type: 'stream', sessionId: s.sessionId, jobId: null, text: s.stream, reasoning: '' }
  );
}, 3000);

setInterval(() => {
  if (watchers.size) broadcast({ type: 'status', ...snapshot() });
}, 20_000); // 周期刷新运行时长

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock] mini 协议模拟器: http://127.0.0.1:${port}/mini`);
});
