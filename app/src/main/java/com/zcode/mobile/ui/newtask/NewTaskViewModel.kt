package com.zcode.mobile.ui.newtask

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zcode.mobile.AppContainer
import com.zcode.mobile.data.BridgeSocket
import com.zcode.mobile.data.ProjectDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.util.UUID

data class NewTaskUiState(
    val loadingProjects: Boolean = true,
    val projects: List<ProjectDto> = emptyList(),
    val selectedDir: String? = null,
    val customDir: String = "",
    val mode: String = "yolo",
    val prompt: String = "",
    val submitting: Boolean = false,
    val createdSessionId: String? = null,
    val notice: String? = null,
)

/** 新任务：选目录 + 模式，桥接以无头模式新建 ZCode 会话执行 */
class NewTaskViewModel(private val container: AppContainer) : ViewModel() {

    private val _state = MutableStateFlow(NewTaskUiState())
    val state: StateFlow<NewTaskUiState> = _state

    private var pendingJobId: String? = null
    private var pendingRequestId: String? = null

    init {
        container.socket.ensureConnected()
        viewModelScope.launch {
            try {
                val projects = container.api.projects()
                _state.value = _state.value.copy(loadingProjects = false, projects = projects)
            } catch (e: Exception) {
                _state.value = _state.value.copy(loadingProjects = false, notice = e.message ?: "读取项目失败")
            }
        }
        viewModelScope.launch {
            container.socket.events.collect { ev -> handleEvent(ev) }
        }
    }

    fun consumeNotice() {
        _state.value = _state.value.copy(notice = null)
    }

    fun select(dir: String) {
        _state.value = _state.value.copy(selectedDir = dir, customDir = "")
    }

    fun setCustomDir(v: String) {
        _state.value = _state.value.copy(customDir = v, selectedDir = null)
    }

    fun setMode(m: String) {
        _state.value = _state.value.copy(mode = m)
    }

    fun setPrompt(v: String) {
        _state.value = _state.value.copy(prompt = v)
    }

    fun submit() {
        val s = _state.value
        val dir = s.selectedDir ?: s.customDir.trim()
        if (dir.isEmpty() || s.prompt.isBlank() || s.submitting) return
        val requestId = UUID.randomUUID().toString()
        pendingRequestId = requestId
        _state.value = s.copy(submitting = true, notice = null)
        container.socket.sendPrompt(requestId, sessionId = null, directory = dir, prompt = s.prompt.trim(), mode = s.mode)
    }

    private fun handleEvent(ev: BridgeSocket.Event) {
        when (ev) {
            is BridgeSocket.Event.PromptAccepted -> if (ev.requestId == pendingRequestId) pendingJobId = ev.jobId

            is BridgeSocket.Event.TurnResult -> if (ev.requestId == pendingRequestId) {
                pendingRequestId = null
                val sid = ev.sessionId
                _state.value = _state.value.copy(submitting = false)
                if (sid != null) {
                    _state.value = _state.value.copy(createdSessionId = sid)
                } else {
                    _state.value = _state.value.copy(notice = "任务完成但未取得会话 id")
                }
            }

            is BridgeSocket.Event.Failure -> if (ev.requestId == null || ev.requestId == pendingRequestId) {
                pendingRequestId = null
                pendingJobId = null
                _state.value = _state.value.copy(submitting = false, notice = ev.message)
            }

            else -> Unit
        }
    }
}
