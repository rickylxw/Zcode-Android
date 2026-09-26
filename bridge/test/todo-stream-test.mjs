// todo 流式端到端：回合内使用 TodoWrite，断言 stream 帧携带实时待办清单
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bridge.config.json'), 'utf8'));
const DIRECTORY = 'E:/Documents/GitHub/ZCode Android/.probe';

const ws = new WebSocket(`ws://127.0.0.1:8787/ws?token=${cfg.token}`);
let todosFrames = 0, lastTodos = null;
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'prompt', requestId: 't1', sessionId: null, directory: DIRECTORY, mode: 'yolo', prompt: '用 TodoWrite 工具创建一个三步清单：买苹果、买面包、买咖啡（全部 pending），不要执行其他操作，然后回复 TODO_OK' }));
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'stream' && Array.isArray(m.todos) && m.todos.length > 0) {
    todosFrames++;
    lastTodos = m.todos;
  } else if (m.type === 'result') {
    setTimeout(() => {
      console.log('携带 todos 的 stream 帧数:', todosFrames);
      console.log('最后的清单:', JSON.stringify(lastTodos));
      const ok = todosFrames >= 1 && lastTodos && lastTodos.length >= 3;
      console.log(ok ? 'PASS：todo 清单已流式推送到手机端' : 'FAIL：未收到 todo 流');
      process.exit(ok ? 0 : 1);
    }, 1500);
  } else if (m.type === 'error') {
    console.log('← error:', m.message);
  }
});
setTimeout(() => { console.log('FAIL: 150s 超时', JSON.stringify({ todosFrames })); process.exit(1); }, 150000);
