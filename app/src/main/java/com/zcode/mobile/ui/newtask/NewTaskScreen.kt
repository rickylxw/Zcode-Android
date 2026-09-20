package com.zcode.mobile.ui.newtask

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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

private fun modeDesc(m: String) = when (m) {
    "yolo" -> "AI 自主执行，无需逐步确认（推荐远程场景）"
    "build" -> "写文件前需要电脑端确认"
    "edit" -> "允许编辑，执行命令需确认"
    "plan" -> "只读规划，不改动任何文件"
    else -> ""
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewTaskScreen(onBack: () -> Unit, onCreated: (String) -> Unit) {
    val vm = appViewModel { NewTaskViewModel(it) }
    val s by vm.state.collectAsState()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(s.createdSessionId) {
        s.createdSessionId?.let(onCreated)
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
                title = { Text("新任务") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        if (s.loadingProjects) {
            LoadingBox("正在读取电脑上的项目…")
            return@Scaffold
        }

        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .padding(horizontal = 16.dp),
        ) {
            LazyColumn(Modifier.weight(1f)) {
                item {
                    Text("选择项目目录", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
                    Surface(shape = RoundedCornerShape(10.dp), tonalElevation = 1.dp, modifier = Modifier.fillMaxWidth()) {
                        Column {
                            if (s.projects.isEmpty()) {
                                Text(
                                    "电脑上还没有历史项目，在下方手动输入项目路径",
                                    modifier = Modifier.padding(12.dp),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            s.projects.forEach { p ->
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .selectable(selected = s.selectedDir == p.directory, onClick = { vm.select(p.directory) })
                                        .padding(horizontal = 8.dp, vertical = 2.dp),
                                ) {
                                    RadioButton(selected = s.selectedDir == p.directory, onClick = { vm.select(p.directory) })
                                    Icon(Icons.Filled.Folder, contentDescription = null, modifier = Modifier.width(18.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Column {
                                        Text(pathName(p.directory), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        Text(
                                            p.directory,
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = s.customDir,
                        onValueChange = { vm.setCustomDir(it) },
                        label = { Text("或手动输入项目路径") },
                        placeholder = { Text("E:\\Projects\\MyApp") },
                        isError = s.customDir.isNotBlank() && s.selectedDir == null,
                        supportingText = {
                            if (s.customDir.isNotBlank() && s.selectedDir == null) {
                                Text("将以该路径发起新任务，路径必须在电脑上已存在")
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )

                    Text("模型", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp, bottom = 4.dp))
                    if (s.models.isNotEmpty()) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            s.models.forEach { m ->
                                androidx.compose.material3.FilterChip(
                                    selected = s.selectedModel == m,
                                    onClick = { vm.selectModel(if (s.selectedModel == m) null else m) },
                                    label = { Text(m) },
                                )
                            }
                        }
                        Text(
                            if (s.selectedModel == null) "使用电脑端默认模型" else "本任务使用 ${s.selectedModel}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }

                    Text("权限模式", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp, bottom = 4.dp))
                    var menu by remember { mutableStateOf(false) }
                    androidx.compose.material3.OutlinedButton(onClick = { menu = true }) {
                        Text("${modeLabel(s.mode)} · ${modeDesc(s.mode)}", maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        MODES.forEach { m ->
                            androidx.compose.material3.DropdownMenuItem(
                                text = {
                                    Column {
                                        Text(modeLabel(m))
                                        Text(modeDesc(m), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                },
                                onClick = {
                                    vm.setMode(m)
                                    menu = false
                                },
                            )
                        }
                    }

                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = s.prompt,
                        onValueChange = { vm.setPrompt(it) },
                        label = { Text("任务目标") },
                        placeholder = { Text("例：把登录页改成手机号一键登录，并补充单元测试") },
                        minLines = 3,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            Button(
                onClick = { vm.submit() },
                enabled = !s.submitting && (s.selectedDir != null || s.customDir.isNotBlank()) && s.prompt.isNotBlank(),
                modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp).height(52.dp),
            ) {
                if (s.submitting) {
                    CircularProgressIndicator(modifier = Modifier.height(20.dp).width(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("AI 正在电脑上执行…")
                } else {
                    Text("发起任务")
                }
            }
        }
    }
}
