import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const db = new DatabaseSync(path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true });
const SID = 'sess_ba8f1598-9d18-403e-916f-9a083ee7c5c1';

// 全部消息：id（独立列）、role、parent（来自 data.parentID）
const rows = db.prepare('SELECT rowid, id, data, time_created FROM message WHERE session_id = ? ORDER BY rowid').all(SID);
const msgs = rows.map((r) => {
  const d = JSON.parse(r.data);
  return { rowid: r.rowid, id: r.id, role: d.role, parent: d.parentID ?? null, ts: r.time_created, text: '' };
});
// 从 part 表补 text 摘要（每条消息的第一个 text part）
const partStmt = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY rowid');
for (const m of msgs) {
  const parts = partStmt.all(m.id);
  for (const p of parts) {
    try {
      const d = JSON.parse(p.data);
      if (d.type === 'text' && d.text) { m.text = d.text.slice(0, 40); break; }
    } catch {}
  }
}
const ids = new Set(msgs.map((m) => m.id).filter(Boolean));
// 只看最近 24 条，标注 parent 是否存在、是否手机时间段
const out = [];
for (const m of msgs.slice(-24)) {
  const parentExists = m.parent ? ids.has(m.parent) : null;
  out.push(
    `rowid=${m.rowid} ${m.role.padEnd(9)} id=${String(m.id ?? '∅').slice(5, 26).padEnd(22)} parent=${String(m.parent ?? '∅').slice(5, 26).padEnd(22)} parent存在=${parentExists} | ${new Date(m.ts).toLocaleTimeString()} | ${m.text.replace(/\n/g, ' ')}`
  );
}fs.writeFileSync('E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android' + path.sep + 'bridge' + path.sep + 'chain-dump.txt', out.join('\n'), 'utf8');
db.close();
console.log('written');
