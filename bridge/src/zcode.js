import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { paths } from './config.js';
import { applyModelSelection, ensureResumableSelection, setDefaultModel } from './selection.js';

const DEFAULT_MODE = 'yolo'; // 无头模式下 CLI 默认即 yolo；手机端可选 plan/build/edit
const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const VALID_MODES = new Set(['build', 'edit', 'plan', 'yolo']);

/**
 * 环境保持原样透传即可。
 * 实测（0.16.9）：独立无头运行时 CLI 自带 provider 默认解析，直连一切正常；
 * 若注入桌面端的 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE / ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
 * （桌面 host 进程专用），反而会破坏模型解析，resume 全部报 Model creation failed。
 * 旧格式会话（builtin:bigmodel 等旧 id）无论是否注入都续接不了，由错误提示兜底。
 */
function headlessEnv() {
  return { ...process.env };
}

/**
 * 回合任务注册表。
 * 锁的粒度是「会话」：已有会话用其 sess_id；新会话尚无 id，用 `new:<directory>` 占位。
 * 进度事件路由（LogTail 的 sessionId → job）由 server 层完成，新会话在首条
 * 日志事件到达时反查 SQLite（目录 + 创建时间匹配）建立绑定。
 */
const jobs = new Map(); // jobId -> job
const locks = new Map(); // lockKey -> jobId

export function getJob(jobId) {
  return jobs.get(jobId) ?? null;
}

export function runningJobForSession(sessionId) {
  for (const j of jobs.values()) if (j.sessionId === sessionId) return j;
  return null;
}

/** 新会话的 job（尚无 sess_id），供进度事件做目录匹配绑定 */
export function pendingNewJobs() {
  return [...jobs.values()].filter((j) => j.sessionId === null);
}

/** 全部活跃 job（含已绑定会话的），供状态快照兜底（同 appserver.appServerAllTurns） */
export function allJobs() {
  return [...jobs.values()];
}

export function stopJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  // Windows 上需要杀进程树（zcode 会再 spawn 子进程），taskkill /T 最可靠
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], () => {});
  } else {
    job.child.kill('SIGTERM');
  }
  return true;
}

/**
 * 执行一个无头回合，resolve 出 { sessionId, response, usage, projection }。
 * onJob(job) 在 spawn 后同步回调，调用方可立即拿到 jobId（用于发送 prompt_accepted、支持随时停止）。
 * model：用户指定的模型（如 GLM-5.3）。CLI 无 --model 参数，
 * 续接时改写会话的模型选择记录，新会话时改写 config.json 默认模型。
 */
export function runTurn({ sessionId = null, directory, prompt, mode = DEFAULT_MODE, model = null, onJob }) {
  return new Promise((resolve, reject) => {
    if (!VALID_MODES.has(mode)) return reject(new Error(`无效的权限模式: ${mode}（可选 build/edit/plan/yolo）`));
    if (!prompt || !prompt.trim()) return reject(new Error('prompt 不能为空'));
    if (!fs.existsSync(directory)) return reject(new Error(`项目目录不存在: ${directory}`));

    const lockKey = sessionId ?? `new:${directory}`;
    if (locks.has(lockKey)) {
      return reject(Object.assign(new Error('该会话正在执行中，请等待完成或先停止'), { code: 'BUSY' }));
    }

    // 模型选择：续接改写会话选择记录；新会话改写 CLI 全局默认。失败不阻塞（用默认模型跑）
    if (sessionId) {
      ensureResumableSelection(sessionId);
      if (model) applyModelSelection(sessionId, model);
    } else if (model) {
      setDefaultModel(model);
    }

    const args = [
      paths.zcodeCjs,
      '--cwd',
      directory,
      '--json',
      '--no-color',
      '--mode',
      mode,
      ...(sessionId ? ['--resume', sessionId] : []),
      '-p',
      prompt,
    ];
    const child = spawn(process.execPath, args, {
      cwd: directory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: headlessEnv(),
    });

    const job = {
      id: 'turn_' + crypto.randomBytes(6).toString('hex'),
      child,
      sessionId,
      directory,
      startedAt: Date.now(),
    };
    jobs.set(job.id, job);
    locks.set(lockKey, job.id);
    onJob?.(job);

    let stdout = '';
    let stderr = '';
    const stdoutLimit = 4 * 1024 * 1024;
    child.stdout.on('data', (d) => {
      if (stdout.length < stdoutLimit) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });

    const timer = setTimeout(() => stopJob(job.id), TURN_TIMEOUT_MS);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      jobs.delete(job.id);
      if (locks.get(lockKey) === job.id) locks.delete(lockKey);
    };

    child.on('error', (err) => {
      cleanup();
      reject(new Error(`无法启动 ZCode CLI: ${err.message}`));
    });

    child.on('exit', (code) => {
      cleanup();
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-8).join('\n');
        return reject(new Error(`ZCode 退出码 ${code}: ${tailnote(tail) || '无错误输出'}`));
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(new Error(`ZCode 输出不是 JSON: ${stdout.slice(0, 500)}`));
      }
      resolve({
        sessionId: parsed.sessionId ?? sessionId,
        response: parsed.response ?? '',
        usage: parsed.usage ?? null,
        projection: parsed.projection ?? null,
      });
    });
  });
}

/** 在原始报错后追加面向用户的处置建议 */
function tailnote(tail) {
  if (!tail) return tail;
  if (/Model creation failed|Select a model|无法定位.*provider|provider config/i.test(tail)) {
    return (
      tail +
      '\n提示：该会话绑定的模型当前不可用（常见于订阅版 start-plan 模型的旧会话，或 CLI 升级后 provider 变更）。' +
      '解决办法：在电脑端 ZCode 打开该会话切换一次模型，或从手机「新任务」发起新会话。'
    );
  }
  return tail;
}
