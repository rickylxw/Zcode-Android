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

    /** 当前打开的聊天页会话（ChatViewModel init/onCleared 维护）；全局弹窗据此避免与页内对话框重复 */
    @Volatile
    var activeChatSessionId: String? = null

    /**
     * 全局事件监听：App 打开即连 WS；退到后台后收到「任务完成 / 审批请求 / 任务开始」弹系统通知。
     * 轻量实现——通知只在 App 进程存活期间有效（WS 随进程保持）；进程被系统杀掉后通知停止，
     * 重新打开 App 自动重连恢复。前台时由聊天页呈现，不重复打扰。
     */
    fun watchEvents() {
        socket.ensureConnected()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            socket.events.collect { ev ->
                if (appInForeground) return@collect // 前台时由聊天页/全局对话框呈现，不重复打扰
                when (ev) {
                    is BridgeSocket.Event.InteractionRequest -> notifier.notify(
                        Notifier.approvalId(ev.requestId),
                        if (ev.kind == "permission") "需要审批：${ev.toolName ?: "工具执行"}" else "电脑端提问",
                        ev.reason?.take(120) ?: "打开 App 处理",
                        urgent = true, // 120 秒超时，弹横幅提醒
                    )

                    is BridgeSocket.Event.TurnResult -> {
                        // 手机自己发起的回合完成：标记时间戳，压制随后的 turn_completed 进度通知（双通道会再送两份）
                        val sid = ev.sessionId ?: "turn"
                        lastCompletionNotify[sid] = android.os.SystemClock.elapsedRealtime()
                        notifier.notify(
                            Notifier.resultId(sid),
                            "任务完成",
                            ev.response.take(140).ifBlank { "回合已结束" },
                        )
                    }

                    is BridgeSocket.Event.Progress -> when (ev.kind) {
                        "turn_started" -> notifier.notify(
                            Notifier.resultId(ev.sessionId),
                            "任务开始",
                            "电脑端开始执行任务",
                        )

                        // 电脑端发起的回合没有 TurnResult，靠这条进度事件通知完成（双通道各一份，8s 去重）
                        "turn_completed" -> {
                            val now = android.os.SystemClock.elapsedRealtime()
                            if (now - (lastCompletionNotify[ev.sessionId] ?: 0L) > 8000) {
                                lastCompletionNotify[ev.sessionId] = now
                                notifier.notify(
                                    Notifier.resultId(ev.sessionId),
                                    "任务完成",
                                    "电脑端的任务已执行完毕，点开查看结果",
                                )
                            }
                        }

                        else -> Unit
                    }

                    is BridgeSocket.Event.SessionUpdated ->
                        // 广播信号（手机未订阅该会话也能收到）：电脑端任务完成 → 通知。
                        // 与 progress 路径共用去重表，同一回合不会重复弹。
                        if (ev.reason == "turn_completed" && ev.sessionId != null) {
                            val now = android.os.SystemClock.elapsedRealtime()
                            if (now - (lastCompletionNotify[ev.sessionId] ?: 0L) > 8000) {
                                lastCompletionNotify[ev.sessionId] = now
                                notifier.notify(
                                    Notifier.resultId(ev.sessionId),
                                    "任务完成",
                                    "电脑端的任务已执行完毕，点开查看结果",
                                )
                            }
                        }

                    else -> Unit
                }
            }
        }
    }

    /** 会话 → 最近一次「完成」通知时刻：压制同一回合的多路重复事件 */
    private val lastCompletionNotify = java.util.concurrent.ConcurrentHashMap<String, Long>()
}
