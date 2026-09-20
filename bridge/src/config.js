import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const home = os.homedir();
const zcodeHome = path.join(home, '.zcode');

const DEFAULT_ZCODE_CJS_CANDIDATES = [
  'E:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs',
  'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs',
];

function resolveZcodeCjs() {
  if (process.env.ZCODE_CJS) return process.env.ZCODE_CJS;
  for (const p of DEFAULT_ZCODE_CJS_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    '找不到 zcode.cjs。请用环境变量 ZCODE_CJS 指定 ZCode CLI 主程序路径（通常位于 ZCode 安装目录 resources/glm/zcode.cjs）'
  );
}

export const paths = {
  zcodeCjs: resolveZcodeCjs(),
  zcodeHome,
  cliDir: path.join(zcodeHome, 'cli'),
  cliConfig: path.join(zcodeHome, 'cli', 'config.json'),
  v2Config: path.join(zcodeHome, 'v2', 'config.json'),
  v2ProviderConfig: path.join(zcodeHome, 'v2', 'provider_config.json'),
  tasksIndex: path.join(zcodeHome, 'v2', 'tasks-index.sqlite'),
  builtinCatalog: path.join(path.parse(resolveZcodeCjs()).root, 'Program Files', 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
  db: path.join(zcodeHome, 'cli', 'db', 'db.sqlite'),
  logDir: path.join(zcodeHome, 'cli', 'log'),
};

/**
 * ZCode 桌面安装目录里的内置 provider 目录（zcode-builtin.json，定义 bigmodel、start-plan 等）。
 * CLI 0.16.9 起无头运行若缺少 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE，resume 引用 builtin 或
 * account 前缀 provider 的会话会报「无法定位 builtin provider config / Model creation failed」。
 */
export function builtinProviderCatalog() {
  const candidates = [
    path.resolve(path.dirname(paths.zcodeCjs), '..', 'config', 'provider', 'zcode-builtin.json'),
    path.join(path.parse(paths.zcodeCjs).root, 'Program Files', 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
  ];
  if (process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) candidates.unshift(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

/**
 * ZCode CLI 独立无头运行（不经桌面 App 注入配置）时必须有 ~/.zcode/cli/config.json，
 * 否则 -p 报 "Model config is missing"。首次运行时从桌面版的 v2/config.json
 * 复制启用的 provider 生成一份，模型默认取 provider 中 priority 最高的。
 */
export function ensureCliConfig() {
  if (fs.existsSync(paths.cliConfig)) return { created: false };
  const v2 = JSON.parse(fs.readFileSync(paths.v2Config, 'utf8'));
  const providers = v2.provider ?? {};
  const enabledId = Object.keys(providers).find((id) => providers[id].enabled !== false && providers[id].options?.apiKey);
  if (!enabledId) throw new Error('v2/config.json 中没有可用的 provider（缺少 apiKey），无法生成 CLI 配置');
  const models = providers[enabledId].models ?? {};
  const topModel = Object.entries(models).sort((a, b) => (b[1]?.zcode?.priority ?? 0) - (a[1]?.zcode?.priority ?? 0))[0]?.[0];
  if (!topModel) throw new Error(`provider ${enabledId} 中没有模型定义`);
  const config = { model: `${enabledId}/${topModel}`, provider: { [enabledId]: providers[enabledId] } };
  fs.mkdirSync(path.dirname(paths.cliConfig), { recursive: true });
  fs.writeFileSync(paths.cliConfig, JSON.stringify(config, null, 2));
  return { created: true, model: config.model };
}

/** 桥接自身配置：端口 + 配对 token。首次运行自动生成随机 token。 */
export function loadBridgeConfig(bridgeRoot) {
  const file = path.join(bridgeRoot, 'bridge.config.json');
  let cfg = null;
  if (fs.existsSync(file)) {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    cfg = {
      port: 8787,
      token: crypto.randomBytes(5).toString('hex'), // 10 位，手机上手输可接受
    };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  }
  if (process.env.BRIDGE_TOKEN) cfg.token = process.env.BRIDGE_TOKEN;
  if (process.env.BRIDGE_PORT) cfg.port = Number(process.env.BRIDGE_PORT);
  return cfg;
}

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
