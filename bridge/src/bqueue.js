import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

/**
 * 桥接自有的待发送队列（bridge/queue.json）。
 *
 * 背景：桌面端运行中的会话把队列持有在自己的内存里，外部直接改 ZCode 数据库的
 * session_input 行不会影响它（会被内存态覆盖/忽略）——这就是「手机操作待发送
 * 队列对电脑端无效」的原因。
 *
 * 方案：手机端的排队/编辑/调整落在桥接自己的队列里；桥接检测到该会话空闲
 * （日志真源无运行中回合）时，逐条用无头 --resume 真正发送执行。
 * 效果：消息会真实出现在桌面会话里并被处理，手机端也能看到整个过程。
 */

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(bridgeRoot, 'queue.json');

let cache = null;

// 注意：不做进程内缓存——手机 App 的写入走桥接进程，但调试脚本/多实例会直写文件，
// 每次直读（文件极小）才能保证任何来源的变更立即可见。
function load() {
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = {};
  }
  for (const k of Object.keys(cache)) {
    if (!Array.isArray(cache[k])) delete cache[k];
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

export function list(sessionId) {
  return load()[sessionId] ?? [];
}

export function add(sessionId, text) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('内容不能为空');
  const q = load();
  (q[sessionId] ??= []).push({
    id: 'bq_' + crypto.randomBytes(6).toString('hex'),
    text: clean.slice(0, 4000),
    ts: Date.now(),
  });
  save();
  return true;
}

/** 失败回退时插回队首（保持顺序） */
export function addFront(sessionId, text, ts) {
  const q = load();
  (q[sessionId] ??= []).unshift({ id: 'bq_' + crypto.randomBytes(6).toString('hex'), text, ts: ts ?? Date.now() });
  save();
  return true;
}

export function remove(sessionId, id) {
  const arr = load()[sessionId];
  if (!arr) return false;
  const i = arr.findIndex((x) => x.id === id);
  if (i < 0) return false;
  arr.splice(i, 1);
  if (!arr.length) delete load()[sessionId];
  save();
  return true;
}

export function move(sessionId, id, dir) {
  const arr = load()[sessionId] ?? [];
  const i = arr.findIndex((x) => x.id === id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= arr.length) return true;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  save();
  return true;
}

export function clear(sessionId) {
  delete load()[sessionId];
  save();
  return true;
}

export function allQueued() {
  return load();
}
