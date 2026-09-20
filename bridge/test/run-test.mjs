// 运行中判定精确验证：追踪目标会话进入/离开 running 集合的时机
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bridge.config.json'), 'utf8'));
const dir = 'E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android' + path.sep + '.streamtest';
const H = { Authorization: 'Bearer ' + cfg.token };

const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${cfg.token}`);
const timeout = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 120_000);
let target = null;
let sawRunning = false;
let poller = null;

async function isRunning(id) {
  const r = await fetch('http://127.0.0.1:8787/api/sessions?archived=0', { headers: H }).then((r) => r.json());
  return r.sessions.some((s) => s.id === id && s.running);
}

ws.on('message', async (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'result') {
    target = m.sessionId;
    // 结果到达后持续轮询：running 应该在短时间内变为 false
    let checked = 0;
    poller = setInterval(async () => {
      if (!target) return;
      const running = await isRunning(target);
      checked++;
      if (!running) {
        clearInterval(poller);
        console.log(`完成后 running 清零 ✓ (轮询 ${checked} 次)`);
        console.log(sawRunning ? '全程 PASS' : '任务中未观测到 running（可能完成太快）— 结果后清理 ✓');
        clearTimeout(timeout);
        process.exit(0);
      }
      if (checked > 30) {
        console.log('✗ 完成后 10s 仍 running');
        process.exit(1);
      }
    }, 330);
  }
});

ws.on('open', async () => {
  // 直接经 REST 无法发 prompt，用 WS：先发，再每 300ms 查目标是否进入 running
  ws.send(JSON.stringify({ type: 'prompt', requestId: 'r', directory: dir, mode: 'yolo', prompt: 'Reply with exactly: RUN_OK' }));
  poller = setInterval(async () => {
    const r = await fetch('http://127.0.0.1:8787/api/sessions?archived=0', { headers: H }).then((r) => r.json());
    const mine = r.sessions.find((s) => s.directory === dir && s.running);
    if (mine) {
      sawRunning = true;
      target = mine.id;
      console.log('任务中 running=true ✓ sessionId=', mine.id.slice(5, 13));
      clearInterval(poller);
    }
  }, 300);
});
ws.on('error', (e) => { console.log('WSERR', e.message); process.exit(1); });
