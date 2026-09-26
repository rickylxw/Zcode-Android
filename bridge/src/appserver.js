import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { paths } from './config.js';
import { listModels } from './selection.js';

/**
 * App-Server 引擎：以 ZCode Protocol (JSONL over stdio) 驱动常驻 app-server 子进程，
 * 替代「每回合 spawn 无头 CLI」。协议事实与实测记录见 docs/appserver-reverse-progress.md。
 *
 * 对 server.js 暴露与 zcode.runTurn 相同形状的接口（job 契约、锁粒度、结果字段），
 * 事件以 LogTail 同款 {kind, toolName, durationMs, timestamp} 形状回调 onEvent(sessionId, event)，
 * 因此路由/订阅/队列投递逻辑两端通用，手机端无感知。
 *
 * 与无头 CLI 的关键差异（协议层定论，勿改）：
 * - session/create 参数严格只收 {workspace:{workspaceKey,workspacePath}}；
 * - 模型选择走 session/setModel（provider 来自 selection.listModels），不再写 SQLite session_entry；
 * - session/send 参数是 {sessionId, content}，mode 用 session/setMode 预设；
 * - 事件必须 session/subscribe 后才投递；中止以 turn.completed(resultType:"cancelled") 表达；
 * - 回合中的再次 send 会被拒（-32010），排队由 bridge 的 bqueue 负责（wire 无队列）。
 */

const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const VALID_MODES = new Set(['build', 'edit', 'plan', 'yolo']);

// ---------- 常驻子进程管理 ----------

let proc = null; // 当前子进程上下文
let procSeq = 0;

function ensureProcess() {
  if (proc && proc.child.exitCode === null) return proc;
  const child = spawn(process.execPath, [paths.zcodeCjs, 'app-server'], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const p = {
    child,
    requests: new Map(), // id -> { resolve, reject, timer }
    stderrTail: '',
    dead: null, // 进程退出原因（退出后设置）
  };
  proc = p;

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) handleLine(p, line);
  });
  child.stderr.on('data', (d) => {
    p.stderrTail = (p.stderrTail + d.toString()).slice(-8000);
  });
  child.on('exit', (code, signal) => {
    p.dead = `app-server 进程退出 code=${code} signal=${signal}`;
    const tail = p.stderrTail.trim().split('\n').slice(-5).join('\n');
    console.error(`[appserver] ${p.dead}${tail ? '\n' + tail : ''}`);
    for (const { reject } of p.requests.values()) reject(new Error(p.dead));
    p.requests.clear();
    for (const turn of turns.values()) failTurn(turn, new Error(p.dead));
    if (proc === p) proc = null; // 下次调用自动重启
  });
  child.on('error', (err) => {
    p.dead = `无法启动 app-server: ${err.message}`;
    console.error('[appserver]', p.dead);
    for (const { reject } of p.requests.values()) reject(new Error(p.dead));
    p.requests.clear();
    if (proc === p) proc = null;
  });

  p.onNotification = dispatchEvent;
  return p;
}

function handleLine(p, line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && msg.method) return handleServerRequest(p, msg);
  if (msg.id != null && p.requests.has(msg.id)) {
    const entry = p.requests.get(msg.id);
    p.requests.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(Object.assign(new Error(msg.error.message ?? 'app-server 错误'), { code: msg.error.code, data: msg.error.data }));
    else entry.resolve(msg.result);
    return;
  }
  if (msg.method) p.onNotification?.(msg);
}

/** server→client 请求必须应答，否则发起方挂起。应答格式均为 0.16.9 实测定论。 */
function handleServerRequest(p, msg) {
  // 权限审批 / AskUserQuestion：转发给手机订阅者等真实应答（120s 超时回退默认策略）
  if (msg.method === 'interaction/requestPermission' || msg.method === 'interaction/requestUserInput') {
    const kind = msg.method === 'interaction/requestPermission' ? 'permission' : 'user_input';
    const fallback = interactionFallback(kind, msg.params);
    handleInteraction(msg.params?.sessionId ?? null, kind, msg.params, fallback)
      .then((result) => writeResponse(p, msg.id, result))
      .catch(() => writeResponse(p, msg.id, fallback()));
    return;
  }
  let result = {};
  switch (msg.method) {
    case 'session/requestRuntimePreferences': {
      // 严格 schema：多一个键都会被 Zod 拒绝 → server 反复重问（死循环）
      result = {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: 'preflight-v1',
      };
      break;
    }
    case 'interaction/requestOfficialMcpAuthHeaders':
      result = {};
      break;
    default:
      console.warn('[appserver] 未知的 server→client 请求（回空对象）:', msg.method);
      result = {};
  }
  writeResponse(p, msg.id, result);
}

