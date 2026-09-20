package com.zcode.mobile.ui.sessions

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material.icons.filled.Unarchive
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zcode.mobile.data.BridgeSocket
import com.zcode.mobile.data.SessionDto
import com.zcode.mobile.ui.appViewModel
import com.zcode.mobile.ui.common.diffStat
import com.zcode.mobile.ui.common.pathName
import com.zcode.mobile.ui.common.relativeTime
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

data class SessionsUiState(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val showArchived: Boolean = false, // 当前是否处于归档视图
    val groups: List<Pair<String, List<SessionDto>>> = emptyList(), // (directory, sessions)
    val error: String? = null,
    val update: com.zcode.mobile.data.UpdateChecker.UpdateInfo? = null, // 发现的新版本（24h 自动检查）
)

class SessionsViewModel(private val container: com.zcode.mobile.AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(SessionsUiState())
    val state: StateFlow<SessionsUiState> = _state

    init {
        refresh(initial = true)
        autoCheckUpdate()
        // 桥接广播的 session_updated / 重连成功 → 自动刷新
        container.socket.events.onEach { ev ->
            when (ev) {
                is BridgeSocket.Event.SessionUpdated -> refresh()
                else -> Unit
            }
        }.launchIn(viewModelScope)
        viewModelScope.launch {
            container.socket.state.collect { s ->
                if (s is BridgeSocket.State.Connected) refresh()
            }
        }
    }

    /** 切换 会话列表 / 归档列表 */
    fun toggleArchivedView() {
        val next = !_state.value.showArchived
        _state.value = _state.value.copy(showArchived = next, loading = _state.value.groups.isNotEmpty())
        refresh(initial = true)
    }

    fun refresh(initial: Boolean = false) {
        viewModelScope.launch {
            val archived = _state.value.showArchived
            _state.value = _state.value.copy(loading = initial && _state.value.groups.isEmpty(), refreshing = true, error = null)
            try {
                val sessions = container.api.sessions(archived = archived)
                val groups = sessions.groupBy { it.directory }
                    .entries
                    .sortedByDescending { e -> e.value.maxOf { it.timeUpdated } }
                    .map { (dir, list) -> dir to list.sortedByDescending { it.timeUpdated } }
                _state.value = _state.value.copy(loading = false, refreshing = false, groups = groups)
            } catch (e: Exception) {
                _state.value = _state.value.copy(loading = false, refreshing = false, error = e.message ?: "加载失败")
            }
        }
    }

    /** 每 24 小时静默检查一次更新；失败不打扰 */
    private fun autoCheckUpdate() {
        viewModelScope.launch {
            try {
                val cfg = container.settings.updateConfigOnce()
                if (cfg.repo.isBlank()) return@launch
                val last = container.settings.lastUpdateCheck()
                if (System.currentTimeMillis() - last < 24 * 3600 * 1000L) return@launch
                val info = container.updater.check(cfg.repo)
                container.settings.setLastUpdateCheck(System.currentTimeMillis())
                val current = com.zcode.mobile.ui.common.appVersion(container.context)
                if (container.updater.isNewer(info.version, current)) {
                    _state.value = _state.value.copy(update = info)
                }
            } catch (e: Exception) {
                // 静默失败：自动检查不弹错
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    onOpenSession: (String) -> Unit,
    onNewTask: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenRemote: () -> Unit,
) {
    val vm = appViewModel { SessionsViewModel(it) }
    val s by vm.state.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (s.showArchived) "归档" else "会话") },
                actions = {
                    IconButton(onClick = { vm.refresh() }) {
                        if (s.refreshing) CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Filled.Refresh, contentDescription = "刷新")
                    }
                    IconButton(onClick = { vm.toggleArchivedView() }) {
                        Icon(
                            if (s.showArchived) Icons.Filled.Unarchive else Icons.Filled.Archive,
                            contentDescription = if (s.showArchived) "返回会话列表" else "查看归档",
                        )
                    }
                    IconButton(onClick = onOpenRemote) {
                        Icon(Icons.Filled.Language, contentDescription = "官方网页端")
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = "设置")
                    }
                },
            )
        },
        floatingActionButton = {
            if (!s.showArchived) {
                FloatingActionButton(onClick = onNewTask) {
                    Icon(Icons.Filled.Add, contentDescription = "新任务")
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding)) {
            when {
                s.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }

                s.error != null -> Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(s.error ?: "", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "下拉重试，或点右上角设置检查连接",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 96.dp)) {
                    s.update?.let { info ->
                        item(key = "update_banner") {
                            ElevatedCard(
                                onClick = onOpenSettings,
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                            ) {
                                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        Icons.Filled.SystemUpdate,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.primary,
                                    )
                                    Spacer(Modifier.width(10.dp))
                                    Text(
                                        "发现新版本 v${info.version}，点击去更新",
                                        style = MaterialTheme.typography.bodyMedium,
                                        modifier = Modifier.weight(1f),
                                    )
                                }
                            }
                        }
                    }
                    s.groups.forEach { (dir, sessions) ->
                        item(key = "h_$dir") {
                            Text(
                                pathName(dir),
                                modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp, end = 16.dp),
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.primary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        items(sessions.size, key = { i -> sessions[i].id }) { i ->
                            val session = sessions[i]
                            SessionCard(session, Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                                onOpenSession(session.id)
                            }
                        }
                    }
                    if (s.groups.isEmpty()) {
                        item {
                            Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                                Text(
                                    if (s.showArchived) "暂无归档会话\n（在会话的 ⋮ 菜单里可归档）" else "还没有会话，点右下角发起第一个任务",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionCard(session: SessionDto, modifier: Modifier = Modifier, onClick: () -> Unit) {    ElevatedCard(modifier = modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    session.title.ifBlank { "（无标题）" },
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (session.running) {
                    Spacer(Modifier.width(8.dp))
                    AssistChip(onClick = onClick, label = { Text("运行中") })
                } else if (session.queuedCount > 0) {
                    Spacer(Modifier.width(8.dp))
                    AssistChip(onClick = onClick, label = { Text("待发 ${session.queuedCount}") })
                }
            }
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    relativeTime(session.timeUpdated),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                diffStat(session.additions, session.deletions, session.files)?.let { stat ->
                    Spacer(Modifier.width(12.dp))
                    Text(
                        stat,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                }
            }
        }
    }
}
