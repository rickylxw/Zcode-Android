package com.zcode.mobile.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zcode.mobile.ui.appViewModel
import com.zcode.mobile.ui.common.ErrorBox
import com.zcode.mobile.ui.common.LoadingBox
import com.zcode.mobile.ui.common.pathName

private val MODES = listOf("yolo", "build", "edit", "plan")

private fun modeLabel(m: String) = when (m) {
    "yolo" -> "全自动"
    "build" -> "构建"
    "edit" -> "编辑"
    "plan" -> "规划"
    else -> m
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(sessionId: String, onBack: () -> Unit) {
    val vm = appViewModel { ChatViewModel(it, sessionId) }
    val s by vm.state.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val listState = rememberLazyListState()

    LaunchedEffect(s.messages.size, s.liveSteps.size) {
        val total = s.messages.size * 4 + s.liveSteps.size + 1 // 每条消息可能展开为多项
        if (total > 1) listState.animateScrollToItem(total - 1)
    }
    LaunchedEffect(s.notice) {
        s.notice?.let {
            snackbar.showSnackbar(it, withDismissAction = true)
            vm.consumeNotice()
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            s.session?.let { pathName(it.directory) } ?: "会话",
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (s.running) {
                            Text(
                                "任务运行中…",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.secondary,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        if (s.loading) {
            LoadingBox()
            return@Scaffold
        }
        if (s.error != null && s.messages.isEmpty()) {
            ErrorBox(s.error ?: "")
            return@Scaffold
        }

        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding(),
        ) {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val msgs = s.messages
                msgs.forEachIndexed { idx, m ->
                    if (m.role == "user") {
                        item(key = m.id) {
                            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
                                Surface(
                                    color = MaterialTheme.colorScheme.primaryContainer,
                                    shape = RoundedCornerShape(14.dp),
                                    modifier = Modifier.widthIn(max = 320.dp),
                                ) {
                                    SelectionContainer {
                                        Text(
                                            m.blocks.filter { it.type == "text" }.joinToString("\n") { it.text.orEmpty() },
                                            modifier = Modifier.padding(12.dp),
                                            style = MaterialTheme.typography.bodyMedium,
                                        )
                                    }
                                }
                            }
                        }
                    } else {
                        item(key = m.id) {
                            Column(Modifier.fillMaxWidth()) {
                                m.blocks.forEach { block ->
                                    when (block.type) {
                                        "text" -> AssistantText(block.text.orEmpty())
                                        "reasoning" -> ReasoningBlock(block.text.orEmpty())
                                        "tool" -> ToolBlock(block)
                                    }
                                }
                            }
                        }
                    }
                }
                if (s.liveSteps.isNotEmpty()) {
                    item(key = "live") { LiveProgress(steps = s.liveSteps, onStop = { vm.stop() }) }
                }
            }

            InputBar(
                enabled = !s.sending,
                running = s.running,
                models = s.models,
                selectedModel = s.selectedModel,
                onSelectModel = { vm.selectModel(it) },
                lastUsage = s.lastUsage,
                onSend = { prompt, mode -> vm.send(prompt, mode) },
                onStop = { vm.stop() },
            )
        }
    }
}

/** 运行中的实时进度时间线（来自桥接日志事件） */
@Composable
private fun LiveProgress(steps: List<String>, onStop: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.4f),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("任务动态", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onStop) {
                    Icon(Icons.Filled.Stop, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("停止")
                }
            }
            steps.takeLast(4).forEach { step ->
                Text(
                    "· $step",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun InputBar(
    enabled: Boolean,
    running: Boolean,
    models: List<String>,
    selectedModel: String?,
    onSelectModel: (String?) -> Unit,
    lastUsage: String?,
    onSend: (String, String) -> Unit,
    onStop: () -> Unit,
) {
    var text by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("yolo") }
    var modeMenu by remember { mutableStateOf(false) }
    var modelMenu by remember { mutableStateOf(false) }

    Surface(tonalElevation = 3.dp) {
        Column {
            lastUsage?.let {
                Text(
                    "上一回合：$it",
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                if (running) {
                    IconButton(onClick = onStop) {
                        Icon(Icons.Filled.Stop, contentDescription = "停止任务", tint = MaterialTheme.colorScheme.error)
                    }
                } else {
                    Box {
                        AssistChip(onClick = { modeMenu = true }, label = { Text(modeLabel(mode)) })
                        DropdownMenu(expanded = modeMenu, onDismissRequest = { modeMenu = false }) {
                            MODES.forEach { m ->
                                DropdownMenuItem(
                                    text = { Text("${modeLabel(m)} ($m)") },
                                    onClick = {
                                        mode = m
                                        modeMenu = false
                                    },
                                )
                            }
                        }
                    }
                    if (models.isNotEmpty()) {
                        Spacer(Modifier.width(6.dp))
                        Box {
                            AssistChip(onClick = { modelMenu = true }, label = { Text(selectedModel ?: "默认模型") })
                            DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }) {
                                DropdownMenuItem(
                                    text = { Text("默认（跟随电脑端）") },
                                    onClick = {
                                        onSelectModel(null)
                                        modelMenu = false
                                    },
                                )
                                models.forEach { m ->
                                    DropdownMenuItem(
                                        text = { Text(m) },
                                        onClick = {
                                            onSelectModel(m)
                                            modelMenu = false
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text(if (running) "任务执行中…" else "给 ZCode 下发新指令") },
                    modifier = Modifier.weight(1f),
                    maxLines = 4,
                    enabled = enabled,
                )
                IconButton(
                    onClick = {
                        if (text.isNotBlank()) {
                            onSend(text.trim(), mode)
                            text = ""
                        }
                    },
                    enabled = enabled && text.isNotBlank(),
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "发送")
                }
            }
        }
    }
}
