// CLI 升级回归：跑 probe discover（免费），断言 create/setModel/无 prefs 重问仍正常。
// 用法：node test/regression.mjs   （升级 ZCode 后先跑这个，失败再跑 perm/ask 深查）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [path.join(root, 'appserver-probe.mjs'), 'discover'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
let out = '';
child.stdout.on('data', (d) => (out += d.toString()));
child.on('exit', (code) => {
  const checks = {
    '探针退出码 0': code === 0,
    'session/create 成功': /sessionId: sess_[\w-]+/.test(out),
    'runtimePreferences 只问一次（无死循环）': /询问次数: 1/.test(out),
    'setModel 被接受': /setModel → \{"messages"/.test(out),
    '无 ZodError 拒绝': !/Unrecognized keys|Invalid params/.test(out),
  };
  let ok = true;
  for (const [name, pass] of Object.entries(checks)) {
    console.log((pass ? '✓' : '✗'), name);
    if (!pass) ok = false;
  }
  console.log(ok ? '\n回归通过：当前 CLI 与 bridge 的 app-server 引擎兼容' : '\n回归失败：CLI 协议漂移——按失败项查 docs/appserver-reverse-progress.md §4 修正');
  process.exit(ok ? 0 : 1);
});
