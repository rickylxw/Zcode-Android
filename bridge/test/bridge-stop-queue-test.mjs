// app-server 引擎的组合冒烟：stop 中止 → 杀 app-server 子进程（崩溃自愈）→ 队列自动投递。
//   BRIDGE_PORT=8799 node test/bridge-stop-queue-test.mjs <sessionId>
// 需要一个已存在的会话（先用 ws-test.mjs 不带参数创建一个）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bridge.config.json'), 'utf8'));
const port = process.env.BRIDGE_PORT ?? 8787;
const sessionId = process.argv[2];
if (!sessionId) {
  console.error('用法: BRIDGE_PORT=8799 node test/bridge-stop-queue-test.mjs <sessionId>');
  process.exit(1);
}
const base = `http://127.0.0.1:${port}`;
const api = (p, body) =>
  fetch(base + p, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${cfg.token}`);
let step = 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
let wsSend;
const sawFirstProgress = new Promise((resolve) => {
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
    wsSend = (o) => ws.send(JSON.stringify(o));
    console.log(`\n[1] 发送长回合并等待首个进度事件…`);
    wsSend({ type: 'prompt', requestId: 'r1', sessionId, directory: 'E:\\Documents\\GitHub\\ZCode Android\\.probe', mode: 'yolo', prompt: '写一篇约800字的短文介绍一座山城的四季，直接正文，不要标题。' });
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'prompt_accepted') console.log('← prompt_accepted jobId=', m.jobId);
    else if (m.type === 'progress') {
      events.push(m.event.kind);
      if (events.length === 1) resolve();
    } else if (m.type === 'error') {
      console.log(`← error (requestId=${m.requestId}):`, m.message);
      if (step === 1) {
        if (/停止|cancel/i.test(m.message)) console.log('[1] PASS: stop 产生了 CANCELLED 错误');
        else console.log('[1] FAIL: 错误不是 stop 引起');
        step = 2;
        runStep2();
      } else if (step === 3) {
        console.log('[3] FAIL: 崩溃自愈后的回合报错:', m.message);
        process.exit(1);
      }
    } else if (m.type === 'result' && step === 3) {
      console.log(`[3] PASS: 杀掉 app-server 后新回合自动重启进程并成功 → ${JSON.stringify(m.response)}`);
      step = 4;
      runStep4();
    }
  });
});

// 首个进度事件到达后立即调 stop（中止进行中的长回合）
sawFirstProgress.then(async () => {
  console.log('[1] 收到首个进度事件，调用 stop API…');
  const r = await api(`/api/sessions/${sessionId}/stop`);
  console.log('    stop →', JSON.stringify(r));
});

async function runStep2() {
  console.log('\n[2] 杀掉桥接的 app-server 子进程（裸 app-server，非桌面端 --stdio），验证崩溃自愈…');
  const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'zcode\\.cjs.* app-server' -and $_.CommandLine -notmatch '--stdio' } | ForEach-Object { $_.ProcessId }`;
  const out = await new Promise((resolve) => {
    const c = spawn('powershell', ['-NoProfile', '-Command', ps], { shell: true });
    let s = '';
    c.stdout.on('data', (d) => (s += d));
    c.on('exit', () => resolve(s.trim()));
  });
  const pids = out.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!pids.length) console.log('    （没找到 app-server 子进程——可能已退出，跳过强杀）');
  for (const pid of pids) {
    await new Promise((r) => {
      spawn('taskkill', ['/F', '/PID', pid]).on('exit', r);
    });
    console.log('    killed app-server pid', pid);
  }
  await wait(1000);
  console.log('[2.5] 发送新回合（应自动重启 app-server）…');
  step = 3;
  wsSend({ type: 'prompt', requestId: 'r2', sessionId, directory: 'E:\\Documents\\GitHub\\ZCode Android\\.probe', mode: 'yolo', prompt: 'Reply with exactly: RECOVER_OK' });
}

async function runStep4() {
  console.log('\n[4] 加队列条目，依赖回合结束后的自动投递…');
  const r = await api(`/api/sessions/${sessionId}/queue`, { action: 'add', text: 'Reply with exactly: QUEUE_DELIVER_OK' });
  console.log('    queue:', JSON.stringify(r.queued?.map((q) => q.text)));
  for (let i = 0; i < 20; i++) {
    await wait(5000);
    const msgs = await fetch(`${base}/api/sessions/${sessionId}/messages`, { headers: { authorization: `Bearer ${cfg.token}` } }).then((r) => r.json());
    const last = (msgs.messages ?? []).slice(-1)[0];
    const text = JSON.stringify(last ?? {});
    if (text.includes('QUEUE_DELIVER_OK')) {
      console.log('[4] PASS: 队列条目已自动投递并完成');
      console.log('\n全部 PASS');
      process.exit(0);
    }
  }
  console.log('[4] FAIL: 100s 内队列未投递');
  process.exit(1);
}
