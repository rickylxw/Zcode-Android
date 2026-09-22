// 审批流端到端：build 模式发起写文件任务 → 桥接转发权限请求 → 手机应答 allow → 工具执行
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'bridge.config.json'), 'utf8'));
const port = process.env.BRIDGE_PORT ?? 8787;
const DIRECTORY = 'E:/Documents/GitHub/ZCode Android/.probe';

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${cfg.token}`);
const t0 = Date.now();
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'prompt', requestId: 'ap1', sessionId: null, directory: DIRECTORY, mode: 'build', prompt: '在当前目录创建文件 approval-test.txt，内容为一行文字：APPROVED。完成后回复 APPROVAL_OK' }));
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'request') {
    console.log('← 收到交互请求:', m.kind, '| 工具:', m.toolName, '| 风险:', m.riskLevel, '| 耗时', Date.now() - t0, 'ms');
    const opt = (m.options ?? []).find((o) => o.optionId === 'allow_once');
    console.log('   → 应答 allow_once:', JSON.stringify(opt?.response ?? null));
    ws.send(JSON.stringify({ type: 'respond', requestId: m.requestId, response: opt.response }));
  } else if (m.type === 'result') {
    const file = fs.existsSync(path.join(DIRECTORY, 'approval-test.txt'))
      ? fs.readFileSync(path.join(DIRECTORY, 'approval-test.txt'), 'utf8').trim() : '(文件不存在)';
    console.log('← result:', JSON.stringify(m.response?.slice(0, 40)), '| approval-test.txt 内容:', JSON.stringify(file));
    console.log(file === 'APPROVED' && /APPROVAL_OK/.test(m.response ?? '') ? '\nPASS：审批 → 放行 → 工具真实执行 → 回合完成' : '\nFAIL');
    process.exit(0);
  } else if (m.type === 'error') {
    console.log('← error:', m.message);
    process.exit(1);
  }
});
setTimeout(() => { console.log('FAIL: 120s 超时（未收到审批请求或回合未完成）'); process.exit(1); }, 120000);
