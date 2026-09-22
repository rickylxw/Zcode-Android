// mini 看板 watch 协议冒烟测试（对运行中的桥接）：
//   node test/mini-watch-test.mjs
// 断言：mini 连接（client=mini）watch 后收到 status；手机连接/断开会反映在
// phone.connected 与 phone.lastSeenAt 上；watcher 能收到任意端发起回合的 progress。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bridge.config.json'), 'utf8'));
const port = process.env.BRIDGE_PORT ?? 8787;
const token = process.env.BRIDGE_TOKEN ?? cfg.token;
const base = `127.0.0.1:${port}`;

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

const wsOpen = (ws) => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
const nextMsg = (ws, filter = () => true, timeoutMs = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('等待消息超时')), timeoutMs);
    ws.on('message', function on(raw) {
      const m = JSON.parse(raw.toString());
      if (!filter(m)) return;
      ws.off('message', on);
      clearTimeout(t);
      res(m);
    });
  });

// mini 看板连接
const mini = new WebSocket(`ws://${base}/ws?token=${token}&client=mini`);
await wsOpen(mini);
const hello = await nextMsg(mini, (m) => m.type === 'hello');
console.log('← hello, bridge', hello.bridge);
mini.send(JSON.stringify({ type: 'watch' }));
const st1 = await nextMsg(mini, (m) => m.type === 'status');
if (typeof st1.phone?.connected !== 'number') fail('status 缺少 phone.connected');
console.log(`← status：运行中 ${st1.running.length} 个，手机在线 ${st1.phone.connected}`);

// 手机连接 → 看板应收到 phone.connected 增至 1
const phone = new WebSocket(`ws://${base}/ws?token=${token}`);
await wsOpen(phone);
const st2 = await nextMsg(mini, (m) => m.type === 'status' && m.phone.connected >= 1, 5000);
console.log('← 手机上线已同步给看板:', st2.phone);

// 手机断开 → connected 回落，lastSeenAt 有值
phone.close();
const st3 = await nextMsg(mini, (m) => m.type === 'status' && m.phone.connected === 0 && m.phone.lastSeenAt, 5000);
console.log('← 手机下线已同步给看板:', st3.phone);

// progress 扇出：watcher 不订阅具体会话也应收到。为确定性，往当日日志追加一条
// 合成事件（LogTail 每 500ms tail 一次就会扇出给 watcher；不发起真实回合）。
console.log('注入合成日志事件，等待 progress 扇出…');
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const logFile = `${process.env.USERPROFILE ?? process.env.HOME}\\.zcode\\cli\\log\\zcode-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.jsonl`;
const fakeSid = 'sess_mini_watch_smoke';
fs.appendFileSync(
  logFile,
  JSON.stringify({ event: 'tool.call.started', sessionId: fakeSid, turnId: 'mini-watch-smoke', context: { toolName: 'Echo' }, timestamp: now.toISOString() }) + '\n'
);
try {
  const p = await nextMsg(mini, (m) => m.type === 'progress' && m.sessionId === fakeSid, 8000);
  console.log(`← progress [${p.event.kind}] tool=${p.event.toolName} sessionId=${p.sessionId}`);
} catch {
  fail('8s 内没有收到注入事件的 progress（watcher 扇出失效）');
}

mini.close();
console.log('PASS: mini watch 协议冒烟通过');
process.exit(0);
