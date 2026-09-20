package com.zcode.mobile.ui.common

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 当前应用版本名（如 0.2.0），用于更新比较 */
fun appVersion(context: Context): String = try {
    context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.0.0"
} catch (e: Exception) {
    "0.0.0"
}

/** token 数中文单位：>=1亿 → x.xx亿，>=1万 → x.x万，否则原值 */
fun fmtTokens(n: Long): String = when {
    n >= 100_000_000 -> String.format(Locale.US, "%.2f亿", n / 100_000_000.0)
    n >= 10_000 -> String.format(Locale.US, "%.1f万", n / 10_000.0)
    else -> n.toString()
}

/** 毫秒时长：1h2m / 3m20s / 45s / 800ms */
fun fmtDuration(ms: Long): String = when {
    ms <= 0 -> ""
    ms >= 3_600_000 -> "${ms / 3_600_000}h${(ms % 3_600_000) / 60_000}m"
    ms >= 60_000 -> "${ms / 60_000}m${(ms % 60_000) / 1000}s"
    ms >= 1000 -> "${ms / 1000}s"
    else -> "${ms}ms"
}

fun relativeTime(epochMs: Long?): String {
    if (epochMs == null || epochMs <= 0) return ""
    val diff = System.currentTimeMillis() - epochMs
    val minute = 60_000L
    val hour = 60 * minute
    val day = 24 * hour
    return when {
        diff < minute -> "刚刚"
        diff < hour -> "${diff / minute} 分钟前"
        diff < day -> "${diff / hour} 小时前"
        diff < 7 * day -> "${diff / day} 天前"
        else -> SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date(epochMs))
    }
}

fun formatTime(epochMs: Long?): String {
    if (epochMs == null || epochMs <= 0) return ""
    return SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(epochMs))
}

/** 项目路径取末段作为显示名 */
fun pathName(directory: String): String {
    val cleaned = directory.trimEnd('\\', '/')
    val idx = cleaned.lastIndexOfAny(charArrayOf('\\', '/'))
    return if (idx >= 0) cleaned.substring(idx + 1) else cleaned
}

fun diffStat(additions: Long?, deletions: Long?, files: Long?): String? {
    if (additions == null && deletions == null && files == null) return null
    val parts = mutableListOf<String>()
    if (files != null && files > 0) parts.add("${files} 文件")
    if (additions != null && additions > 0) parts.add("+${additions}")
    if (deletions != null && deletions > 0) parts.add("-${deletions}")
    return if (parts.isEmpty()) null else parts.joinToString(" ")
}

@Composable
fun LoadingBox(message: String = "加载中…") {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun ErrorBox(message: String, modifier: Modifier = Modifier) {
    Text(
        message,
        modifier = modifier.padding(24.dp),
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
    )
}
