package com.zcode.mobile.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zcode.mobile.AppContainer
import com.zcode.mobile.data.BridgeSocket
import com.zcode.mobile.data.MessageDto
import com.zcode.mobile.data.SessionDetailDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.util.UUID

data class ChatUiState(
    val loading: Boolean = true,
    val session: com.zcode.mobile.data.SessionDto? = null,
    val messages: List<MessageDto> = emptyList(),
    val running: Boolean = false,
    val liveSteps: List<String> = emptyList(),
    val sending: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
)

/**
 * 会话控制台：加载历史 → 订阅进度 → 可下发指令（--resume 续接同一会话）。
 */
class ChatViewModel(
    private val container: AppContainer,
    val sessionId: String,
) : ViewModel() {

    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state

    private var pendingRequestId: String? = null

    init {
        load()
        container.socket.ensureConnected()
        container.socket.subscribe(sessionId)
        viewModelScope.launch {
            container.socket.events.collect { ev -> handleEvent(ev) }
        }
    }

    fun consumeNotice() {
        _state.value = _state.value.copy(notice = null)
    }

    fun load() {
        viewModelScope.launch {
            try {
                val detail: SessionDetailDto = container.api.sessionDetail(sessionId)
                _state.value = _state.value.copy(
                    loading = false,
                    error = null,
                    session = detail.session,
                    messages = detail.messages,
                    running = detail.running,
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(loading = false, error = e.message ?: "加载失败")
            }
        }
    }

    fun send(prompt: String, mode: String) {
        val session = _state.value.session ?: return
        if (_state.value.running) return
        val requestId = UUID.randomUUID().toString()
        pendingRequestId = requestId
        // 乐观插入用户消息（turn 结束后 load() 用真实数据替换）
        val optimistic = MessageDto(
            id = "local_$requestId",
            role = "user",
            blocks = listOf(com.zcode.mobile.data.BlockDto(type = "text", text = prompt)),
        )
        _state.value = _state.value.copy(
            sending = true,
            running = true,
            messages = _state.value.messages + optimistic,
            liveSteps = listOf("已下发指令，等待电脑执行…"),
        )
        container.socket.sendPrompt(requestId, sessionId, session.directory, prompt, mode)
    }

    fun stop() {
        viewModelScope.launch {
            try {
                container.api.stopSession(sessionId)
                pushStep("已请求停止任务")
            } catch (e: Exception) {
                _state.value = _state.value.copy(notice = e.message ?: "停止失败")
            }
        }
    }

    private suspend fun handleEvent(ev: BridgeSocket.Event) {
        when (ev) {
            is BridgeSocket.Event.Progress -> if (ev.sessionId == sessionId) {
                when (ev.kind) {
                    "turn_started" -> pushStep("任务开始")
                    "model_request" -> pushStep("模型思考中…")
                    "tool_started" -> pushStep("调用工具 ${ev.toolName ?: ""}")
                    "tool_completed" -> pushStep(
                        "工具 ${ev.toolName ?: ""} 完成" + (ev.durationMs?.let { "（${it}ms）" } ?: "")
                    )

                    "turn_completed" -> pushStep("回合结束，正在整理结果…")
                }
            }

            is BridgeSocket.Event.TurnResult -> if (ev.requestId == pendingRequestId) {
                pendingRequestId = null
                _state.value = _state.value.copy(sending = false, running = false, liveSteps = emptyList())
                load() // 重新拉取，让工具块/思考块完整呈现
            }

            is BridgeSocket.Event.SessionUpdated -> if (ev.sessionId == sessionId) load()

            is BridgeSocket.Event.Failure -> if (ev.requestId == null || ev.requestId == pendingRequestId) {
                pendingRequestId = null
                _state.value = _state.value.copy(
                    sending = false,
                    running = false,
                    liveSteps = emptyList(),
                    notice = ev.message,
                )
            }

            else -> Unit
        }
    }

    private fun pushStep(label: String) {
        val current = _state.value.liveSteps.toMutableList()
        current.add("${current.size + 1}. $label")
        val trimmed = if (current.size > 30) current.takeLast(30) else current
        _state.value = _state.value.copy(liveSteps = trimmed)
    }
}
