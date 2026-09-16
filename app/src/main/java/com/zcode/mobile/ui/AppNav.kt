package com.zcode.mobile.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.zcode.mobile.AppContainer
import com.zcode.mobile.ZcodeApp
import com.zcode.mobile.ui.chat.ChatScreen
import com.zcode.mobile.ui.connect.ConnectScreen
import com.zcode.mobile.ui.newtask.NewTaskScreen
import com.zcode.mobile.ui.sessions.SessionsScreen
import com.zcode.mobile.ui.settings.SettingsScreen

object Routes {
    const val CONNECT = "connect"
    const val SESSIONS = "sessions"
    const val CHAT = "chat/{sessionId}"
    const val NEW_TASK = "newtask"
    const val SETTINGS = "settings"

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
fun AppNav(autoServer: String? = null, autoToken: String? = null) {
    val nav = rememberNavController()
    val container = appContainer()
    // DataStore 首次读取前无法判断是否已有配置，先等首个真实值再决定起点
    val connectionState by container.settings.connection.collectAsState(initial = LOADING)

    if (connectionState === LOADING) return

    val start = if (connectionState != null) Routes.SESSIONS else Routes.CONNECT

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
            )
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(
                onBack = { nav.popBackStack() },
                onOpenConnect = { nav.navigate(Routes.CONNECT) },
            )
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
}
