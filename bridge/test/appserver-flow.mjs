// app-server 完整流程测试：创建会话 → 回应偏好 → 发送 prompt
import { spawn } from 'node:child_process';

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const child = spawn(process.execPath, ['E:/Program Files/ZCode/resources/glm/zcode.cjs', 'app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const messages = [];
let currentId = 0;
const pending = new Map();

child.stdout.on('data', d => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      messages.push(msg);
      // 如果是服务端发给我们的请求（有 id 和 method），自动回应
      if (msg.id && msg.method && !pending.has(msg.id)) {
        const rid = msg.id;
        // 回应 runtime preferences
        if (msg.method === 'session/requestRuntimePreferences') {
          const resp = JSON.stringify({
            id: rid,
            result: {
              providerId: 'bigmodel-api-2',
              modelId: 'GLM-5.3',
              mode: 'yolo',
              reasoningLevel: 'max',
            }
          });
          child.stdin.write(resp + '\n');
          messages.push({ _tag: '→ responded to', method: msg.method, sessionId: msg.params?.sessionId });
        }
      }
      // 如果是我们发出的请求收到了响应
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

const send = (msg) => {
  child.stdin.write(JSON.stringify(msg) + '\n');
};

const call = (id, method, params) => {
  return new Promise((res) => {
    pending.set(id, res);
    send({ id, method, params });
  });
};

// 等 startup 完成
await new Promise(r => setTimeout(r, 5000));
console.log('startup 消息:', messages.filter(m => m.method?.startsWith('startup')).length);

// 1) 创建会话
const dir = 'E:\\\\Documents\\\\GitHub\\\\desktop_clock';
const createResp = await call('c1', 'session/create', {
  workspace: { workspaceKey: dir, workspacePath: dir }
});
console.log('create 回复:', JSON.stringify(createResp).slice(0, 200));
const sessionId = createResp?.result?.sessionId || createResp?.result?.id;
console.log('sessionId:', sessionId);

if (!sessionId) {
  console.log('创建失败，退出');
  child.kill();
  process.exit(1);
}

// 2) 回应 runtime preferences
for (const m of messages) {
  if (m.method === 'session/requestRuntimePreferences' && m.params?.sessionId === sessionId) {
    const resp = JSON.stringify({
      id: m.id,
      result: {
        providerId: 'bigmodel-api-2',
        modelId: 'GLM-5.3',
        reasoningLevel: 'max',
      }
    });
    child.stdin.write(resp + '\n');
    console.log('已回应 runtime preferences');
    break;
  }
}

// 3) 发送 prompt
await new Promise(r => setTimeout(r, 2000));
send({ id: 'p1', method: 'session/send', params: { sessionId, text: 'Reply with exactly: APPSRV_OK', mode: 'yolo' } });
console.log('已发送 prompt');

// 4) 收集流式事件
await new Promise(r => setTimeout(r, 30000));

// 打印全部相关事件
console.log('=== 流式事件摘要 ===');
const eventTypes = {};
for (const m of messages) {
  if (m.method) { eventTypes[m.method] = (eventTypes[m.method] || 0) + 1; }
}
console.log(JSON.stringify(eventTypes, null, 1));

child.kill();
process.exit(0);
