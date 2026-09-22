import crypto from 'node:crypto';
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
 * messages: [{ id, role, semantic, timeCreated, blocks: [{type:'text'|'reasoning'|'tool', ...}] }]
 * semantic = 消息语义（user_prompt=真实用户输入）；运行时内部注入的 user 消息
 * （todo_reminder / background_notification）不下发。
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
  const out = [];
  for (const m of msgs) {
    const d = JSON.parse(m.data);
    const semantic = d.semantics?.kind ?? null;
    // role=user 的消息里混有运行时内部注入（todo 提醒、后台任务通知），不是真实用户输入，
    // 也不是对话内容——直接不下发（真实输入 = real_user/user_prompt）
    if (d.role === 'user' && semantic && semantic !== 'user_prompt') continue;
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
    out.push({ id: m.id, role: d.role, semantic, timeCreated: d.time?.created ?? null, blocks });
  }
  return out;
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
 * 流式 todo：取该会话最新的 TodoWrite 工具输入里的待办清单（rowid > afterRowid 的增量）。
 * 返回 { todos: [{content,status}] | null, lastRowid }——todos 为 null 表示增量里没有
 * 新的 TodoWrite，lastRowid 是已扫描到的水位（调用方下轮传入，避免每秒全量回扫）。
 */
export function getStreamingTodo(sessionId, afterRowid = 0) {
  const maxRid = getDb()
    .prepare('SELECT MAX(p.rowid) AS rid FROM part p JOIN message m ON p.message_id = m.id WHERE m.session_id = ?')
    .get(sessionId)?.rid ?? 0;
  if (maxRid <= afterRowid) return { todos: null, lastRowid: afterRowid };
  const row = getDb()
    .prepare(
      `SELECT p.rowid AS rid, p.data FROM part p JOIN message m ON p.message_id = m.id
       WHERE m.session_id = ? AND p.rowid > ? AND p.rowid <= ? AND p.data LIKE '%"tool":"TodoWrite"%'
       ORDER BY p.rowid DESC LIMIT 1`
    )
    .get(sessionId, afterRowid, maxRid);
  if (!row) return { todos: null, lastRowid: maxRid };
  try {
    const d = JSON.parse(row.data);
    const todos = (d.state?.input?.todos ?? [])
      .map((t) => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending') }));
    return { todos, lastRowid: maxRid };
  } catch {
    return { todos: null, lastRowid: maxRid };
  }
}

/**
 * 流式快照：取最新一条助手消息当前已生成的文本（文本块 + 思考块分开）。
 * 无头 CLI 流式写入 part 表，回合进行中轮询本函数即可得到渐增的文本。
 */
export function getStreamingSnapshot(sessionId) {
  const db = getDb();
  // role 存在 data JSON 里而不是列上，用 LIKE 粗筛后取最新一条
  const msg = db
    .prepare("SELECT id, data FROM message WHERE session_id = ? AND data LIKE '%\"role\":\"assistant\"%' ORDER BY rowid DESC LIMIT 1")
    .get(sessionId);
  if (!msg) return { text: '', reasoning: '' };
  const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY rowid').all(msg.id);
  const text = [];
  const reasoning = [];
  for (const p of parts) {
    try {
      const d = JSON.parse(p.data);
      if (d.type === 'text' && d.text) text.push(d.text);
      else if (d.type === 'reasoning' && d.text) reasoning.push(d.text);
    } catch {}
  }
  return { text: text.join('\n\n'), reasoning: reasoning.join('\n\n') };
}

/**
 * 会话的待发送输入：桌面端排队中、尚未发给模型的用户指令。
 * 真正待发送 = delivery='queue' 且 status='admitted'（promoted=已发送、cancelled/discarded=已取消）。
 * backgroundNotification 是系统通知不入列表。
 */
export function queuedInputs(sessionId) {
  const rows = getDb()
    .prepare(
      "SELECT id, kind, payload, time_created FROM session_input WHERE session_id = ? AND delivery = 'queue' AND status = 'admitted' AND kind != 'backgroundNotification' ORDER BY admitted_sequence"
    )
    .all(sessionId);
  return rows.map((r) => {
    let text = '';
    try {
      text = String(JSON.parse(r.payload).text ?? '');
    } catch {}
    return { id: r.id, kind: r.kind, text: text.slice(0, 500), timeCreated: r.time_created };
  });
}

/** 各会话的待发送数量（供会话列表角标），Map<sessionId, count> */
export function queuedCounts() {
  const rows = getDb()
    .prepare(
      "SELECT session_id, COUNT(*) AS c FROM session_input WHERE delivery = 'queue' AND status = 'admitted' AND kind != 'backgroundNotification' GROUP BY session_id"
    )
    .all();
  return new Map(rows.map((r) => [r.session_id, r.c]));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 把会话登记进桌面的任务索引（tasks-index.sqlite 的 tasks 表）。
 * 无头 CLI 创建/续接的会话不会自动进该索引，导致桌面端任务列表里看不到手机发起的任务。
 * 只补缺失行（INSERT OR IGNORE），绝不修改桌面自己管理的行（置顶/归档/删除等）。
 */
export function syncTasksIndex(sessionId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let ti = null;
    try {
      const s = getSession(sessionId);
      if (!s) return false;
      const db = getDb();
      const firstUser = db
        .prepare("SELECT data FROM message WHERE session_id = ? AND data LIKE '%\"role\":\"user\"%' ORDER BY rowid LIMIT 1")
        .get(sessionId);
      let firstText = '';
      if (firstUser) {
        try {
          firstText = String(JSON.parse(firstUser.data).text ?? '');
        } catch {}
      }
      let model = '';
      const selRow = db.prepare('SELECT data FROM session_entry WHERE id = ?').get(`${sessionId}:runtime-model-selection`);
      if (selRow) {
        try {
          const sel = JSON.parse(selRow.data).modelSelection ?? {};
          if (sel.providerId && sel.modelId) model = `${sel.providerId}/${sel.modelId}`;
        } catch {}
      }
      ti = new DatabaseSync(paths.tasksIndex);
      ti.prepare(
        `INSERT INTO tasks
         (workspace_key, workspace_path, workspace_identity, task_id, title, task_status, provider, mode, model,
          migration_source, forked_from_task_id, created_at, updated_at, unread_at, last_unread_at,
          pinned, archived, deleted, title_overridden, meta_json, searchable_text, cron_automation_id, off_peak_task_id)
         VALUES (?, ?, NULL, ?, ?, 'completed', 'glm', 'yolo', ?, NULL, NULL, ?, ?, NULL, 0, 0, 0, 0, 0, ?, ?, NULL, NULL)
         ON CONFLICT(workspace_key, task_id) DO UPDATE SET
           title = excluded.title,
           task_status = 'completed',
           updated_at = excluded.updated_at,
           model = excluded.model
         WHERE tasks.deleted = 0 AND tasks.archived = 0`
      ).run(
        s.directory,
        s.directory,
        sessionId,
        s.title || '未命名任务',
        model,
        s.timeCreated,
        Date.now(),
        JSON.stringify({ taskId: sessionId, title: s.title || '未命名任务' }),
        (firstText || s.title || '').slice(0, 2000)
      );
      ti.close();
      return true;
    } catch (e) {
      ti?.close();
      if (!/busy|locked/i.test(String(e?.message))) {
        console.error('syncTasksIndex failed:', e?.message);
        return false;
      }
      sleepSync(300);
    }
  }
  return false;
}

/** 启动回填：把「不在索引里的近期会话」补进桌面任务索引 */
export function backfillTasksIndex(limit = 50) {
  const index = taskIndex();
  if (index == null) return; // 索引文件不存在（桌面从未在此机器启动）
  const rows = getDb()
    .prepare('SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ?')
    .all(limit);
  let n = 0;
  for (const r of rows) {
    if (!index.has(r.id)) {
      if (syncTasksIndex(r.id)) n++;
    }
  }
  if (n > 0) console.log(`  已把 ${n} 个缺失会话补进桌面任务索引`);
}

/** 可写句柄（桌面可能持有锁，带重试）；用完必须 close */
function withWritableDb(fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let db = null;
    try {
      db = new DatabaseSync(paths.db);
      const result = fn(db);
      db.close();
      return result;
    } catch (e) {
      db?.close();
      if (!/busy|locked/i.test(String(e?.message))) throw e;
      sleepSync(300);
    }
  }
  throw new Error('数据库被电脑端占用，请稍后重试');
}

