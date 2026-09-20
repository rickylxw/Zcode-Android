// 流式输出验证：向新会话发一个会写长文的任务，期间统计收到的 stream 快照
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bridge.config.json'), 'utf8'));
const dir = 'E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android' + path.sep + '.streamtest';

const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${cfg.token}`);
let snapshots = 0, maxText = 0, maxReasoning = 0;
const timeout = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 150_000);

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'hello') {
    ws.send(JSON.stringify({ type: 'prompt', requestId: 's1', directory: dir, mode: 'yolo',
      prompt: '分三步：1) 用一句话说明春天；2) 用一句话说明秋天；3) 读完两句话后，回复 exactly: STREAM_DONE。每步之前先简单思考。' }));
  } else if (m.type === 'stream') {
    snapshots++;
    maxText = Math.max(maxText, (m.text || '').length);
    maxReasoning = Math.max(maxReasoning, (m.reasoning || '').length);
  } else if (m.type === 'result') {
    clearTimeout(timeout);
    console.log(`stream 快照: ${snapshots}, 最大文本块: ${maxText}, 最大思考块: ${maxReasoning}`);
    console.log('response:', JSON.stringify(m.response).slice(0, 60));
    const ok = snapshots >= 2 && (maxText > 0 || maxReasoning > 0);
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  } else if (m.type === 'error') {
    console.log('ERROR:', m.message);
    process.exit(1);
  }
});
ws.on('error', (e) => { console.log('WSERR', e.message); process.exit(1); });
