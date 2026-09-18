package com.zcode.mobile.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.zcode.mobile.data.UpdateException
import com.zcode.mobile.data.UpdateChecker
import com.zcode.mobile.ui.appContainer
import com.zcode.mobile.ui.common.appVersion
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private fun fmtSize(b: Long): String = when {
    b >= 100 * 1024 * 1024 -> "${b / 1024 / 1024} MB"
    b >= 1024 * 1024 -> String.format(Locale.US, "%.1f MB", b / 1024.0 / 1024.0)
    b > 0 -> "${b / 1024} KB"
    else -> ""
}

/** 更新区状态机 */
private sealed interface UpdateUi {
    data object Idle : UpdateUi
    data object Checking : UpdateUi
    data class UpToDate(val msg: String) : UpdateUi
    data class Available(val info: UpdateChecker.UpdateInfo) : UpdateUi
    data class Downloading(val done: Long, val total: Long) : UpdateUi
    data class Ready(val file: File, val info: UpdateChecker.UpdateInfo) : UpdateUi
    data class Failed(val msg: String) : UpdateUi
}

/** 设置页：更新源配置 + 检查更新/下载/安装；连接配置入口 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit, onOpenConnect: () -> Unit) {
    val container = appContainer()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val version = remember { appVersion(context) }

    var repo by remember { mutableStateOf("") }
    var proxy by remember { mutableStateOf("") }
    var loaded by remember { mutableStateOf(false) }

    var ui by remember { mutableStateOf<UpdateUi>(UpdateUi.Idle) }

    // 载入已保存的更新源配置（未保存过时用内置默认仓库）
    LaunchedEffect(Unit) {
        val cfg = container.settings.updateConfigOnce()
        repo = cfg.repo
        proxy = cfg.proxy
        loaded = true
    }

    fun saveConfig() {
        scope.launch { container.settings.saveUpdateConfig(repo, proxy) }
    }

    fun check() {
        saveConfig()
        ui = UpdateUi.Checking
        scope.launch {
            try {
                val info = container.updater.check(repo)
                if (container.updater.isNewer(info.version, version)) {
                    ui = UpdateUi.Available(info)
                } else {
                    ui = UpdateUi.UpToDate("已是最新版本（当前 v$version）")
                }
            } catch (e: Exception) {
                ui = UpdateUi.Failed(e.message ?: "检查失败")
            }
        }
    }

    fun downloadAndInstall(info: UpdateChecker.UpdateInfo) {
        ui = UpdateUi.Downloading(0, info.sizeBytes)
        scope.launch {
            try {
                val cfg = container.settings.updateConfigOnce()
                val file = container.updater.download(info.apkUrl, cfg.proxy) { done, total ->
                    ui = UpdateUi.Downloading(done, if (total > 0) total else info.sizeBytes)
                }
                ui = UpdateUi.Ready(file, info)
            } catch (e: Exception) {
                ui = UpdateUi.Failed("下载失败：${e.message}")
            }
        }
    }

    // 下载完成后拉起安装；缺授权时先引导去开
    LaunchedEffect(ui) {
        val u = ui
        if (u is UpdateUi.Ready) {
            if (container.updater.canInstall()) {
                container.updater.install(u.file)
            } else {
                container.updater.openInstallPermissionSettings()
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // 连接配置入口
            Surface(
                onClick = onOpenConnect,
                shape = MaterialTheme.shapes.medium,
                tonalElevation = 1.dp,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("连接配置", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
                }
            }

            Text("版本与更新", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            OutlinedTextField(
                value = repo,
                onValueChange = { repo = it },
                label = { Text("GitHub 仓库（更新源）") },
                placeholder = { Text("owner/repo，如 rickylxw/Zcode-Android") },
                supportingText = { Text("检查更新读取该仓库的最新 Release（需 Public 且附件里有 .apk）") },
                singleLine = true,
                enabled = loaded,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = proxy,
                onValueChange = { proxy = it },
                label = { Text("下载加速前缀（可选）") },
                placeholder = { Text("如 https://mirror.ghproxy.com/，留空直连") },
                supportingText = { Text("国内访问 GitHub 下载慢时填写加速镜像，会拼在 APK 下载地址前") },
                singleLine = true,
                enabled = loaded,
                modifier = Modifier.fillMaxWidth(),
            )

            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.SystemUpdate, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(8.dp))
                Text("当前版本 v$version", style = MaterialTheme.typography.bodyMedium)
            }

            when (val u = ui) {
                is UpdateUi.Checking -> Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("正在检查更新…", style = MaterialTheme.typography.bodyMedium)
                }

                is UpdateUi.Downloading -> Column {
                    val pct = if (u.total > 0) (u.done * 100 / u.total).toInt() else 0
                    Text("正在下载更新… $pct%（${fmtSize(u.done)}/${fmtSize(u.total)}）", style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(6.dp))
                    LinearProgressIndicator(
                        progress = { if (u.total > 0) (u.done.toFloat() / u.total) else 0f },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                is UpdateUi.Ready -> Column {
                    Text("下载完成，正在打开安装程序…", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        "若未弹出安装界面，请允许「安装未知应用」后重试",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                is UpdateUi.Available -> Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text("发现新版本 v${u.info.version}", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                        if (u.info.sizeBytes > 0) {
                            Text("大小 ${fmtSize(u.info.sizeBytes)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (u.info.notes.isNotBlank()) {
                            Spacer(Modifier.height(6.dp))
                            com.zcode.mobile.ui.chat.AssistantText(u.info.notes)
                        }
                        Spacer(Modifier.height(10.dp))
                        Button(onClick = { downloadAndInstall(u.info) }, modifier = Modifier.fillMaxWidth()) {
                            Text("下载并安装")
                        }
                    }
                }

                is UpdateUi.UpToDate -> Text(u.msg, color = MaterialTheme.colorScheme.secondary, style = MaterialTheme.typography.bodyMedium)
                is UpdateUi.Failed -> Text(u.msg, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                UpdateUi.Idle -> Unit
            }

            Button(onClick = { check() }, enabled = loaded && ui !is UpdateUi.Checking && ui !is UpdateUi.Downloading, modifier = Modifier.fillMaxWidth()) {
                Text("检查更新")
            }

            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onOpenConnect, modifier = Modifier.fillMaxWidth()) {
                Text("重新配置电脑连接")
            }

            Spacer(Modifier.height(16.dp))
            Text(
                "ZCode 手机端 · 电脑上的 ZCode 伴侣客户端\n桥接服务与发布说明见项目 README",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
