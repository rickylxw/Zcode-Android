import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from './config.js';

/**
 * 会话模型选择：自愈 + 应用用户选择。
 *
 * 背景：ZCode 把每个会话的模型选择存在 db.sqlite 的 session_entry（type=runtime/model_selection，
 * id 为 `<sessionId>:runtime-model-selection`，data 形如
 * {"modelSelection":{"providerId":"bigmodel-api-2","modelId":"GLM-5.3","options":{"reasoningLevel":"max"}}}）。
 * 桌面端更换 provider 实例（如 bigmodel-api → bigmodel-api-2）后，旧会话的选择指向已删除实例，
 * 独立无头 resume 会报「Model creation failed / Select a model before continuing」。
 * CLI 无 --model 参数，所以桥接通过改写这份记录实现模型选择。
 *
 * 有效 provider 实例来自 v2/provider_config.json 的 providerRules；可用模型来自安装目录
 * zcode-builtin.json 里该实例 templateId 的 builtinModelIds。
 */

let validCache = null;
let validAt = 0;

/** 当前有效的 provider 实例（id + templateId），按声明顺序 */
function validProviders() {
  const now = Date.now();
  if (validCache && now - validAt < 10_000) return validCache;
  try {
    const personal = JSON.parse(fs.readFileSync(paths.v2ProviderConfig, 'utf8'))
      ?.config?.providerConfigRules?.providerRules ?? [];
    const rules = personal
      .map((r) => ({ providerId: r.providerId, templateId: r.templateId }))
      .filter((r) => r.providerId);
    validCache = rules.length ? rules : null;
    validAt = now;
    return validCache;
  } catch {
    return null;
  }
}

/** 实例可用模型清单（来自内置目录模板的 builtinModelIds） */
export function listModels() {
  const providers = validProviders();
  if (!providers) return null;
  const catalogFile = paths.builtinCatalog;
  let templateModels = [];
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    for (const p of providers) {
      const rule = (catalog.config?.providerConfigRules?.templateRules ?? [])
        .find((t) => t.templateId === p.templateId);
      const ids = rule?.config?.builtinModelIds ?? [];
      templateModels = [...new Set([...templateModels, ...ids])];
    }
  } catch {}
  if (!templateModels.length) templateModels = ['GLM-5.3', 'GLM-5.3-Flash'];
  return { provider: providers[0].providerId, models: templateModels };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeSelectionWithRetry(db, sessionId, selection) {
  const stmt = db.prepare('UPDATE session_entry SET data = ?, time_updated = ? WHERE id = ?');
  for (let i = 0; i < 8; i++) {
    try {
      const res = stmt.run(JSON.stringify(selection), Date.now(), `${sessionId}:runtime-model-selection`);
      return res.changes > 0;
    } catch (e) {
      if (!/busy|locked/i.test(String(e?.message))) throw e;
      sleepSync(300);
    }
  }
  return false;
}

/**
 * 把会话的模型选择改写为指定模型（规范形状），使无头 resume 可用。
 * 返回是否成功改写；选择已符合要求时也返回 true。
 */
export function applyModelSelection(sessionId, modelId) {
  const providers = validProviders();
  if (!providers) return false;
  const provider = providers[0].providerId;
  const models = listModels()?.models ?? [];
  const model = models.includes(modelId) ? modelId : models[0] ?? 'GLM-5.3';

  let db = null;
  try {
    db = new DatabaseSync(paths.db);
    const row = db
      .prepare("SELECT data FROM session_entry WHERE id = ? AND type = 'runtime/model_selection'")
      .get(`${sessionId}:runtime-model-selection`);

    let reasoning = 'max';
    if (row) {
      const data = JSON.parse(row.data);
      const sel = data.modelSelection ?? {};
      reasoning = sel.options?.reasoningLevel ?? sel.reasoningLevel ?? data.thoughtLevel ?? 'max';
      // 已是目标状态则不写
      if (sel.providerId === provider && sel.modelId === model && sel.options?.reasoningLevel && !sel.reasoningLevel) {
        return true;
      }
    }
    const fixed = {
      modelSelection: { providerId: provider, modelId: model, options: { reasoningLevel: reasoning } },
    };
    return writeSelectionWithRetry(db, sessionId, fixed);
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * resume 前自愈：选择缺失/指向失效实例/形状不合法时，改写为当前有效实例的可用模型。
 * 保留原 reasoning 等级。返回是否做了修正。
 */
export function ensureResumableSelection(sessionId) {
  const providers = validProviders();
  if (!providers) return false;
  const validIds = providers.map((p) => p.providerId);
  const models = listModels()?.models ?? [];
  let db = null;
  try {
    db = new DatabaseSync(paths.db);
    const row = db
      .prepare("SELECT data FROM session_entry WHERE id = ? AND type = 'runtime/model_selection'")
      .get(`${sessionId}:runtime-model-selection`);
    if (!row) return false;
    const data = JSON.parse(row.data);
    const sel = data.modelSelection ?? {
      providerId: data.providerId,
      modelId: data.modelId,
      options: data.thoughtLevel ? { reasoningLevel: data.thoughtLevel } : undefined,
    };
    if (!sel?.providerId) return false;
    const canonical =
      validIds.includes(sel.providerId) &&
      models.includes(sel.modelId) &&
      !!sel.options?.reasoningLevel && // 平铺的 reasoningLevel 是坏形状，独立 CLI 解析不了
      !sel.reasoningLevel;
    if (canonical) return false;

    const model = models.includes(sel.modelId) ? sel.modelId : models[0] ?? 'GLM-5.3';
    const reasoning = sel.options?.reasoningLevel ?? sel.reasoningLevel ?? data.thoughtLevel ?? 'max';
    const fixed = {
      modelSelection: { providerId: providers[0].providerId, modelId: model, options: { reasoningLevel: reasoning } },
    };
    return writeSelectionWithRetry(db, sessionId, fixed);
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * 新会话没有 session_entry，模型选择走全局默认：改写 CLI config.json 的 model 字段。
 * 该文件只被无头 CLI 使用（桌面用 v2 配置），桥接是它的唯一写入方。
 */
export function setDefaultModel(modelId) {
  const providers = validProviders();
  const models = listModels()?.models ?? [];
  if (!providers || !models.includes(modelId)) return false;
  try {
    fs.mkdirSync(path.dirname(paths.cliConfig), { recursive: true });
    let cfg = {};
    if (fs.existsSync(paths.cliConfig)) cfg = JSON.parse(fs.readFileSync(paths.cliConfig, 'utf8'));
    cfg.model = `${providers[0].providerId}/${modelId}`;
    fs.writeFileSync(paths.cliConfig, JSON.stringify(cfg, null, 2));
    return true;
  } catch {
    return false;
  }
}
