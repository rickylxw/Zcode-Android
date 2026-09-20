import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from './config.js';

/**
 * 会话模型选择的自愈。
 *
 * 背景：ZCode 把每个会话的模型选择存在 db.sqlite 的 session_entry（type=runtime/model_selection，
 * data 形如 {"modelSelection":{"providerId":"bigmodel-api-2","modelId":"GLM-5.3",...}}）。
 * 桌面端更换 provider 实例（如 bigmodel-api → bigmodel-api-2，换订阅/密钥时会发生）后，
 * 旧会话的选择仍指向已删除的实例，独立无头 resume 会报
 * 「Model creation failed / Select a model before continuing」并以退出码 1 失败。
 *
 * 这里在 resume 前把指向失效实例的选择改写为当前有效的实例（v2/provider_config.json 里
 * 的 providerRules 是唯一可信来源），使旧会话可以直接从手机续接。
 */

let validIdsCache = null;
let validIdsAt = 0;

function validProviderIds() {
  const now = Date.now();
  if (validIdsCache && now - validIdsAt < 10_000) return validIdsCache;
  try {
    const rules = JSON.parse(fs.readFileSync(paths.v2ProviderConfig, 'utf8'))
      ?.config?.providerConfigRules?.providerRules ?? [];
    const ids = rules.map((r) => r.providerId).filter(Boolean);
    validIdsCache = ids.length ? ids : null;
    validIdsAt = now;
    return validIdsCache;
  } catch {
    return null;
  }
}

function defaultModelId(providerId) {
  // coding-plan 实例上桌面当前默认是 GLM-5.3；保留会话原 modelId 更稳，这里只兜底
  return providerId.includes('coding-plan') ? 'GLM-5.3' : 'GLM-5.3-Flash';
}

/**
 * 若会话的选择指向失效实例，改写为当前有效实例。返回是否做了修正。
 * 失败一律静默（让 resume 走原路径与原有报错提示）。
 */
export function ensureResumableSelection(sessionId) {
  const valid = validProviderIds();
  if (!valid) return false;
  let db = null;
  try {
    db = new DatabaseSync(paths.db); // 读写：需要改写 session_entry
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
    // 已是规范形状（有效实例 + 规范 options.reasoningLevel）则无需处理
    const canonical =
      valid.includes(sel.providerId) &&
      !!sel.options?.reasoningLevel && // 平铺的 reasoningLevel 是早期坏数据，独立 CLI 解析不了
      !sel.reasoningLevel;
    if (canonical) return false;

    const target = valid[0];
    // 实测：coding-plan 实例上 GLM-5.3-Flash 会导致模型创建失败，GLM-5.3 可用；
    // 自愈时模型一并落到实例的默认可用模型，避免换实例后仍因模型不可用而失败。
    // 形状必须是规范的 options.reasoningLevel（平铺会导致选择无法解析）。
    const reasoning = sel.options?.reasoningLevel ?? sel.reasoningLevel ?? data.thoughtLevel ?? 'max';
    const fixed = {
      modelSelection: {
        providerId: target,
        modelId: 'GLM-5.3',
        options: { reasoningLevel: reasoning },
      },
    };
    // 桌面端可能持有写锁（SQLITE_BUSY 抛异常），重试若干次
    const stmt = db.prepare('UPDATE session_entry SET data = ?, time_updated = ? WHERE id = ?');
    for (let i = 0; i < 8; i++) {
      try {
        const res = stmt.run(JSON.stringify(fixed), Date.now(), `${sessionId}:runtime-model-selection`);
        if (res.changes > 0) return true;
        return false; // id 不匹配：0 行受影响，重试无意义
      } catch (e) {
        if (!/busy|locked/i.test(String(e?.message))) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