function writeResponse(p, id, result) {
  try {
    p.child.stdin.write(JSON.stringify({ id, result }) + '\n');
  } catch {}
}

/** 超时/无人观看时的默认策略（审批超时策略可在手机设置里改） */
function interactionFallback(kind, params) {
  const deny = approvalFallbackPolicy === 'deny';
  if (kind === 'permission') {
    if (deny) {
      const opt = (params?.options ?? []).find((o) => o.optionId === 'deny');
      return opt?.response ?? { decision: 'deny', reason: '审批超时：按设置拒绝执行' };
    }
    const opt = (params?.options ?? []).find((o) => o.optionId === 'allow_once') ?? (params?.options ?? [])[0];
    return opt?.response ?? { decision: 'allow', reason: 'Approved by bridge' };
  }
  if (deny) return { action: 'decline' };
  const q = (params?.questions ?? [])[0];
  const pick = q?.options?.[0]?.value ?? q?.options?.[0]?.label ?? '继续';
  return { action: 'accept', content: { answer: pick } };
}

// ---------- 交互请求转发（权限审批 / AskUserQuestion → 手机端） ----------

let interactionHandler = null; // (sessionId, req) => 是否有手机端在观看；server.js 注入
const pendingInteractions = new Map(); // requestId -> { resolve, timer }
const INTERACTION_TIMEOUT_MS = 120 * 1000;

/** 审批超时策略：allow = 超时放行单次/采纳第一项（默认）；deny = 超时拒绝/不答 */
let approvalFallbackPolicy = 'allow';

export function setApprovalFallbackPolicy(policy) {
  if (policy === 'allow' || policy === 'deny') approvalFallbackPolicy = policy;
}

/** server.js 注入转发函数：把请求推给订阅该会话的手机端，返回是否有观众 */
export function setInteractionHandler(fn) {
  interactionHandler = fn;
}

/** 手机端（或超时回退）的应答入口；返回 false = 请求已超时/不存在 */
export function appServerRespond(requestId, response) {
  const p = pendingInteractions.get(requestId);
  if (!p) return false;
  pendingInteractions.delete(requestId);
  clearTimeout(p.timer);
  p.resolve(response);
  return true;
}

function handleInteraction(sessionId, kind, params, fallback) {
  const req = {
    requestId: 'req_' + crypto.randomBytes(6).toString('hex'),
    kind,
    toolName: params?.toolName ?? null,
    riskLevel: params?.riskLevel ?? null,
    reason: params?.reason ?? params?.prompt ?? null,
    input: params?.input ?? null,
    options: params?.options ?? null,
    questions: params?.questions ?? null,
  };
  const hasAudience = interactionHandler?.(sessionId, { ...req, sessionId }) ?? false;
  if (!hasAudience) return Promise.resolve(fallback());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingInteractions.delete(req.requestId)) {
        console.log(`[appserver] 交互请求超时（${kind}），使用默认策略: ${sessionId ?? ''}`);
        interactionHandler?.expired?.(sessionId, req.requestId);
        resolve(fallback());
      }
    }, INTERACTION_TIMEOUT_MS);
    pendingInteractions.set(req.requestId, { resolve, timer });
  });
}

function call(method, params, timeoutMs = 30000) {
  const p = ensureProcess();
  if (p.dead) throw new Error(p.dead);
  const id = 'br' + ++procSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      p.requests.delete(id);
      // 响应永久不来 = 子进程协议失联/内部僵死，状态已不可信：
      // 回收子进程（exit 处理器会失败所有在途回合），下次调用自动重生
      console.error(`[appserver] 请求超时(${method})，回收 app-server 子进程`);
      try { p.child.kill(); } catch {}
      reject(new Error(`app-server 请求超时: ${method}`));
    }, timeoutMs);
    p.requests.set(id, { resolve, reject, timer });
    try {
      p.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      p.requests.delete(id);
      reject(new Error(`app-server stdin 不可写: ${e.message}`));
    }
  });
}

// ---------- 回合任务注册表（契约与 zcode.js 一致） ----------

const turns = new Map(); // jobId -> turn
const locks = new Map(); // lockKey -> jobId
const turnsBySession = new Map(); // sessionId -> turn（事件路由用）

export function appServerJob(jobId) {
  return turns.get(jobId) ?? null;
}

export function appServerRunningForSession(sessionId) {
  for (const t of turns.values()) if (t.sessionId === sessionId) return t;
  return null;
}

export function appServerPendingNewJobs() {
  return [...turns.values()].filter((t) => !t.sessionId);
}

