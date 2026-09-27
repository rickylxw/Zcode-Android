package com.zcode.mobile.ui

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.zcode.mobile.AppContainer
import com.zcode.mobile.ZcodeApp
import com.zcode.mobile.data.BridgeSocket
import com.zcode.mobile.ui.chat.ChatScreen
import com.zcode.mobile.ui.connect.ConnectScreen
import com.zcode.mobile.ui.newtask.NewTaskScreen
import com.zcode.mobile.ui.remote.RemoteScreen
import com.zcode.mobile.ui.sessions.SessionsScreen
import com.zcode.mobile.ui.settings.SettingsScreen

object Routes {
    const val CONNECT = "connect"
    const val SESSIONS = "sessions"
    const val CHAT = "chat/{sessionId}"
    const val NEW_TASK = "newtask"
    const val SETTINGS = "settings"
    const val REMOTE = "remote"

    fun chat(sessionId: String) = "chat/$sessionId"
}

private val LOADING = Any()

/** 各页面统一从这里取 AppContainer（避免引入 DI 框架） */
@Composable
fun appContainer(): AppContainer =
    (LocalContext.current.applicationContext as ZcodeApp).container

@Composable
inline fun <reified VM : androidx.lifecycle.ViewModel> appViewModel(
    noinline initializer: androidx.lifecycle.viewmodel.CreationExtras.(AppContainer) -> VM,
): VM {
    val container = appContainer()
    return viewModel {
        initializer(container)
    }
}

@Composable
fun AppNav(autoServer: String? = null, autoToken: String? = null, autoRemote: String? = null) {
    val nav = rememberNavController()
    val container = appContainer()
    // DataStore 首次读取前无法判断是否已有配置，先等首个真实值再决定起点
    val connectionState by container.settings.connection.collectAsState(initial = LOADING)

    if (connectionState === LOADING) return

    val start = when {
        autoRemote != null -> Routes.REMOTE
        connectionState != null -> Routes.SESSIONS
        else -> Routes.CONNECT
    }

    NavHost(navController = nav, startDestination = start) {
        composable(Routes.CONNECT) {
            ConnectScreen(
                autoServer = autoServer,
                autoToken = autoToken,
                onConnected = {
                    nav.navigate(Routes.SESSIONS) { popUpTo(Routes.CONNECT) { inclusive = true } }
                }
            )
        }
        composable(Routes.SESSIONS) {
            SessionsScreen(
                onOpenSession = { nav.navigate(Routes.chat(it)) },
                onNewTask = { nav.navigate(Routes.NEW_TASK) },
                onOpenSettings = { nav.navigate(Routes.SETTINGS) },
                onOpenRemote = { nav.navigate(Routes.REMOTE) },
            )
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(
                onBack = { nav.popBackStack() },
                onOpenConnect = { nav.navigate(Routes.CONNECT) },
                onOpenRemote = { nav.navigate(Routes.REMOTE) },
            )
        }
        composable(Routes.REMOTE) {
            RemoteScreen(autoUrl = autoRemote, onBack = { nav.popBackStack() })
        }
        composable(Routes.CHAT) { entry ->
            val sessionId = entry.arguments?.getString("sessionId") ?: return@composable
            ChatScreen(
                sessionId = sessionId,
                onBack = { nav.popBackStack() },
            )
        }
        composable(Routes.NEW_TASK) {
            NewTaskScreen(
                onBack = { nav.popBackStack() },
                onCreated = { sessionId ->
                    nav.navigate(Routes.chat(sessionId)) {
                        popUpTo(Routes.NEW_TASK) { inclusive = true }
                    }
                },
            )
        }
    }

    // 全局事件弹窗：不在对应聊天页时，任务完成 / 审批 / 提问弹对话框（审批可跨页直接应答）
    GlobalEventsDialogs(container)
}

/** 跨页面事件弹窗宿主：与聊天页内对话框互斥（activeChatSessionId 相同则让位） */
@Composable
private fun GlobalEventsDialogs(container: AppContainer) {
    var globalRequest by remember { mutableStateOf<BridgeSocket.Event.InteractionRequest?>(null) }
    var globalNotice by remember { mutableStateOf<Pair<String, String>?>(null) }
    val lastNoticeAt = remember { mutableMapOf<String, Long>() }

    LaunchedEffect(Unit) {
        container.socket.events.collect { ev ->
            when (ev) {
                is BridgeSocket.Event.InteractionRequest ->
                    if (container.activeChatSessionId != ev.sessionId) globalRequest = ev

                is BridgeSocket.Event.TurnResult ->
                    if (container.activeChatSessionId == null || container.activeChatSessionId != ev.sessionId) {
                        globalNotice = "任务完成" to ev.response.take(160).ifBlank { "回合已结束" }
                    }

                is BridgeSocket.Event.Progress -> if (ev.kind == "turn_completed") {
                    // 双通道会各送一份：同会话 8 秒内只弹一次；在当前聊天页时由页面自行呈现
                    if (container.activeChatSessionId != ev.sessionId) {
                        val now = android.os.SystemClock.elapsedRealtime()
                        val key = ev.sessionId
                        if (now - (lastNoticeAt[key] ?: 0) > 8000) {
                            lastNoticeAt[key] = now
                            globalNotice = "任务完成" to "会话 ${ev.sessionId.takeLast(8)} 的任务已执行完毕"
                        }
                    }
                }

                else -> Unit
            }
        }
    }

    globalRequest?.let { req ->
        com.zcode.mobile.ui.chat.ApprovalDialog(
            req = req,
            onRespond = { resp ->
                container.socket.respondRequest(req.requestId, resp)
                globalRequest = null
            },
            onDismiss = { globalRequest = null },
        )
    }
    globalNotice?.let { (title, text) ->
        AlertDialog(
            onDismissRequest = { globalNotice = null },
            title = { Text(title) },
            text = { Text(text) },
            confirmButton = {
                TextButton(onClick = { globalNotice = null }) { Text("知道了") }
            },
        )
    }
}