function queueRow(sessionId, id, text, seq) {
  return {
    id,
    session_id: sessionId,
    kind: 'sendText',
    delivery: 'queue',
    payload: JSON.stringify({ text, intent: { sourceCommandId: id.replace(/^queue_/, ''), queueItemId: id } }),
    admitted_sequence: seq,
    promoted_sequence: null,
    promoted_message_id: null,
    status: 'admitted',
    status_reason: null,
    time_created: Date.now(),
    time_updated: Date.now(),
  };
}

/** 手机端新增待发送指令（排在队尾） */
export function addQueued(sessionId, text) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('内容不能为空');
  return withWritableDb((db) => {
    const maxSeq = db
      .prepare('SELECT COALESCE(MAX(admitted_sequence), 0) AS m FROM session_input WHERE session_id = ?')
      .get(sessionId).m;
    const id = 'queue_' + crypto.randomUUID();
    const row = queueRow(sessionId, id, clean, maxSeq + 1);
    db.prepare(
      `INSERT INTO session_input (id, session_id, kind, delivery, payload, admitted_sequence, promoted_sequence, promoted_message_id, status, status_reason, time_created, time_updated)
       VALUES (@id, @session_id, @kind, @delivery, @payload, @admitted_sequence, @promoted_sequence, @promoted_message_id, @status, @status_reason, @time_created, @time_updated)`
    ).run(row);
    return { id };
  });
}

