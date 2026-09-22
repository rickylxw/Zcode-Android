// 两端同步验证：模拟桌面端（外来运行时）在会话上跑回合，断言订阅了该会话的
// 手机端 WS 能自动收到 session_updated（开始+结束）、progress、stream，无需手动刷新。
//   BRIDGE_PORT=8799 node test/sync-test.mjs <sessionId>
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
  console.error('用法: BRIDGE_PORT=8799 node test/sync-test.mjs <sessionId>');
  process.exit(1);
}
const DIRECTORY = 'E:\\Documents\\GitHub\\ZCode Android\\.probe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 外来运行时（模拟桌面端）：独立 app-server 进程驱动一个回合
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
    const finish = (v) => { if (!done) { done = v; resolve(v); setTimeout(() => child.kill(), 1500); } };
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
          finish({ ok: m.params.type === 'turn.completed', response: (p.response ?? '').slice(0, 80) });
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
      setTimeout(() => finish({ ok: false, timeout: true }), 120000);
    })();
  });
}

// 手机端视角：订阅会话并统计收到的推送
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${cfg.token}`);
const seen = { sessionUpdated: 0, progress: [], streamFrames: 0 };
ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
  console.log('已订阅会话，启动外来回合（模拟桌面端）…');
  const foreign = foreignTurn('写一篇约500字的短文介绍极光的形成原理，直接正文。');
  await foreign;
  // 真实桌面端是常驻进程：turn.completed 落日志 → logtail（≤500ms tick）→ 广播。
  // 这里等 3s 让这条链路走完再统计。
  await wait(3000);

  // 回合结束后拉取消息（模拟手机端收到 session_updated 后的 load()）
  const msgs = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`, {
    headers: { authorization: `Bearer ${cfg.token}` },
  }).then((r) => r.json());
  const last = (msgs.messages ?? []).filter((m) => m.role === 'assistant').slice(-1)[0];
  const lastText = (last?.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const hasNew = lastText.includes('极光');

  console.log('\n=== 手机端收到的推送 ===');
  console.log('session_updated 次数:', seen.sessionUpdated, '（期望 ≥2：回合开始 + 结束）');
  console.log('progress 事件:', JSON.stringify(seen.progress));
  console.log('stream 帧数:', seen.streamFrames, '（桌面端落库即推送，>1 为流式生效）');
  console.log('最终消息含新内容:', hasNew ? '是' : '否', '| 尾部:', JSON.stringify(lastText.slice(-60)));
  const ok = seen.sessionUpdated >= 2 && seen.progress.includes('turn_started') && seen.progress.includes('turn_completed') && hasNew;
  console.log(ok ? '\nPASS：桌面端回合全程自动同步到手机端' : '\nFAIL：同步链路有缺口');
  process.exit(ok ? 0 : 1);
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'session_updated' && m.sessionId === sessionId) seen.sessionUpdated++;
  else if (m.type === 'progress' && m.sessionId === sessionId) seen.progress.push(m.event.kind);
  else if (m.type === 'stream' && m.sessionId === sessionId && (m.text || m.reasoning)) seen.streamFrames++;
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
setTimeout(() => { console.log('FAIL: 180s 超时', JSON.stringify(seen)); process.exit(1); }, 180000);