export function appServerStop(jobId) {
  const turn = turns.get(jobId);
  if (!turn?.sessionId) return false;
  call('session/stop', { sessionId: turn.sessionId }, 15000).catch(() => {});
  return true;
}

/** 流式快照（server.js 的 stream 泵优先用它，拿不到再读 SQLite） */
export function appServerStreamSnapshot(jobId) {
  const turn = turns.get(jobId);
  if (!turn) return null;
  return { text: turn.streamText, reasoning: turn.streamReasoning };
}

/**
 * 跨运行时互斥（桌面优先）：LogTail 看到所有运行时的 turn_started（带 turnId）。
 * 若某会话有本桥接活跃回合，而日志里的 turnId 不在我们订阅到的协议事件集合中，
 * 说明是桌面端（或其他运行时）开始驱动该会话 → 自动中止自己的回合让位。
 * 返回 true 表示触发了让位。
 */
export function appServerYieldToForeignTurn(sessionId, logTurnId) {
  const turn = turnsBySession.get(sessionId);
  if (!turn || turn.settled) return false;
  if (!logTurnId) return false;
  if (turn.wireTurnIds.has(logTurnId)) return false; // 自己人的回合
  turn.yielded = true;
  console.log(`[appserver] 检测到外来回合（桌面端优先），中止本方回合: ${sessionId}`);
  call('session/stop', { sessionId }, 15000).catch(() => {});
  return true;
}

function cleanupTurn(turn) {
  clearTimeout(turn.timer);
  turns.delete(turn.id);
  if (locks.get(turn.lockKey) === turn.id) locks.delete(turn.lockKey);
  if (turn.sessionId && turnsBySession.get(turn.sessionId) === turn) turnsBySession.delete(turn.sessionId);
}

function failTurn(turn, err) {
  if (turn.settled) return;
  turn.settled = true;
  cleanupTurn(turn);
  turn.reject(err);
}

function finishTurn(turn, result) {
  if (turn.settled) return;
  turn.settled = true;
  cleanupTurn(turn);
  emitEvent(turn, { kind: 'turn_completed', toolName: null, durationMs: Date.now() - turn.startedAt, timestamp: new Date().toISOString() });
  turn.resolve(result);
}

function emitEvent(turn, event) {
  try {
    turn.onEvent?.(turn.sessionId, event);
  } catch {}
}

/**
 * 执行一个 app-server 回合，resolve 出 { sessionId, response, usage, projection }。
 * onJob(turn) 在校验后同步回调（契约同 zcode.runTurn 的 onJob；新会话此刻 sessionId 为 null，
 * create 完成后原地补上——server.js 的 stream 泵每秒重读 job.sessionId，无需额外通知）。
 * onEvent(sessionId, event) 以 LogTail 同款事件形状回调进度。
 */
export function appServerTurn({ sessionId = null, directory, prompt, mode = 'yolo', model = null, onJob, onEvent }) {
  return new Promise((resolve, reject) => {
    if (!VALID_MODES.has(mode)) return reject(new Error(`无效的权限模式: ${mode}（可选 build/edit/plan/yolo）`));
    if (!prompt || !prompt.trim()) return reject(new Error('prompt 不能为空'));
    if (!fs.existsSync(directory)) return reject(new Error(`项目目录不存在: ${directory}`));

    const lockKey = sessionId ?? `new:${directory}`;
    if (locks.has(lockKey)) {
      return reject(Object.assign(new Error('该会话正在执行中，请等待完成或先停止'), { code: 'BUSY' }));
    }

    const turn = {
      id: 'turn_' + crypto.randomBytes(6).toString('hex'),
      sessionId: sessionId ?? null,
      lockKey,
      directory,
      mode,
      model,
      prompt,
      startedAt: Date.now(),
      settled: false,
      streamText: '',
      streamReasoning: '',
      wireTurnIds: new Set(), // 本方回合在协议事件里的 turnId（互斥判别用）
      yielded: false,
      onEvent,
      timer: null,
      resolve: null,
      reject: null,
    };
    turn.resolve = (result) => {
      if (turn.settled) return;
      turn.settled = true;
      cleanupTurn(turn);
      emitEvent(turn, { kind: 'turn_completed', toolName: null, durationMs: Date.now() - turn.startedAt, timestamp: new Date().toISOString() });
      resolve(result);
    };
    turn.reject = (err) => {
      if (turn.settled) return;
      turn.settled = true;
      cleanupTurn(turn);
      reject(err);
    };

    turns.set(turn.id, turn);
    locks.set(lockKey, turn.id);
    onJob?.(turn);

    run(turn, prompt, mode, model).catch((e) => turn.reject(e));
  });
}

