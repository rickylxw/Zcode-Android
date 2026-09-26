package com.zcode.mobile.ui.chat

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
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
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import com.zcode.mobile.data.BridgeSocket
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
    var menuExpanded by remember { mutableStateOf(false) }

    LaunchedEffect(s.messages.size, s.liveSteps.size, s.streamText, s.streamReasoning, s.streamTodos) {
        // 滚到列表真实最后一项（估算会越界）
        val last = listState.layoutInfo.totalItemsCount
        if (last > 0) listState.animateScrollToItem(last - 1)
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
                actions = {
                    Box {
                        IconButton(onClick = { menuExpanded = true }) {
                            Icon(Icons.Filled.MoreVert, contentDescription = "更多")
                        }
                        DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                            DropdownMenuItem(
                                text = { Text(if (s.session?.archived == true) "取消归档" else "归档会话") },
                                onClick = {
                                    menuExpanded = false
                                    vm.toggleArchive()
                                },
                            )
                        }
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
        // 归档成功 → 返回列表（列表会因 session_updated 自动刷新）
        LaunchedEffect(s.archivedRequested) {
            if (s.archivedRequested) {
                vm.consumeArchiveRequest()
                onBack()
            }
        }

        // 电脑端的交互请求（权限审批 / AskUserQuestion）：模态对话框，选项即答
        s.pendingRequest?.let { req ->
            ApprovalDialog(req = req, onRespond = { vm.respondRequest(it) }, onDismiss = { vm.dismissRequest() })
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
                    // 只把真实用户输入画成用户气泡；todo 提醒/后台通知是运行时内部注入，
                    // 即使被旧版 bridge 标成 user 也按语义跳过
                    val isRealUserInput =
                        m.role == "user" &&
                            m.semantic != "todo_reminder" &&
                            m.semantic != "background_notification"
                    if (m.role == "system_event") {
                        // 运行时内部注入（todo 提醒/后台任务通知）：对话流中不展示
                    } else if (isRealUserInput) {
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
                if (s.streamReasoning != null) {
                    item(key = "streamReasoning") {
                        LiveReasoningBlock(s.streamReasoning ?: "")
                    }
                }
                if (s.streamTodos.isNotEmpty()) {
                    item(key = "streamTodos") {
                        LiveTodoCard(s.streamTodos)
                    }
                }
                if (s.streamText != null) {
                    item(key = "stream") {
                        Column(Modifier.fillMaxWidth()) {
                            AssistantText(s.streamText ?: "")
                            Text(
                                "▍",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                }
                if (s.liveSteps.isNotEmpty()) {
                    item(key = "live") { LiveProgress(steps = s.liveSteps, onStop = { vm.stop() }) }
                }
            }

            // 待发送队列托盘：固定在输入栏正上方，常驻可见（不随消息滚动）
            QueuedCard(
                queued = s.queued,
                onMove = { id, up -> vm.queueMove(id, up) },
                onRemove = { vm.queueRemove(it) },
                onClear = { vm.queueClear() },
                onAdd = { vm.queueAdd(it) },
            )

            InputBar(
                enabled = !s.sending,
                running = s.running,
                models = s.models,
                selectedModel = s.selectedModel,
                onSelectModel = { vm.selectModel(it) },
                lastUsage = s.lastUsage,
                onSend = { prompt, mode -> vm.send(prompt, mode) },
                onQueue = { text -> vm.queueAdd(text) },
                onStop = { vm.stop() },
            )
        }
    }
}

/** 待发送队列卡：逐条上移/下移/删除 + 清空 + 追加新指令（写回电脑端队列） */
@Composable
private fun QueuedCard(
    queued: List<com.zcode.mobile.data.QueuedInputDto>,
    onMove: (String, Boolean) -> Unit,
    onRemove: (String) -> Unit,
    onClear: () -> Unit,
    onAdd: (String) -> Unit,
) {
    var newText by remember { mutableStateOf("") }
    Surface(
        color = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.4f),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "⏳ 电脑端待发送队列（${queued.size}）",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    "清空",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.clickable { onClear() },
                )
            }
            Spacer(Modifier.height(4.dp))
            if (queued.isEmpty()) {
                Text(
                    "队列为空。电脑端任务运行期间在这里追加指令，会自动排队并在任务结束后发送。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(4.dp))
            }
            queued.forEachIndexed { idx, q ->
                val fromDesktop = q.source == "desktop"
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        "${idx + 1}. ${if (fromDesktop) "[电脑] " else ""}${q.text.replace('\n', ' ').take(55)}${if (q.text.length > 55) "…" else ""}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (!fromDesktop) {
                        IconButton(onClick = { if (idx > 0) onMove(q.id, true) }, modifier = Modifier.size(28.dp)) {
                            Icon(Icons.Filled.KeyboardArrowUp, contentDescription = "上移", modifier = Modifier.size(16.dp))
                        }
                        IconButton(onClick = { if (idx < queued.size - 1) onMove(q.id, false) }, modifier = Modifier.size(28.dp)) {
                            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "下移", modifier = Modifier.size(16.dp))
                        }
                        IconButton(onClick = { onRemove(q.id) }, modifier = Modifier.size(28.dp)) {
                            Icon(Icons.Filled.Close, contentDescription = "删除", tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(14.dp))
                        }
                    } else {
                        Text(
                            "电脑端排队",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = newText,
                    onValueChange = { newText = it },
                    placeholder = { Text("追加到电脑端队列…", style = MaterialTheme.typography.bodySmall) },
                    modifier = Modifier.weight(1f),
                    textStyle = MaterialTheme.typography.bodySmall,
                    maxLines = 2,
                )
                IconButton(
                    onClick = {
                        onAdd(newText.trim())
                        newText = ""
                    },
                    enabled = newText.isNotBlank(),
                ) {
                    Icon(Icons.Filled.Add, contentDescription = "加入队列")
                }
            }
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
    onQueue: (String) -> Unit,
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
                    placeholder = { Text(if (running) "任务执行中，发送将排入电脑端队列…" else "给 ZCode 下发新指令") },
                    modifier = Modifier.weight(1f),
                    maxLines = 4,
                    enabled = enabled,
                )
                IconButton(
                    onClick = {
                        if (text.isNotBlank()) {
                            if (running) {
                                // 运行中不打断当前回合：消息进入电脑端待发送队列
                                onQueue(text.trim())
                            } else {
                                onSend(text.trim(), mode)
                            }
                            text = ""
                        }
                    },
                    enabled = enabled && text.isNotBlank(),
                ) {
                    Icon(
                        if (running) Icons.Filled.PlayArrow else Icons.AutoMirrored.Filled.Send,
                        contentDescription = if (running) "加入电脑端队列" else "发送",
                    )
                }
            }
        }
    }
}

