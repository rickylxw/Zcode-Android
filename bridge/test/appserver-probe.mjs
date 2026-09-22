// App-Server 协议探测客户端（对应 docs/appserver-reverse-progress.md 第 6 节缺口验证）
//
// 用法：
//   node appserver-probe.mjs discover [dir]          # startup 全集 + create + list/messages/subscribe（不调模型）
//   node appserver-probe.mjs attach <sessionId> [dir] # resume + messages（不调模型）
//   node appserver-probe.mjs turn [dir]              # create + send + stop 中止，事件全量归档（调模型，小额）
//   node appserver-probe.mjs perm [dir]              # build 模式触发工具审批并应答（调模型，小额）
//   node appserver-probe.mjs ask [dir]               # 触发 AskUserQuestion 并应答（调模型，小额）
//
// 所有收发的消息原文落盘到 test/out/probe-<mode>-<ts>.jsonl，事件 schema 归档以它为准。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZCODE_CJS = 'E:/Program Files/ZCode/resources/glm/zcode.cjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'test', 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const MODE = process.argv[2] || 'discover';
const ARG_DIR = process.argv[4] || process.argv[3];
const WORKSPACE = (ARG_DIR && ARG_DIR.includes('\\') ? ARG_DIR : null)
  || 'E:\\Documents\\GitHub\\ZCode Android\\.probe';
const ATTACH_SESSION = MODE === 'attach' ? process.argv[3] : null;

// ---------- 客户端 ----------

class AppServerClient {
  constructor({ label }) {
    this.label = label;
    this.archivePath = path.join(OUT_DIR, `probe-${label}-${Date.now()}.jsonl`);
    this.archive = fs.createWriteStream(this.archivePath);
    this.messages = [];          // 全部解析后的消息
    this.pending = new Map();    // id -> { resolve, timer }
    this.nextId = 1;
    this.rpcServerRequests = []; // server→client 请求记录（method + params + 我们的应答）
    this.prefsAsks = 0;          // runtimePreferences 被询问次数（>1 说明应答没被接受，死循环探测器）
    this.ourCalls = [];          // 我们发出的请求（id/method/params），用于事后对照应答
    this.quiet = null;           // 由外部设置的静默回调
    this.exitCode = null;
  }

  start(args = ['app-server']) {
    this.child = spawn(process.execPath, [ZCODE_CJS, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) this._onLine(line);
    });
    this.child.stderr.on('data', (d) => {
      const text = d.toString().trim();
      if (text) console.error('[app-server:stderr]', text.slice(0, 500));
    });
    this.child.on('exit', (code) => { this.exitCode = code; });
    return this;
  }

  _onLine(line) {
    if (!line.trim()) return;
    let msg = null;
    try { msg = JSON.parse(line); } catch { 
      console.error('[non-json]', line.slice(0, 200)); 
      return; 
    }
    this.messages.push(msg);
    this.archive.write(line + '\n');
    if (msg.id && msg.method) return this._onServerRequest(msg);
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  _onServerRequest(msg) {
    const { id, method, params } = msg;
    let result = {};
    if (method === 'session/requestRuntimePreferences') {
      // 请求 params: {sessionId, scope: 'runtime-materialization'|'user-execution'}
      // 应答 schema = app.asar 里的 BH 定义（.strict()，只收下面这些键）：
      // 实测：providerId/modelId/mode/reasoningLevel 会被 Zod 拒绝 → server 反复重问（即旧文档的"死循环"）
      console.log(`[prefs] 第 ${++this.prefsAsks} 次被询问 runtimePreferences, params:`, brief(params, 400));
      result = {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: 'preflight-v1',
      };
    } else if (method === 'interaction/requestPermission') {
      // 工具审批请求。应答 = 回显所选 option 的 response 对象（实测：{allowed:true} 会被判
      // "Permission request failed" 并降级为 deny）。这里选 allow_once。
      console.log('[permission] params:', brief(params, 900));
      const opt = (params.options || []).find((o) => o.optionId === 'allow_once') || (params.options || [])[0];
      result = opt?.response ?? { decision: 'allow', reason: 'Approved by bridge' };
    } else if (method === 'interaction/requestUserInput') {
      // askUserQuestion 请求。线上应答 schema（服务端 rYe，严格）：
      //   {action:"accept"|"decline"|"cancel", content?, reason?}
      // 实测：{text:...} 无效会判 deny。content 沿 freeText 惯例 {answer: 选项值}
      console.log('[userInput] params:', brief(params, 1200));
      const q = (params.questions || [])[0];
      const pick = q?.options?.[0]?.value ?? q?.options?.[0]?.label ?? '咖啡';
      result = { action: 'accept', content: { answer: pick } };
    } else {
      // 未知请求：先记录，回空对象防止流程卡死（应答是否有效看后续事件）
      console.log(`[!] 未知的 server→client 请求: ${method}`);
      console.log('    params:', JSON.stringify(params).slice(0, 800));
      result = {};
    }
    this.rpcServerRequests.push({ method, params, result });
    this._write(JSON.stringify({ id, result }) + '\n');
  }

  _write(s) { this.child.stdin.write(s); }

  call(method, params, timeoutMs = 20000) {
    const id = 'pc' + this.nextId++;
    this.ourCalls.push({ id, method, params });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ _timeout: true, id, method });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this._write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async sendText(sessionId, text, _mode = null) {
    // 0.16.9 实测：session/send 只收 {sessionId, content}；mode 走 session/setMode
    return this.call('session/send', { sessionId, content: text }, 10000);
  }

  stop(sessionId) {
    return this.call('session/stop', { sessionId }, 10000);
  }

  responseFor(id) {
    return this.messages.find((m) => m.id === id && (m.result || m.error)) || null;
  }

  eventsOf(method) { return this.messages.filter((m) => m.method === method); }
  notifications() {
    const counts = {};
    for (const m of this.messages) if (m.method && !m.id) counts[m.method] = (counts[m.method] || 0) + 1;
    return counts;
  }

  async waitQuiet(ms = 4000) {
    let last = this.messages.length;
    const t0 = Date.now();
    while (Date.now() - t0 < ms * 4) {
      await new Promise((r) => setTimeout(r, 500));
      if (this.exitCode !== null) return;
      if (this.messages.length === last) return;
      last = this.messages.length;
    }
  }

  kill() {
    try { this.child.kill(); } catch {}
  }
}

