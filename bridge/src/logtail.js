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
