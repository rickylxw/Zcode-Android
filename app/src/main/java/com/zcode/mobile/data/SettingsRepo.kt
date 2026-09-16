package com.zcode.mobile.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "zcode_settings")

/** 桥接连接配置的持久化（DataStore）。 */
class SettingsRepo(private val context: Context) {

    private val keyUrl = stringPreferencesKey("server_url")
    private val keyToken = stringPreferencesKey("token")

    data class Connection(val serverUrl: String, val token: String)

    val connection: Flow<Connection?> = context.dataStore.data.map { p ->
        val url = p[keyUrl]
        val token = p[keyToken]
        if (!url.isNullOrBlank() && !token.isNullOrBlank()) Connection(url, token) else null
    }

    suspend fun current(): Connection? = connection.first()

    suspend fun save(serverUrl: String, token: String) {
        context.dataStore.edit { p ->
            p[keyUrl] = serverUrl
            p[keyToken] = token
        }
    }

    // ---- 自动更新配置 ----

    data class UpdateConfig(val repo: String, val proxy: String)

    private val keyUpdateRepo = stringPreferencesKey("update_repo")
    private val keyUpdateProxy = stringPreferencesKey("update_proxy")
    private val keyLastUpdateCheck = stringPreferencesKey("last_update_check")

    val updateConfig: Flow<UpdateConfig> = context.dataStore.data.map { p ->
        // 从未保存过时用内置默认仓库；显式保存空字符串则视为清空
        UpdateConfig(p[keyUpdateRepo] ?: UpdateChecker.DEFAULT_REPO, p[keyUpdateProxy].orEmpty())
    }

    suspend fun updateConfigOnce(): UpdateConfig = updateConfig.first()

    suspend fun saveUpdateConfig(repo: String, proxy: String) {
        context.dataStore.edit { p ->
            p[keyUpdateRepo] = repo.trim()
            p[keyUpdateProxy] = proxy.trim()
        }
    }

    suspend fun lastUpdateCheck(): Long = context.dataStore.data.map { it[keyLastUpdateCheck]?.toLongOrNull() ?: 0 }.first()

    suspend fun setLastUpdateCheck(ts: Long) {
        context.dataStore.edit { it[keyLastUpdateCheck] = ts.toString() }
    }

    suspend fun clear() {
        context.dataStore.edit { it.clear() }
    }

    companion object {
        /** 容错归一化：接受 "ip:port"、"ip:port/"、"http://ip:port" 等输入 */
        fun normalizeUrl(input: String): String? {
            var s = input.trim()
            if (s.isEmpty()) return null
            if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
            return try {
                val uri = java.net.URI(s)
                val host = uri.host ?: return null
                val port = if (uri.port > 0) uri.port else 8787
                "http://$host:$port"
            } catch (e: Exception) {
                null
            }
        }
    }
}
