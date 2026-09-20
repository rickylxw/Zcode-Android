// 实验：像手机一样向「桌面端打开着的会话」发消息，观察回合与桌面端感知
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bridge.config.json'), 'utf8'));
const dir = 'E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android';

const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${cfg.token}`);
const timeout = setTimeout(() => { console.log('结果: 90s 内回合未完成'); process.exit(0); }, 90_000);

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'hello') {
    ws.send(JSON.stringify({
      type: 'prompt', requestId: 'exp', sessionId: 'sess_c9683258-fd4d-4bf8-8ceb-1937638f0d9a',
      directory: dir, mode: 'yolo',
      prompt: '这是手机端同步实验。Reply with exactly: DESKTOP_SYNC_TEST',
    }));
    console.log('已向当前桌面会话发送实验消息，等待回合…');
  } else if (m.type === 'result') {
    clearTimeout(timeout);
    console.log('回合完成, response:', JSON.stringify(m.response).slice(0, 60));
    process.exit(0);
  } else if (m.type === 'error') {
    console.log('ERROR:', m.message);
    process.exit(1);
  }
});
ws.on('error', (e) => { console.log('WSERR', e.message); process.exit(1); });
