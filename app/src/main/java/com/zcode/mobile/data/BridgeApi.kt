package com.zcode.mobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** 桥接 REST 客户端。所有请求走 Bearer token 认证。 */
class BridgeApi(private val settings: SettingsRepo) {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private val client = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    /** 用给定的连接参数测试连通性（连接页用） */
    suspend fun ping(serverUrl: String, token: String): PingDto =
        request(serverUrl, token, "GET", "/api/ping", body = null)

    suspend fun projects(): List<ProjectDto> {
        val (url, token) = requireConfig()
        return request<ProjectsResp>(url, token, "GET", "/api/projects", null).projects
    }

    suspend fun sessions(directory: String? = null, archived: Boolean = false): List<SessionDto> {
        val (url, token) = requireConfig()
        val parts = mutableListOf<String>()
        if (directory != null) parts.add("directory=" + java.net.URLEncoder.encode(directory, "UTF-8"))
        parts.add("archived=" + if (archived) "1" else "0")
        return request<SessionsResp>(url, token, "GET", "/api/sessions?" + parts.joinToString("&"), null).sessions
    }

    /** 归档 / 取消归档（桌面端归档的会话无法在手机上取消，桥接会返回 409 说明） */
    suspend fun setArchived(id: String, archived: Boolean) {
        val (url, token) = requireConfig()
        request<StopResp>(url, token, "POST", "/api/sessions/$id/archive", """{"archived":$archived}""")
    }

    /** 队列管理：action = add(text) / remove(id) / clear / move(id, dir) */
    suspend fun queueAction(id: String, action: String, text: String? = null, itemId: String? = null, dir: String? = null): List<QueuedInputDto> {
        val (url, token) = requireConfig()
        val body = buildString {
            append("""{"action":"$action"""")
            if (!text.isNullOrBlank()) append(""","text":${JsonPrimitive(text)}""")
            if (!itemId.isNullOrBlank()) append(""","id":"$itemId"""")
            if (!dir.isNullOrBlank()) append(""","dir":"$dir"""")
            append("}")
        }
        return request<QueueResp>(url, token, "POST", "/api/sessions/$id/queue", body).queued
    }

    suspend fun sessionDetail(id: String): SessionDetailDto {
        val (url, token) = requireConfig()
        return request(url, token, "GET", "/api/sessions/$id/messages", null)
    }

    suspend fun stopSession(id: String) {
        val (url, token) = requireConfig()
        request<StopResp>(url, token, "POST", "/api/sessions/$id/stop", "{}")
    }

    suspend fun models(): ModelListDto {
        val (url, token) = requireConfig()
        return request(url, token, "GET", "/api/models", null)
    }

    suspend fun usage(): UsageResp {
        val (url, token) = requireConfig()
        return request(url, token, "GET", "/api/usage", null)
    }

    private suspend fun requireConfig(): Pair<String, String> {
        val c = settings.current() ?: throw BridgeException("尚未配置桥接连接")
        return c.serverUrl to c.token
    }

    private suspend inline fun <reified T> request(
        serverUrl: String,
        token: String,
        method: String,
        path: String,
        body: String?,
    ): T = withContext(Dispatchers.IO) {
        val base = serverUrl.trimEnd('/')
        val req = Request.Builder()
            .url(base + path)
            .header("Authorization", "Bearer $token")
            .apply {
                when (method) {
                    "GET" -> get()
                    else -> post((body ?: "{}").toRequestBody(jsonMedia))
                }
            }
            .build()
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw BridgeException("HTTP ${resp.code}: ${errorMessage(text)}")
            json.decodeFromString<T>(text)
        }
    }

    private fun errorMessage(body: String): String = try {
        (json.parseToJsonElement(body).jsonObject["error"] as? JsonPrimitive)?.contentOrNull ?: body.take(200)
    } catch (e: Exception) {
        body.take(200)
    }
}

class BridgeException(message: String) : Exception(message)

@Serializable
private data class StopResp(val ok: Boolean = false)

@Serializable
private data class QueueResp(val ok: Boolean = false, val queued: List<QueuedInputDto> = emptyList())
