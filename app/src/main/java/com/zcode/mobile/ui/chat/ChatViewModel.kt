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
    val models: List<String> = emptyList(),
    val selectedModel: String? = null, // null = 电脑默认
    val lastUsage: String? = null, // 上一回合的 token 用量摘要
    val archivedRequested: Boolean = false, // 归档成功，请求退出当前页面
    val streamText: String? = null, // 流式输出：回合进行中当前已生成的正文（null = 无流式）
    val queued: List<com.zcode.mobile.data.QueuedInputDto> = emptyList(), // 电脑端待发送队列
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
        loadModels()
        container.socket.ensureConnected()
        container.socket.subscribe(sessionId)
        viewModelScope.launch {
            container.socket.events.collect { ev -> handleEvent(ev) }
        }
        // 断线重连后：服务端按连接记订阅者，需要重新订阅；同时刷新运行状态
        viewModelScope.launch {
            container.socket.state.collect { st ->
                if (st is BridgeSocket.State.Connected) {
                    container.socket.subscribe(sessionId)
                    load()
                }
            }
        }
    }

    fun consumeNotice() {
        _state.value = _state.value.copy(notice = null)
    }

    /** 归档 / 取消归档（桌面端归档的会话由桥接返回 409 提示） */
    fun toggleArchive() {
        val cur = _state.value.session?.archived == true
        viewModelScope.launch {
            try {
                container.api.setArchived(sessionId, !cur)
                _state.value = _state.value.copy(archivedRequested = true)
            } catch (e: Exception) {
                _state.value = _state.value.copy(notice = e.message ?: "操作失败")
            }
        }
    }

    // ---- 待发送队列管理（编辑/新增/调整电脑端队列）----

    fun queueAdd(text: String) = queueAction("add", text = text)

    fun queueRemove(itemId: String) = queueAction("remove", itemId = itemId)

    fun queueClear() = queueAction("clear")

    fun queueMove(itemId: String, up: Boolean) = queueAction("move", itemId = itemId, dir = if (up) "up" else "down")

    private fun queueAction(action: String, text: String? = null, itemId: String? = null, dir: String? = null) {
        viewModelScope.launch {
            try {
                val queued = container.api.queueAction(sessionId, action, text, itemId, dir)
                _state.value = _state.value.copy(queued = queued)
            } catch (e: Exception) {
                _state.value = _state.value.copy(notice = e.message ?: "操作失败")
            }
        }
    }

    fun consumeArchiveRequest() {
        _state.value = _state.value.copy(archivedRequested = false)
    }

    private fun loadModels() {
        viewModelScope.launch {
            try {
                val list = container.api.models()
                val saved = container.settings.selectedModelOnce()
                _state.value = _state.value.copy(
                    models = list.models,
                    selectedModel = saved?.takeIf { it in list.models },
                )
            } catch (e: Exception) {
                // 模型列表拿不到时保持空（选择器隐藏），不影响其他功能
            }
        }
    }

    fun selectModel(model: String?) {
        _state.value = _state.value.copy(selectedModel = model)
        viewModelScope.launch { container.settings.saveSelectedModel(model) }
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
                    queued = detail.queued,
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
        container.socket.sendPrompt(requestId, sessionId, session.directory, prompt, mode, _state.value.selectedModel)
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
            is BridgeSocket.Event.Stream -> if (ev.sessionId == sessionId) {
                _state.value = _state.value.copy(streamText = ev.text.ifBlank { null })
            }

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
                val usageText = buildString {
                    ev.inputTokens?.let {
                        append("↑${com.zcode.mobile.ui.common.fmtTokens(it)}")
                        ev.cacheReadTokens?.takeIf { c -> c > 0 }?.let { c ->
                            append("(命中${com.zcode.mobile.ui.common.fmtTokens(c)})")
                        }
                    }
                    ev.outputTokens?.let { append(if (isEmpty()) "" else "  "); append("↓${com.zcode.mobile.ui.common.fmtTokens(it)}") }
                    ev.totalTokens?.let { append(if (isEmpty()) "" else "  "); append("计 ${com.zcode.mobile.ui.common.fmtTokens(it)} tokens") }
                }.ifBlank { null }
                _state.value = _state.value.copy(
                    sending = false,
                    running = false,
                    liveSteps = emptyList(),
                    streamText = null,
                    lastUsage = usageText,
                )
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
