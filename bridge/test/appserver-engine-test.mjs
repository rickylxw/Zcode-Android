// app-server 引擎直测：绕过 server.js，直接驱动 appServerTurn，验证
// 进度事件、流式快照累积与最终结果。
//   node test/appserver-engine-test.mjs [sessionId]
// 带 sessionId 时走 resume（纯文本回合，省一次工具调用）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appServerStreamSnapshot, appServerTurn } from '../src/appserver.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionId = process.argv[2] ?? null;
const directory = 'E:\\Documents\\GitHub\\ZCode Android\\.probe';

const kinds = new Set();
let snapshotOk = false;

const result = await appServerTurn({
  sessionId,
  directory,
  mode: 'yolo',
  prompt: sessionId ? 'Reply with exactly: ENGINE_RESUME_OK' : 'Reply with exactly: ENGINE_NEW_OK',
  onJob: (job) => {
    console.log('job:', job.id, 'sid:', job.sessionId);
    const timer = setInterval(() => {
      const snap = appServerStreamSnapshot(job.id);
      if (snap && (snap.text || snap.reasoning)) {
        snapshotOk = true;
        clearInterval(timer);
        console.log('snapshot 首次非空:', JSON.stringify(snap).slice(0, 120));
      }
    }, 300);
    setTimeout(() => clearInterval(timer), 120000);
  },
  onEvent: (sid, ev) => {
    kinds.add(ev.kind);
    console.log(`ev [${ev.kind}] sid=${sid?.slice(5, 13)}`);
  },
});

console.log('result:', JSON.stringify(result.response), '| sessionId:', result.sessionId);
console.log('usage:', JSON.stringify(result.usage)?.slice(0, 160));
const ok = /ENGINE_(NEW|RESUME)_OK/.test(result.response ?? '') && kinds.has('turn_started') && kinds.has('turn_completed');
console.log(ok && (snapshotOk || sessionId) ? 'PASS' : `FAIL (kinds=[${[...kinds]}], snapshotOk=${snapshotOk})`);
process.exit(0);
