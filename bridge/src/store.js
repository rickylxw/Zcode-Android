import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as archive from './archive.js';
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

/**
 * 桌面端的任务索引（~/.zcode/v2/tasks-index.sqlite）。
 * 桌面删除会话 = 从索引移除行（db.sqlite 仍保留）→「不在索引」= 已删除，
 * 但无头新建的会话要等桌面同步才进索引，所以 24h 内的新会话宽限显示。
 * 桌面归档（archived=1）与手机归档打通：都算已归档，主列表隐藏、归档视图可见。
 * 索引文件不存在时不过滤。
 */
const INDEX_GRACE_MS = 24 * 3600 * 1000;
let indexCache = null;
let indexAt = 0;

/** 桌面任务索引：task_id -> archived 标志（仅 deleted=0 的行）；无索引文件返回 null */
function taskIndex() {
  if (!fs.existsSync(paths.tasksIndex)) return null;
  const now = Date.now();
  if (indexCache && now - indexAt < 10_000) return indexCache;
  try {
    const ti = new DatabaseSync(paths.tasksIndex, { readOnly: true });
    const rows = ti.prepare('SELECT task_id, archived FROM tasks WHERE deleted = 0').all();
    ti.close();
    indexCache = new Map(rows.map((r) => [r.task_id, r.archived]));
    indexAt = now;
    return indexCache;
  } catch {
    return null;
  }
}

/** 未被桌面删除：在索引里，或索引不可用，或 24h 宽限内的新会话 */
function notDeleted(row, index) {
  return index == null || index.has(row.id) || Date.now() - row.time_updated < INDEX_GRACE_MS;
}

/** 归档 = 手机侧归档（archive.json）或 桌面端归档（tasks-index archived=1） */
export function isSessionArchived(id) {
  return archive.isArchived(id) || taskIndex()?.get(id) === 1;
}

export function listSessions({ directory, limit = 200, archived = false } = {}) {
  const index = taskIndex();
  const rows = directory
    ? getDb()
        .prepare(
          `SELECT id, title, directory, parent_id, summary_additions, summary_deletions, summary_files,
                  time_created, time_updated
           FROM session WHERE directory = ? AND parent_id IS NULL
           ORDER BY time_updated DESC LIMIT ?`
        )
        .all(directory, limit * 2)
    : getDb()
        .prepare(
          `SELECT id, title, directory, parent_id, summary_additions, summary_deletions, summary_files,
                  time_created, time_updated
           FROM session WHERE parent_id IS NULL
           ORDER BY time_updated DESC LIMIT ?`
        )
        .all(limit * 2);
  return rows
    .filter((r) => notDeleted(r, index))
    .filter((r) => isSessionArchived(r.id) === archived)
    .slice(0, limit)
    .map(rowToSession);
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
  const index = taskIndex();
  const rows = getDb()
    .prepare(
      `SELECT directory, COUNT(*) AS sessionCount, MAX(time_updated) AS lastActive
       FROM session WHERE parent_id IS NULL
       GROUP BY directory ORDER BY lastActive DESC LIMIT 200`
    )
    .all();
  return rows
    .map((r) => {
      // 与会话列表同口径：排除已删除与已归档
      const visible = getDb()
        .prepare(
          `SELECT id, time_updated FROM session WHERE parent_id IS NULL AND directory = ?`
        )
        .all(r.directory)
        .filter((v) => notDeleted(v, index) && !isSessionArchived(v.id));
      return {
        directory: r.directory,
        sessionCount: visible.length,
        lastActive: visible.length ? Math.max(...visible.map((v) => v.time_updated)) : 0,
      };
    })
    .filter((r) => r.sessionCount > 0)
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, 100);
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

/**
 * Token 用量汇总（来自 turn_usage 表，status=completed 的回合）。
 * 返回 今日 / 近7天 / 累计 三组：回合数、输入/输出/推理/缓存/总 token、总时长。
 */
export function usageSummary() {
  const dayMs = 24 * 3600 * 1000;
  const now = Date.now();
  const localMidnight = new Date(now);
  localMidnight.setHours(0, 0, 0, 0);

  const agg = (since) => {
    const row = since == null
      ? getDb()
          .prepare(
            `SELECT COUNT(*) AS turns,
                    COALESCE(SUM(input_tokens),0) AS inputTokens,
                    COALESCE(SUM(output_tokens),0) AS outputTokens,
                    COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens,
                    COALESCE(SUM(cache_read_input_tokens),0) AS cacheRead,
                    COALESCE(SUM(cache_creation_input_tokens),0) AS cacheWrite,
                    COALESCE(SUM(computed_total_tokens),0) AS totalTokens,
                    COALESCE(SUM(duration_ms),0) AS durationMs
             FROM turn_usage WHERE status = 'completed'`
          )
          .get()
      : getDb()
          .prepare(
            `SELECT COUNT(*) AS turns,
                    COALESCE(SUM(input_tokens),0) AS inputTokens,
                    COALESCE(SUM(output_tokens),0) AS outputTokens,
                    COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens,
                    COALESCE(SUM(cache_read_input_tokens),0) AS cacheRead,
                    COALESCE(SUM(cache_creation_input_tokens),0) AS cacheWrite,
                    COALESCE(SUM(computed_total_tokens),0) AS totalTokens,
                    COALESCE(SUM(duration_ms),0) AS durationMs
             FROM turn_usage WHERE status = 'completed' AND started_at >= ?`
          )
          .get(since);
    return {
      turns: row.turns,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      cacheReadTokens: row.cacheRead,
      cacheWriteTokens: row.cacheWrite,
      totalTokens: row.totalTokens,
      durationMs: row.durationMs,
    };
  };

  return {
    today: agg(localMidnight.getTime()),
    last7Days: agg(now - 7 * dayMs),
    allTime: agg(null),
  };
}

/** 按天分列的近 n 天用量（用于面板柱状/明细） */
export function usageDaily(days = 7) {
  const dayMs = 24 * 3600 * 1000;
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const start = dayStart.getTime() - i * dayMs;
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS turns,
                COALESCE(SUM(input_tokens),0) AS inputTokens,
                COALESCE(SUM(output_tokens),0) AS outputTokens,
                COALESCE(SUM(computed_total_tokens),0) AS totalTokens
         FROM turn_usage WHERE status = 'completed' AND started_at >= ? AND started_at < ?`
      )
      .get(start, start + dayMs);
    out.push({
      date: new Date(start).toISOString().slice(0, 10),
      turns: row.turns,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
    });
  }
  return out;
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