// create 参数：0.16.9 只收 workspace（严格模式，多一个键都会 ZodError 拒绝；
// 三个布尔属于 requestRuntimePreferences 的应答，见 _onServerRequest）
function createParams(dir = WORKSPACE) {
  return { workspace: { workspaceKey: dir, workspacePath: dir } };
}

const brief = (v, n = 1200) => JSON.stringify(v)?.slice(0, n);
const unwrap = (resp) => {
  if (!resp) return null;
  if (resp._timeout) return { _timeout: true };
  return resp.error ? { error: resp.error } : resp.result;
};

// ---------- 模式 ----------

async function discover() {
  const c = new AppServerClient({ label: 'discover' }).start();
  console.log('archive:', c.archivePath);
  await c.waitQuiet(4000);
  console.log('startup 通知统计:', JSON.stringify(c.notifications()));

  const caps = unwrap(await c.call('runtime/capabilities', {}));
  console.log('runtime/capabilities →', brief(caps));

  const created = unwrap(await c.call('session/create', createParams()));
  console.log('session/create →', brief(created));
  const sessionId = created?.session?.sessionId || created?.sessionId;
  console.log('sessionId:', sessionId);
  if (!sessionId) { c.kill(); process.exit(1); }
  console.log('runtimePreferences 询问次数:', c.prefsAsks, '（>1 说明应答没被接受）');

  const setModel = unwrap(await c.call('session/setModel', {
    sessionId,
    model: { providerId: 'bigmodel-api-2', modelId: 'GLM-5.3', options: { reasoningLevel: 'max' } },
  }));
  console.log('session/setModel →', brief(setModel));

  console.log('session/list →', brief(unwrap(await c.call('session/list', {}))));
  console.log('session/messages →', brief(unwrap(await c.call('session/messages', { sessionId, limit: 5 }))));
  console.log('session/subscribe →', brief(unwrap(await c.call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }))));
  console.log('session/events →', brief(unwrap(await c.call('session/events', { sessionId, limit: 5 }))));
  console.log('session/usage →', brief(unwrap(await c.call('session/usage', { sessionId }))));
  console.log('session/read →', brief(unwrap(await c.call('session/read', { sessionId }))));

  console.log('session/close →', brief(unwrap(await c.call('session/close', { sessionId }))));
  await new Promise((r) => setTimeout(r, 1000));
  console.log('server→client 请求全集:', JSON.stringify([...new Set(c.rpcServerRequests.map((r) => r.method))]));
  c.kill();
  process.exit(0);
}

