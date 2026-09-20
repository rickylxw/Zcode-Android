import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const db = new DatabaseSync(path.join(os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite'), { readOnly: true });
const row = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 1').get();
const lines = [];
for (const [k, v] of Object.entries(row)) {
  lines.push(`${k} = ${typeof v === 'string' && v.length > 120 ? JSON.stringify(v.slice(0, 120)) + '…' : JSON.stringify(v)}`);
}
fs.writeFileSync('E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android' + path.sep + 'bridge' + path.sep + 'task-row.txt', lines.join('\n'), 'utf8');
// 顺便看分组排序表
const g = db.prepare('SELECT * FROM task_group_view_node_orders LIMIT 2').all();
lines.push('--- task_group_view_node_orders ---');
for (const r of g) lines.push(JSON.stringify(r));
fs.writeFileSync('E:' + path.sep + 'Documents' + path.sep + 'GitHub' + path.sep + 'ZCode Android' + path.sep + 'bridge' + path.sep + 'task-row.txt', lines.join('\n'), 'utf8');
db.close();
console.log('written');
