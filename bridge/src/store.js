import fs from 'node:fs';
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

/**
 * 桌面端的任务索引（~/.zcode/v2/tasks-index.sqlite）。
 * 桌面删除会话时会把行从 tasks 表移除（无 deleted 标记），而 db.sqlite 仍保留原始会话——
 * 所以「不在索引里」= 已删除。但无头新建的会话要等桌面同步后才进索引（可能滞后），
 * 因此对最近 24h 内的会话做宽限：一律显示。索引文件不存在时（别的机器）不过滤。
 */
const INDEX_GRACE_MS = 24 * 3600 * 1000;
let tasksAliveCache = null;
let tasksAliveAt = 0;

function tasksAliveSet() {
  const file = paths.tasksIndex;
  if (!fs.existsSync(file)) return null;
  const now = Date.now();
  if (tasksAliveCache && now - tasksAliveAt < 10_000) return tasksAliveCache;
  try {
    const ti = new DatabaseSync(file, { readOnly: true });
    const rows = ti.prepare('SELECT task_id FROM tasks WHERE deleted = 0 AND archived = 0').all();
    ti.close();
    tasksAliveCache = new Set(rows.map((r) => r.task_id));
    tasksAliveAt = now;
    return tasksAliveCache;
  } catch {
    return null;
  }
}

/** 会话是否应展示：在桌面索引里，或索引不可用，或 24h 内新建（索引滞后宽限） */
function isVisible(row) {
  const alive = tasksAliveSet();
  if (!alive) return true;
  return alive.has(row.id) || Date.now() - row.time_updated < INDEX_GRACE_MS;
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
        .all(directory, limit * 2)
    : getDb()
        .prepare(
          `SELECT id, title, directory, parent_id, summary_additions, summary_deletions, summary_files,
                  time_created, time_updated
           FROM session WHERE parent_id IS NULL
           ORDER BY time_updated DESC LIMIT ?`
        )
        .all(limit * 2);
  return rows.filter(isVisible).slice(0, limit).map(rowToSession);
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
  const rows = getDb()
    .prepare(
      `SELECT directory, COUNT(*) AS sessionCount, MAX(time_updated) AS lastActive
       FROM session WHERE parent_id IS NULL
       GROUP BY directory ORDER BY lastActive DESC LIMIT 200`
    )
    .all();
  return rows
    .map((r) => {
      // 用过滤后的口径统计，保证与手机会话列表一致
      const visible = getDb()
        .prepare(
          `SELECT id, time_updated FROM session WHERE parent_id IS NULL AND directory = ?`
        )
        .all(r.directory)
        .filter(isVisible);
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
