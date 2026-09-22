// 跨运行时互斥验证：
//   BRIDGE_PORT=8799 node test/mutex-test.mjs <sessionId>
// 场景 A：外来运行时回合进行中 → 手机 prompt 应被门禁拒绝（BUSY）
// 场景 B：手机回合进行中 → 外来运行时开始回合 → 手机自动让位（YIELDED）
// 外来运行时 = 本脚本独立 spawn 的 app-server 子进程，与桌面端同构。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bridge.config.json'), 'utf8'));
const port = process.env.BRIDGE_PORT ?? 8787;
const sessionId = process.argv[2];
if (!sessionId) {
  console.error('用法: BRIDGE_PORT=8799 node test/mutex-test.mjs <sessionId>');
  process.exit(1);
}
const DIRECTORY = 'E:\\Documents\\GitHub\\ZCode Android\\.probe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 外来运行时客户端（独立 app-server 进程） ----------
function foreignTurn(text) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['E:/Program Files/ZCode/resources/glm/zcode.cjs', 'app-server'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    const pending = new Map();
    let id = 0;
    let done = null;
    const finish = (v) => { if (!done) { done = v; resolve(v); child.kill(); } };
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && m.method) {
          const result =
            m.method === 'session/requestRuntimePreferences'
              ? { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' }
              : {};
          child.stdin.write(JSON.stringify({ id: m.id, result }) + '\n');
        } else if (m.method === 'session/event' && (m.params?.type === 'turn.completed' || m.params?.type === 'turn.failed')) {
          const p = m.params.payload ?? {};
          const v = { ok: m.params.type === 'turn.completed', resultType: p.resultType, response: (p.response ?? '').slice(0, 60) };
          // 留 1.5s 让外来运行时把 turn.completed 写入共享日志（否则 bridge 的运行集合不会清除）
          setTimeout(() => finish(v), 1500);
        } else if (m.id != null && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      }
    });
    const call = (method, params, timeoutMs = 30000) =>
      new Promise((res) => {
        const tid = 'f' + ++id;
        const t = setTimeout(() => res({ _timeout: true }), timeoutMs);
        pending.set(tid, (msg) => { clearTimeout(t); res(msg); });
        child.stdin.write(JSON.stringify({ id: tid, method, params }) + '\n');
      });
    (async () => {
      await wait(4000);
      const res = await call('session/resume', { sessionId, workspace: { workspaceKey: DIRECTORY, workspacePath: DIRECTORY } }, 60000);
      if (res.error) { finish({ error: res.error }); return; }
      await call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
      const sent = await call('session/send', { sessionId, content: text }, 20000);
      if (sent.error) { finish({ error: sent.error }); return; }
      setTimeout(() => finish({ ok: false, timeout: true }), 90000);
    })();
  });
}

// ---------- 桥接 WS 客户端 ----------
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${cfg.token}`);
let pendingId = 0;
const wsCall = (msg) =>
  new Promise((resolve) => {
    const requestId = 'mx' + ++pendingId;
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.requestId === requestId && (m.type === 'result' || m.type === 'error' || m.type === 'prompt_accepted')) {
        ws.off('message', onMsg);
        resolve(m);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ ...msg, requestId }));
  });

ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
  await wait(500);

  console.log('=== 场景 A：外来回合运行中，手机 prompt 应被门禁拒绝 ===');
  const foreignA = foreignTurn('写一篇约500字的短文介绍沙漠植物，直接正文。');
  await wait(9000); // 等外来回合 turn.started 进入共享日志并被 bridge logtail 收录
  const gate = await wsCall({ type: 'prompt', sessionId, directory: DIRECTORY, mode: 'yolo', prompt: 'Reply with exactly: SHOULD_NOT_RUN' });
  if (gate.type === 'error' && gate.code === 'BUSY') {
    console.log('A PASS: 门禁拦截 →', gate.message);
  } else {
    console.log('A FAIL:', JSON.stringify(gate).slice(0, 200));
  }
  console.log('外来回合 A 结果:', JSON.stringify(await foreignA));

  console.log('\n=== 场景 B：手机回合进行中，外来回合开始 → 手机自动让位 ===');
  let acceptB = null, finalB = null;
  const listenerB = (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.requestId !== 'mxB') return;
    if (m.type === 'prompt_accepted') acceptB = m;
    else if (m.type === 'error' || m.type === 'result') finalB = m;
  };
  ws.on('message', listenerB);
  // 轮询发送：被 BUSY 门禁拦下就等运行集合清除后重试
  for (let i = 0; i < 15 && !acceptB; i++) {
    await wait(2000);
    if (finalB && finalB.code !== 'BUSY') break;
    finalB = null;
    ws.send(JSON.stringify({ type: 'prompt', requestId: 'mxB', sessionId, directory: DIRECTORY, mode: 'yolo', prompt: '写一篇约600字的短文介绍海岛生态，直接正文。' }));
    for (let j = 0; j < 8 && !acceptB && !finalB; j++) await wait(500);
  }
  if (!acceptB) {
    console.log('B FAIL: 手机回合未能启动:', JSON.stringify(finalB).slice(0, 200));
    process.exit(1);
  }
  console.log('← 手机回合已启动');
  await wait(6000); // 等手机回合进入流式输出
  console.log('（外来运行时开始回合）');
  const foreignB = foreignTurn('Reply with exactly: FOREIGN_B_OK');
  for (let i = 0; i < 60 && !finalB; i++) await wait(1000);
  ws.off('message', listenerB);
  if (finalB && finalB.type === 'error' && finalB.code === 'YIELDED') {
    console.log('B PASS: 手机自动让位 →', finalB.message);
  } else {
    console.log('B FAIL:', JSON.stringify(finalB).slice(0, 250));
  }
  console.log('外来回合 B 结果:', JSON.stringify(await foreignB));

  console.log('\n互斥验证结束');
  process.exit(0);
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
