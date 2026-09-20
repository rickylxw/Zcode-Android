import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 任务归档（桥接侧状态，不写 ZCode 自己的数据库）。
 * 存储：bridge/archive.json —— { "archived": { "<sessionId>": <归档时间戳> } }
 * 已归档的会话不出现在主列表；?archived=1 时单独列出。桌面端行为不受影响。
 */

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(bridgeRoot, 'archive.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = { archived: {} };
  }
  if (!cache.archived || typeof cache.archived !== 'object') cache.archived = {};
  return cache;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(load(), null, 2));
  } catch {}
}

export function isArchived(id) {
  return Boolean(load().archived[id]);
}

export function archivedAt(id) {
  return load().archived[id] ?? null;
}

export function setArchived(id, archived) {
  const data = load();
  if (archived) data.archived[id] = Date.now();
  else delete data.archived[id];
  save();
  return true;
}