/** 取消一条待发送（与桌面取消语义一致：status → cancelled，不物理删除） */
export function removeQueued(sessionId, id) {
  return withWritableDb((db) => {
    const res = db
      .prepare("UPDATE session_input SET status = 'cancelled', time_updated = ? WHERE id = ? AND session_id = ? AND status = 'admitted'")
      .run(Date.now(), id, sessionId);
    if (res.changes === 0) throw new Error('该条不存在或已发送');
    return true;
  });
}

/** 清空会话的全部待发送 */
export function clearQueued(sessionId) {
  return withWritableDb((db) => {
    db.prepare("UPDATE session_input SET status = 'cancelled', time_updated = ? WHERE session_id = ? AND delivery = 'queue' AND status = 'admitted'")
      .run(Date.now(), sessionId);
    return true;
  });
}

/** 调整顺序：与相邻一条交换 admitted_sequence（dir: 'up' | 'down'） */
export function moveQueued(sessionId, id, dir) {
  return withWritableDb((db) => {
    const rows = db
      .prepare("SELECT id, admitted_sequence AS seq FROM session_input WHERE session_id = ? AND delivery = 'queue' AND status = 'admitted' ORDER BY admitted_sequence")
      .all(sessionId);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error('该条不存在或已发送');
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= rows.length) return true; // 已在边缘
    const a = rows[idx];
    const b = rows[swapIdx];
    const upd = db.prepare('UPDATE session_input SET admitted_sequence = ?, time_updated = ? WHERE id = ?');
    upd.run(b.seq, Date.now(), a.id);
    upd.run(a.seq, Date.now(), b.id);
    return true;
  });
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