async function attach() {
  if (!ATTACH_SESSION) { console.error('用法: node appserver-probe.mjs attach <sessionId> [dir]'); process.exit(1); }
  const c = new AppServerClient({ label: 'attach' }).start();
  console.log('archive:', c.archivePath);
  await c.waitQuiet(4000);

  const params = { sessionId: ATTACH_SESSION, workspace: { workspaceKey: WORKSPACE, workspacePath: WORKSPACE } };
  const resumed = unwrap(await c.call('session/resume', params, 30000));
  console.log('session/resume →', brief(resumed, 2000));
  if (resumed?.error) {
    // 服务端错误会点名缺失字段（渲染端就是靠这个做兼容重试的），照提示修参数
    console.log('\n（resume 失败——按错误信息调整参数后重试）');
    c.kill(); process.exit(1);
  }
  const n = resumed?.messages?.length ?? '未知';
  console.log(`历史消息数: ${n}, model.current:`, brief(resumed?.settings?.model?.current));

  console.log('session/messages →', brief(unwrap(await c.call('session/messages', { sessionId: ATTACH_SESSION, limit: 3 })), 1500));
  console.log('session/setMode →', brief(unwrap(await c.call('session/setMode', { sessionId: ATTACH_SESSION, mode: 'build' })), 300));
  console.log('session/subscribe →', brief(unwrap(await c.call('session/subscribe', { sessionId: ATTACH_SESSION, deliveryKind: 'desktop-continuous' })), 600));
  // 注意：attach 模式不 close、不 send——close 可能影响真实会话，send 会花钱
  await c.waitQuiet(3000);
  console.log('resume 后收到的通知:', JSON.stringify(c.notifications()));
  console.log('server→client 请求全集:', JSON.stringify([...new Set(c.rpcServerRequests.map((r) => r.method))]));
  c.kill();
  process.exit(0);
}

async function turn() {
  const c = new AppServerClient({ label: 'turn' }).start();
  console.log('archive:', c.archivePath);
  await c.waitQuiet(4000);

  const created = unwrap(await c.call('session/create', createParams()));
  const sessionId = created?.session?.sessionId || created?.sessionId;
  console.log('sessionId:', sessionId);
  if (!sessionId) { c.kill(); process.exit(1); }

  // 事件必须订阅后才投递（desktop-continuous = 持续推流）
  const sub = unwrap(await c.call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }));
  console.log('session/subscribe →', brief(sub, 300));

  // 回合 1：长输出保证有时间窗（ steer 已定论：线上不支持，见 docs 归档）
  c.sendText(sessionId, '写一篇约600字的短文，主题：一座海滨小城的四季。直接开始正文，不要标题。');
  console.log('已发送回合 1');

  let stopped = false, stopAt = 0, lastLen = 0, lastNewAt = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    await new Promise((r) => setTimeout(r, 300));
    if (c.messages.length !== lastLen) { lastLen = c.messages.length; lastNewAt = Date.now(); }
    const events = c.eventsOf('session/event');
    const types = events.map((e) => e.params?.type || e.params?.event?.type);

    // 首个流式增量出现后中止（测 stop；steer 线上不支持已定论，不再尝试）
    if (!stopped && types.includes('model.streaming') && Date.now() - t0 > 3000) {
      stopped = true;
      stopAt = Date.now();
      console.log('--- 流式输出中，调用 session/stop ---');
      c.stop(sessionId);
    }
    const terminalHit = types.some((t) => ['turn.completed', 'turn.failed', 'turn.terminal'].includes(t));
    if (stopped && terminalHit && Date.now() - stopAt > 1500) break;
    if (stopped && Date.now() - stopAt > 8000 && Date.now() - lastNewAt > 8000) break;
  }

  // 归档摘要：每个事件类型取第一份完整 payload
  const events = c.eventsOf('session/event');
  const byType = {};
  for (const e of events) {
    const t = e.params?.type || e.params?.event?.type || '?';
    if (!byType[t]) byType[t] = e.params;
  }
  console.log('\n=== 事件类型直方图 ===');
  const hist = {};
  for (const e of events) { const t = e.params?.type || e.params?.event?.type || '?'; hist[t] = (hist[t] || 0) + 1; }
  console.log(JSON.stringify(hist, null, 1));
  console.log('\n=== 每类事件首份 payload ===');
  for (const [t, p] of Object.entries(byType)) console.log(`\n--- ${t} ---\n${brief(p, 1500)}`);
  console.log('\n=== 其余通知统计 ===', JSON.stringify(c.notifications()));
  console.log('=== 关键请求应答 ===');
  for (const call of c.ourCalls) {
    if (['session/send', 'session/stop'].includes(call.method)) {
      const r = c.responseFor(call.id);
      console.log(call.method, JSON.stringify(call.params).slice(0, 120), '→', r ? brief(r.error || r.result, 300) : '(无应答)');
    }
  }
  console.log('=== server→client 请求全集 ===', JSON.stringify(c.rpcServerRequests.map((r) => ({ method: r.method, params: r.params })), null, 1).slice(0, 3000));

  console.log('session/close →', brief(unwrap(await c.call('session/close', { sessionId }))));
  await new Promise((r) => setTimeout(r, 800));
  c.kill();
  process.exit(0);
}

