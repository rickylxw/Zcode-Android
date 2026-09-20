package com.zcode.mobile.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * 桥接 WebSocket 客户端：下发 prompt、接收实时进度与结果。
 * 断线后自动重连（3s 退避）；桥接协议见 bridge/src/server.js。
 */
class BridgeSocket(private val settings: SettingsRepo) {

    sealed interface State {
        data object Idle : State
        data object Connecting : State
        data class Connected(val serverUrl: String) : State
        data class Failed(val message: String) : State
    }

    sealed interface Event {
        data class PromptAccepted(val requestId: String, val jobId: String) : Event
        data class Progress(
            val sessionId: String,
            val jobId: String?,
            val kind: String,
            val toolName: String? = null,
            val durationMs: Long? = null,
        ) : Event

        data class TurnResult(
            val requestId: String,
            val sessionId: String?,
            val response: String,
            val inputTokens: Long? = null,
            val outputTokens: Long? = null,
            val totalTokens: Long? = null,
        ) : Event

        data class SessionUpdated(val sessionId: String?) : Event
        data class Failure(val requestId: String?, val code: String?, val message: String) : Event
    }

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // WebSocket 长连接
        .build()

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state

    private val _events = MutableSharedFlow<Event>(extraBufferCapacity = 64)
    val events: SharedFlow<Event> = _events.asSharedFlow()

    private var ws: WebSocket? = null
    private var desired = false
    private var reconnectAttempts = 0

    /** 按已保存配置建立连接（幂等） */
    fun ensureConnected() {
        if (_state.value is State.Connected || _state.value is State.Connecting) return
        scope.launch {
            val c = settings.current() ?: return@launch
            connect(c.serverUrl, c.token)
        }
    }

    fun connect(serverUrl: String, token: String) {
        desired = true
        open(serverUrl, token)
    }

    fun disconnect() {
        desired = false
        ws?.close(1000, "bye")
        ws = null
        _state.value = State.Idle
    }

    private fun open(serverUrl: String, token: String) {
        _state.value = State.Connecting
        val base = serverUrl.trimEnd('/').replaceFirst("http", "ws")
        val request = Request.Builder().url("$base/ws?token=$token").build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectAttempts = 0
                _state.value = State.Connected(serverUrl)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                _state.value = State.Failed(t.message ?: "连接失败")
                scheduleReconnect(serverUrl, token)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (desired) scheduleReconnect(serverUrl, token)
                else _state.value = State.Idle
            }
        })
    }

    private fun scheduleReconnect(serverUrl: String, token: String) {
        if (!desired) return
        if (_state.value is State.Connected || _state.value is State.Connecting) return
        reconnectAttempts++
        val backoff = minOf(30_000L, 3_000L * reconnectAttempts)
        scope.launch {
            delay(backoff)
            if (desired && _state.value !is State.Connected) open(serverUrl, token)
        }
    }

    fun sendPrompt(requestId: String, sessionId: String?, directory: String, prompt: String, mode: String, model: String? = null) {
        val obj = mutableMapOf<String, String>(
            "type" to "prompt",
            "requestId" to requestId,
            "directory" to directory,
            "prompt" to prompt,
            "mode" to mode,
        )
        if (sessionId != null) obj["sessionId"] = sessionId
        if (!model.isNullOrBlank()) obj["model"] = model
        val msg = obj.entries.joinToString(",", "{", "}") { (k, v) ->
            "\"" + esc(k) + "\":\"" + esc(v) + "\""
        }
        ws?.send(msg) ?: scope.launch {
            _events.emit(Event.Failure(requestId, "NO_SOCKET", "未连接到电脑，请先在连接页重试"))
        }
    }

    fun stopJob(jobId: String) {
        ws?.send("""{"type":"stop_job","jobId":"${esc(jobId)}"}""")
    }

    fun subscribe(sessionId: String) {
        ws?.send("""{"type":"subscribe","sessionId":"${esc(sessionId)}"}""")
    }

    private fun handleMessage(text: String) {
        val obj = try {
            json.parseToJsonElement(text).jsonObject
        } catch (e: Exception) {
            return
        }
        val type = (obj["type"] as? JsonPrimitive)?.contentOrNull ?: return
        fun str(k: String): String? = (obj[k] as? JsonPrimitive)?.contentOrNull
        when (type) {
            "prompt_accepted" -> _events.tryEmit(
                Event.PromptAccepted(str("requestId") ?: "", str("jobId") ?: "")
            )

            "progress" -> {
                val ev = obj["event"] as? kotlinx.serialization.json.JsonObject
                _events.tryEmit(
                    Event.Progress(
                        sessionId = str("sessionId") ?: return,
                        jobId = str("jobId"),
                        kind = (ev?.get("kind") as? JsonPrimitive)?.contentOrNull ?: return,
                        toolName = (ev["toolName"] as? JsonPrimitive)?.contentOrNull,
                        durationMs = (ev["durationMs"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull(),
                    )
                )
            }

            "result" -> {
                val usage = obj["usage"] as? kotlinx.serialization.json.JsonObject
                fun uLong(k: String) = ((usage?.get(k) as? JsonPrimitive)?.contentOrNull)?.toLongOrNull()
                _events.tryEmit(
                    Event.TurnResult(
                        requestId = str("requestId") ?: "",
                        sessionId = str("sessionId"),
                        response = (obj["response"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
                        inputTokens = uLong("inputTokens"),
                        outputTokens = uLong("outputTokens"),
                        totalTokens = uLong("totalTokens"),
                    )
                )
            }

            "session_updated" -> _events.tryEmit(Event.SessionUpdated(str("sessionId")))

            "error" -> _events.tryEmit(
                Event.Failure(requestId = str("requestId"), code = str("code"), message = str("message") ?: "未知错误")
            )

            "stopped" -> Unit
            "hello" -> Unit
        }
    }

    private fun esc(s: String) = s.replace("\\", "\\\\").replace("\"", "\\\"")
        .replace("\n", "\\n").replace("\r", "").replace("\t", "\\t")
}
