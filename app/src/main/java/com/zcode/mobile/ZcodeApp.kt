package com.zcode.mobile

import android.app.Application
import com.zcode.mobile.data.BridgeApi
import com.zcode.mobile.data.BridgeSocket
import com.zcode.mobile.data.Notifier
import com.zcode.mobile.data.SettingsRepo
import com.zcode.mobile.data.UpdateChecker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class ZcodeApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.watchEvents()
    }
}

/** 手工依赖容器：App 内全局唯一的设置/REST/WS/更新实例 */
class AppContainer(app: Application) {
    val context: Application = app
    val settings = SettingsRepo(app)
    val api = BridgeApi(settings)
    val socket = BridgeSocket(settings)
    val updater = UpdateChecker(app)
    val notifier = Notifier(app)

    /** 主 Activity 在前台时为 true（MainActivity onResume/onPause 维护） */
    @Volatile
    var appInForeground: Boolean = false

    /**
     * 全局事件监听：App 打开即连 WS；退到后台后收到「任务完成 / 审批请求 / 任务开始」弹系统通知。
     * 轻量实现——通知只在 App 进程存活期间有效（WS 随进程保持）；进程被系统杀掉后通知停止，
     * 重新打开 App 自动重连恢复。前台时由聊天页呈现，不重复打扰。
     */
    fun watchEvents() {
        socket.ensureConnected()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            socket.events.collect { ev ->
                if (appInForeground) return@collect
                when (ev) {
                    is BridgeSocket.Event.InteractionRequest -> notifier.notify(
                        Notifier.approvalId(ev.requestId),
                        if (ev.kind == "permission") "需要审批：${ev.toolName ?: "工具执行"}" else "电脑端提问",
                        ev.reason?.take(120) ?: "打开 App 处理",
                    )

                    is BridgeSocket.Event.TurnResult -> notifier.notify(
                        Notifier.resultId(ev.sessionId ?: "turn"),
                        "任务完成",
                        ev.response.take(140).ifBlank { "回合已结束" },
                    )

                    is BridgeSocket.Event.Progress -> if (ev.kind == "turn_started") {
                        notifier.notify(
                            Notifier.resultId(ev.sessionId),
                            "任务开始",
                            "电脑端开始执行任务",
                        )
                    }

                    else -> Unit
                }
            }
        }
    }
}