// permission 审批流：build 模式 + 写文件工具 → 触发 interaction/requestPermission → 应答验证
async function perm() {
  const c = new AppServerClient({ label: 'perm' }).start();
  console.log('archive:', c.archivePath);
  await c.waitQuiet(4000);

  const created = unwrap(await c.call('session/create', createParams()));
  const sessionId = created?.session?.sessionId || created?.sessionId;
  console.log('sessionId:', sessionId, '(默认 build 模式)');
  if (!sessionId) { c.kill(); process.exit(1); }
  await c.call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });

  c.sendText(sessionId, '在当前目录创建文件 hello.txt，内容为一行文字：hi');
  console.log('已发送写文件指令，等待审批请求…');

  const t0 = Date.now();
  while (Date.now() - t0 < 100000) {
    await new Promise((r) => setTimeout(r, 300));
    const types = c.eventsOf('session/event').map((e) => e.params?.type);
    if (types.includes('turn.completed') || types.includes('turn.failed')) break;
  }

  const events = c.eventsOf('session/event');
  const hist = {};
  for (const e of events) { const t = e.params?.type || '?'; hist[t] = (hist[t] || 0) + 1; }
  console.log('\n=== 事件直方图 ===\n' + JSON.stringify(hist, null, 1));
  for (const e of events) {
    const t = e.params?.type || '?';
    if (/permission|tool|part/.test(t)) console.log(`\n--- ${t} ---\n${brief(e.params, 1200)}`);
  }
  console.log('\n=== server→client 请求与应答 ===');
  for (const r of c.rpcServerRequests) console.log(r.method, '→ 应答:', JSON.stringify(r.result), '\n    params:', brief(r.params, 800));
  console.log('\n=== 我方请求应答 ===');
  for (const call of c.ourCalls) {
    if (['session/send', 'session/stop'].includes(call.method)) {
      const resp = c.responseFor(call.id);
      console.log(call.method, '→', resp ? brief(resp.error || resp.result, 300) : '(无应答)');
    }
  }
  await new Promise((r) => setTimeout(r, 800));
  c.kill();
  process.exit(0);
}

// askUserQuestion 流：触发 interaction/requestUserInput 并验证应答格式
async function ask() {
  const c = new AppServerClient({ label: 'ask' }).start();
  console.log('archive:', c.archivePath);
  await c.waitQuiet(4000);

  const created = unwrap(await c.call('session/create', createParams()));
  const sessionId = created?.session?.sessionId || created?.sessionId;
  console.log('sessionId:', sessionId);
  if (!sessionId) { c.kill(); process.exit(1); }
  await c.call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });

  c.sendText(sessionId, '用 AskUserQuestion 工具问我一个问题：想喝咖啡还是茶？给我两个选项即可，我选择后结束。');
  console.log('已发送提问指令…');

  const t0 = Date.now();
  while (Date.now() - t0 < 100000) {
    await new Promise((r) => setTimeout(r, 300));
    const types = c.eventsOf('session/event').map((e) => e.params?.type);
    if (types.includes('turn.completed') || types.includes('turn.failed')) break;
  }

  for (const e of c.eventsOf('session/event')) {
    const t = e.params?.type || '?';
    if (/userInput|permission|turn\.completed|turn\.failed/.test(t)) console.log(`\n--- ${t} ---\n${brief(e.params, 1000)}`);
  }
  console.log('\n=== server→client 请求与应答 ===');
  for (const r of c.rpcServerRequests) if (r.method.includes('UserInput')) console.log(r.method, '\n    params:', brief(r.params, 1000), '\n    应答:', JSON.stringify(r.result));
  await new Promise((r) => setTimeout(r, 800));
  c.kill();
  process.exit(0);
}

const runners = { discover, attach, turn, perm, ask };
if (!runners[MODE]) { console.error('未知模式: ' + MODE); process.exit(1); }
runners[MODE]().catch((e) => { console.error(e); process.exit(1); });
