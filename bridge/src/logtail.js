import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const EVENT_KINDS = {
  'turn.started': 'turn_started',
  'turn.completed': 'turn_completed',
  'model.request.started': 'model_request',
  'tool.call.started': 'tool_started',
  'tool.call.completed': 'tool_completed',
};

/**
 * tail ~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl（本地日期命名，跨天自动切换），
 * 把关心的事件按 sessionId 归类后回调 emit(sessionId, event)。
 * 首次打开从文件末尾开始，避免桥接重启时重放历史事件。
 */
export class LogTail {
  constructor(emit) {
    this.emit = emit;
    this.file = null;
    this.offset = 0;
    this.partial = '';
    this.timer = null;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  tick() {
    let file;
    try {
      file = latestLogFile();
    } catch {
      return; // 日志目录还不存在
    }
    if (!file) return;
    if (file !== this.file) {
      this.file = file;
      this.offset = fs.existsSync(file) ? fs.statSync(file).size : 0; // 只看新增
      this.partial = '';
    }
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < this.offset) this.offset = 0; // 日志轮转/清理后重置
    if (size === this.offset) return;

    let chunk;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
      this.offset = size;
    } catch {
      return;
    }
    this.partial += chunk;
    const lines = this.partial.split('\n');
    this.partial = lines.pop(); // 末行可能不完整，留到下轮
    for (const line of lines) this.handleLine(line);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const kind = EVENT_KINDS[e.event];
    if (!kind || !e.sessionId) return;
    this.emit(e.sessionId, {
      kind,
      toolName: e.context?.toolName ?? null,
      durationMs: e.durationMs ?? null,
      turnId: e.turnId ?? null, // 跨运行时互斥用：协议事件对得上的是自己人，对不上的是外来回合
      timestamp: e.timestamp,
    });
  }
}

function latestLogFile() {
  const files = fs
    .readdirSync(paths.logDir)
    .filter((f) => /^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  return files.length ? path.join(paths.logDir, files[files.length - 1]) : null;
}

/**
 * 启动时回放当日日志，找出「turn.started 之后还没等到 turn.completed」的会话，
 * 作为运行中集合的种子——覆盖桥接重启期间桌面端或其他客户端正在跑的回合。
 * 返回 Map<sessionId, turnStartedTs>：时间戳取日志里 turn.started 事件的时刻，
 * 即回合的真实开始时间（可能早于桥接启动），供看板显示正确的运行时长。
 * 只看近 30 分钟内仍活跃的事件，避免把远古崩溃残留当成运行中。
 */
export function initialRunningSet() {
  const running = new Map(); // sessionId -> turn.started 的时间戳
  const lastSeen = new Map();
  const now = Date.now();
  try {
    const file = latestLogFile();
    if (!file) return running;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e.sessionId) continue;
      if (e.timestamp) lastSeen.set(e.sessionId, Date.parse(e.timestamp) || 0);
      if (e.event === 'turn.started') running.set(e.sessionId, Date.parse(e.timestamp) || now);
      else if (e.event === 'turn.completed') running.delete(e.sessionId);
    }
  } catch {}
  // 超过 30 分钟没有任何事件的，视为历史残留，不算运行中——回合进行中必然会持续
  // 产生事件（模型请求/工具/流式），30 分钟静默只可能是进程被杀没落 turn.completed
  // 的幽灵（测试脚本、强杀），真实长回合不受影响
  for (const sid of running) {
    const ts = lastSeen.get(sid) ?? 0;
    if (now - ts > 30 * 60 * 1000) running.delete(sid);
  }
  return running;
}
