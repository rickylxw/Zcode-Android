// 桥接 WebSocket 端到端冒烟测试：
//   node test/ws-test.mjs [sessionId]
// 不带 sessionId 时向 .probe 目录发起新会话；带 sessionId 时 --resume 续接。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bridge.config.json'), 'utf8'));
const sessionId = process.argv[2] ?? null;
const directory = process.argv[3] ?? 'E:\\Documents\\GitHub\\ZCode Android\\.probe';

const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${cfg.token}`);
const seen = { accepted: false, progress: 0, result: null };
const tools = new Set();

const timeout = setTimeout(() => {
  console.error('FAIL: 90s 超时', JSON.stringify(seen, null, 1));
  process.exit(1);
}, 90_000);

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'hello') {
    console.log('← hello, bridge', m.bridge);
    ws.send(
      JSON.stringify({
        type: 'prompt',
        requestId: 'r1',
        sessionId,
        directory,
        mode: 'yolo',
        prompt: sessionId
          ? 'Reply with exactly: WS_RESUME_OK'
          : 'Create a file named ws-test.txt containing the word PONG, then reply with exactly: WS_NEW_OK',
      })
    );
  } else if (m.type === 'prompt_accepted') {
    seen.accepted = true;
    console.log('← prompt_accepted jobId=', m.jobId);
  } else if (m.type === 'progress') {
    seen.progress++;
    if (m.event.kind === 'tool_started') tools.add(m.event.toolName);
    console.log(`← progress [${m.event.kind}]${m.event.toolName ? ' tool=' + m.event.toolName : ''} sessionId=${m.sessionId}`);
  } else if (m.type === 'result') {
    seen.result = m;
    console.log('← result sessionId=', m.sessionId, 'response=', JSON.stringify(m.response), 'usage=', JSON.stringify(m.usage));
    clearTimeout(timeout);
    const ok = seen.accepted && seen.progress > 0 && /WS_(RESUME|NEW)_OK/.test(m.response ?? '');
    console.log(ok ? `PASS (progress events: ${seen.progress}, tools: ${[...tools].join(',') || 'none'})` : 'FAIL: 断言不满足');
    process.exit(ok ? 0 : 1);
  } else if (m.type === 'error') {
    console.error('← error:', m.message);
    process.exit(1);
  } else {
    console.log('←', m.type, JSON.stringify(m).slice(0, 120));
  }
});

ws.on('error', (e) => {
  console.error('WS error:', e.message);
  process.exit(1);
});
