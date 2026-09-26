package com.zcode.mobile.data

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.zcode.mobile.MainActivity
import com.zcode.mobile.R

/**
 * 系统通知：App 在后台时收到任务完成 / 审批请求 / 审批超时等事件时弹出。
 * 轻量实现——通知只在 App 进程存活期间有效（WS 随进程保持）；进程被杀则停止推送，
 * 重新打开 App 后自动重连续收。
 */
class Notifier(private val context: Context) {

    init {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "任务动态",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = "电脑端任务的开始/完成与审批请求" }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /** Android 13+ 通知运行时权限是否已授予 */
    fun permissionGranted(): Boolean =
        android.os.Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    fun notify(id: Int, title: String, text: String) {
        if (!permissionGranted()) return
        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pi = PendingIntent.getActivity(
            context, id, open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(id, n)
        } catch (_: SecurityException) {
        }
    }

    companion object {
        private const val CHANNEL_ID = "bridge_events"

        /** 通知 id 分组：审批请求用固定前缀位，任务完成用 sessionId 哈希，避免互相覆盖 */
        fun approvalId(requestId: String) = 1_000_000 + requestId.hashCode()
        fun resultId(sessionId: String) = 2_000_000 + sessionId.hashCode()
    }
}
