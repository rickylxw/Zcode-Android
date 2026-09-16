import { DatabaseSync } from 'node:sqlite';
import { paths } from './config.js';

/**
 * 只读访问 ZCode CLI 的会话数据库（与桌面 App 共用，WAL 模式下并发只读安全）。
 * 表结构（v0.16.5）：
 *   session(id, title, directory, summary_additions/deletions/files, time_created, time_updated, ...)
 *   message(id, session_id, data JSON: {role, time:{created,completed}, modelID, ...})
 *   part(message_id, session_id, data JSON: {type: text|reasoning|tool|step-start|step-finish, ...})
 *   tool part: {type:'tool', callID, tool, state:{status, input, output?}}
 */

let db = null;

function getDb() {
  if (!db) db = new DatabaseSync(paths.db, { readOnly: true });
  return db;
}

export function listSessions({ directory, limit = 200 } = {}) {
  const rows = directory
    ? getDb()
        .prepare(
          `SELECT id, title, directory, parent_id, summary_additions, summary_deletions, summary_files,
                  time_created, time_updated
           FROM session WHERE directory = ? AND parent_id IS NULL
           ORDER BY time_updated DESC LIMIT ?`
        )
        .all(directory, limit)
    : getDb()
        .prepare(
          `SELECT id, title, directory, parent_id, summary_additions, summary_deletions, summary_files,
                  time_created, time_updated
           FROM session WHERE parent_id IS NULL
           ORDER BY time_updated DESC LIMIT ?`
        )
        .all(limit);
  return rows.map(rowToSession);
}

export function getSession(id) {
  const row = getDb()
    .prepare(
      `SELECT id, title, directory, parent_id, summary_additions, summary_deletions, summary_files,
              time_created, time_updated
       FROM session WHERE id = ?`
    )
    .get(id);
  return row ? rowToSession(row) : null;
}

export function listProjects() {
  return getDb()
    .prepare(
      `SELECT directory, COUNT(*) AS sessionCount, MAX(time_updated) AS lastActive
       FROM session WHERE parent_id IS NULL
       GROUP BY directory ORDER BY lastActive DESC LIMIT 100`
    )
    .all();
}

/**
 * 会话完整历史，归一化为手机端易渲染的结构：
 * messages: [{ id, role, timeCreated, blocks: [{type:'text'|'reasoning'|'tool', ...}] }]
 */
export function getMessages(sessionId) {
  const msgs = getDb()
    .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY rowid')
    .all(sessionId);
  const parts = getDb()
    .prepare(
      `SELECT p.message_id, p.data FROM part p JOIN message m ON p.message_id = m.id
       WHERE m.session_id = ? ORDER BY p.rowid`
    )
    .all(sessionId);
  const byMsg = new Map();
  for (const p of parts) {
    if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, []);
    byMsg.get(p.message_id).push(JSON.parse(p.data));
  }
  return msgs.map((m) => {
    const d = JSON.parse(m.data);
    const blocks = [];
    for (const part of byMsg.get(m.id) ?? []) {
      if (part.type === 'text' && part.text) {
        blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'reasoning' && part.text) {
        blocks.push({ type: 'reasoning', text: part.text });
      } else if (part.type === 'tool') {
        blocks.push({
          type: 'tool',
          tool: part.tool,
          status: part.state?.status ?? 'unknown',
          inputPreview: previewInput(part.state?.input),
        });
      }
      // step-start / step-finish 对渲染无意义，跳过
    }
    return { id: m.id, role: d.role, timeCreated: d.time?.created ?? null, blocks };
  });
}

function previewInput(input) {
  if (input == null) return '';
  let s;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return String(input);
  }
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

function rowToSession(r) {
  return {
    id: r.id,
    title: r.title,
    directory: r.directory,
    parentId: r.parent_id,
    additions: r.summary_additions,
    deletions: r.summary_deletions,
    files: r.summary_files,
    timeCreated: r.time_created,
    timeUpdated: r.time_updated,
  };
}