/** 权限审批 / 电脑端提问对话框：把交互请求的选项呈现给用户，点选即应答 */
@Composable
fun ApprovalDialog(
    req: BridgeSocket.Event.InteractionRequest,
    onRespond: (JsonObject) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                when (req.kind) {
                    "permission" -> "权限审批" + (req.riskLevel?.let { " · $it" } ?: "")
                    else -> "电脑端提问"
                }
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (req.kind == "permission") {
                    Text(
                        "工具 ${req.toolName ?: "未知"} 请求执行",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    req.reason?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    // 入参按工具类型渲染：文件/命令一目了然，其余工具回退紧凑 JSON
                    val input = req.input
                    if (input != null) {
                        fun field(k: String) = (input[k] as? JsonPrimitive)?.content
                        val lines = when (req.toolName) {
                            "Write", "Edit", "Read" -> buildList {
                                field("file_path")?.let { add("📄 $it") }
                                field("old_string")?.let { add("旧：${it.take(80)}") }
                                field("new_string")?.let { add("新：${it.take(80)}") }
                                field("content")?.let { add("内容：${it.take(80)}") }
                            }
                            "Bash" -> buildList {
                                field("command")?.let { add("$ " + it.take(120)) }
                                field("description")?.let { add(it) }
                            }
                            else -> emptyList()
                        }
                        if (lines.isNotEmpty()) {
                            lines.forEach {
                                Text(
                                    it,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        } else {
                            Text(
                                input.toString(),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 4,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                } else {
                    val q = (req.questions?.firstOrNull() as? JsonObject)
                    q?.get("question")?.let { qText ->
                        Text((qText as? JsonPrimitive)?.content ?: "", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            // 选项按钮按 kind 生成：permission 回显 option.response；user_input 回传所选 value
            when (req.kind) {
                "permission" -> {
                    val opts = req.options ?: JsonArray(emptyList())
                    opts.forEach { o ->
                        val obj = o as? JsonObject ?: return@forEach
                        val name = (obj["name"] as? JsonPrimitive)?.content ?: return@forEach
                        val response = obj["response"] as? JsonObject ?: return@forEach
                        TextButton(onClick = { onRespond(response) }) { Text(name) }
                    }
                }
                else -> {
                    val q = (req.questions?.firstOrNull() as? JsonObject)
                    val qOpts = (q?.get("options") as? JsonArray) ?: JsonArray(emptyList())
                    qOpts.forEach { o ->
                        val obj = o as? JsonObject ?: return@forEach
                        val label = (obj["label"] as? JsonPrimitive)?.content ?: return@forEach
                        val value = (obj["value"] as? JsonPrimitive)?.content ?: label
                        TextButton(onClick = {
                            onRespond(
                                buildJsonObject {
                                    put("action", "accept")
                                    put("content", buildJsonObject { put("answer", value) })
                                }
                            )
                        }) { Text(label) }
                    }
                }
            }
            TextButton(onClick = onDismiss) { Text("稍后再说") }
        },
    )
}