async function run(turn, prompt, mode, model) {
  const workspace = { workspaceKey: turn.directory, workspacePath: turn.directory };

  // 1) 取得/恢复运行时会话
  if (turn.sessionId) {
    await call('session/resume', { sessionId: turn.sessionId, workspace }, 60000);
  } else {
    const created = await call('session/create', { workspace }, 60000);
    const sid = created?.session?.sessionId;
    if (!sid) throw new Error('session/create 未返回 sessionId: ' + JSON.stringify(created).slice(0, 300));
    turn.sessionId = sid;
    turnsBySession.set(sid, turn);
  }
  turnsBySession.set(turn.sessionId, turn);
  const sid = turn.sessionId;

  // 2) 事件必须订阅后才投递
  await call('session/subscribe', { sessionId: sid, deliveryKind: 'desktop-continuous' });

  // 3) 模式与模型（失败不阻塞回合：模型错时服务端会用会话自身的选择）
  if (mode && mode !== 'build') {
    try {
      await call('session/setMode', { sessionId: sid, mode }, 15000);
    } catch (e) {
      console.warn('[appserver] setMode 失败（忽略）:', e.message);
    }
  }
  if (model) {
    try {
      const provider = listModels()?.provider ?? 'bigmodel-api-2';
      await call('session/setModel', { sessionId: sid, model: { providerId: provider, modelId: model, options: { reasoningLevel: 'max' } } }, 15000);
    } catch (e) {
      console.warn('[appserver] setModel 失败（忽略）:', e.message);
    }
  }

  turn.timer = setTimeout(() => {
    console.warn('[appserver] 回合超时，自动停止:', sid);
    appServerStop(turn.id);
  }, TURN_TIMEOUT_MS);
  turn.timer.unref?.();

  // 4) 发送（回合中的重复发送会被服务端拒 -32010；排队由 bqueue 负责）
  try {
    await call('session/send', { sessionId: sid, content: prompt }, 20000);
  } catch (e) {
    if (e.code === -32010) throw Object.assign(new Error('该会话正在执行中，请等待完成或先停止'), { code: 'BUSY' });
    throw e;
  }
}

// ---------- 事件分发（进程级，挂在当前 proc 上） ----------

function dispatchEvent(msg) {
  if (msg.method !== 'session/event') return;
  const ev = msg.params ?? {};
  const sid = ev.sessionId;
  if (!sid || !ev.type) return;
  const turn = turnsBySession.get(sid);
  if (!turn || turn.settled) return; // 非本桥接发起的回合（桌面端等）由 logtail 覆盖

  const kind = appServerEventKind(ev);
  if (kind) {
    emitEvent(turn, {
      kind,
      toolName: ev.payload?.toolName ?? null,
      durationMs: null,
      timestamp: ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString(),
    });
  }

  if (ev.type === 'model.streaming') {
    const delta = ev.payload?.delta ?? '';
    if (ev.payload?.kind === 'reasoning_delta') turn.streamReasoning += delta;
    else if (ev.payload?.kind === 'text_delta') turn.streamText += delta;
  } else if (ev.type === 'turn.started') {
    if (ev.turnId) turn.wireTurnIds.add(ev.turnId);
  } else if (ev.type === 'turn.completed') {
    const payload = ev.payload ?? {};
    if (payload.resultType === 'cancelled') {
      turn.reject(
        turn.yielded
          ? Object.assign(new Error('电脑端已在该会话开始执行，本任务已自动中止让位'), { code: 'YIELDED' })
          : Object.assign(new Error('回合已停止'), { code: 'CANCELLED' })
      );
    } else if (payload.resultType && payload.resultType !== 'success') {
      const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message ?? payload.resultType;
      turn.reject(new Error(`回合失败: ${detail}`));
    } else {
      turn.resolve({
        sessionId: sid,
        response: payload.response ?? turn.streamText,
        usage: payload.usage ?? null,
        projection: null,
      });
    }
  } else if (ev.type === 'turn.failed') {
    const t = ev.payload?.message ?? ev.payload?.error ?? '未知错误';
    turn.reject(new Error(`回合失败: ${typeof t === 'string' ? t : JSON.stringify(t)}`));
  }
}

/** app-server 事件 → LogTail 事件 kind（保持手机端事件格式不变） */
function appServerEventKind(ev) {
  switch (ev.type) {
    case 'turn.started':
      return 'turn_started';
    default:
      // tool.updated 不在此映射：本方回合的工具事件与共享日志（logtail）重复，
      // 统一由 logtail 单通道提供（kind 同为 tool_started/tool_completed）；
      // model.streaming 的增量也不映射进度事件（会刷屏），流式内容走 stream 快照通道
      return null;
  }
}
