package com.zcode.mobile.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/** GitHub Releases 自动更新：检查最新版本 → 下载 APK → 拉起系统安装 */
class UpdateChecker(private val context: Context) {

    companion object {
        /** 内置默认更新源；用户在设置页保存过配置后以保存值为准 */
        const val DEFAULT_REPO = "rickylxw/Zcode-Android"
    }

    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    data class UpdateInfo(
        val version: String,
        val notes: String,
        val apkUrl: String,
        val sizeBytes: Long,
    )

    /** 查询仓库最新 Release（要求 Public 仓库，且 Release 里有 .apk 附件） */
    suspend fun check(repo: String): UpdateInfo = withContext(Dispatchers.IO) {
        val r = repo.trim()
        if (r.isBlank() || !r.contains('/')) throw UpdateException("未配置更新源：请填写 GitHub 仓库（格式 owner/repo）")
        val req = Request.Builder()
            .url("https://api.github.com/repos/$r/releases/latest")
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "ZCode-Mobile")
            .build()
        client.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (resp.code == 404) {
                throw UpdateException("找不到仓库或 Release：请确认 owner/repo 正确、仓库已 Public、且已发布过带 APK 的 Release")
            }
            if (!resp.isSuccessful) throw UpdateException("GitHub API ${resp.code}：${body.take(200)}")
            val obj = try {
                json.parseToJsonElement(body).jsonObject
            } catch (e: Exception) {
                throw UpdateException("GitHub 返回的不是 JSON：${body.take(120)}")
            }
            val tag = obj["tag_name"]?.let { (it as? JsonPrimitive)?.contentOrNull }
                ?: throw UpdateException("Release 响应缺少 tag_name")
            val assets = obj["assets"]?.jsonArray ?: throw UpdateException("Release 响应缺少 assets")
            val apk = assets.asSequence()
                .mapNotNull { it as? kotlinx.serialization.json.JsonObject }
                .mapNotNull { a ->
                    val name = (a["name"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
                    if (name.endsWith(".apk", ignoreCase = true)) a to name else null
                }
                .firstOrNull()
                ?: throw UpdateException("最新 Release（$tag）里没有 .apk 附件")
            val url = (apk.first["browser_download_url"] as? JsonPrimitive)?.contentOrNull
                ?: throw UpdateException("APK 附件缺少下载地址")
            val size = (apk.first["size"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: 0L
            val notes = (obj["body"] as? JsonPrimitive)?.contentOrNull.orEmpty()
            UpdateInfo(version = tag.trim().removePrefix("v").removePrefix("V"), notes = notes, apkUrl = url, sizeBytes = size)
        }
    }

    /** 点分版本号比较：remote 是否比 current 新 */
    fun isNewer(remote: String, current: String): Boolean {
        fun parts(v: String) = v.split('.').map { it.trim().filter { c -> c.isDigit() }.ifEmpty { "0" }.toInt() }
        val r = parts(remote)
        val c = parts(current)
        for (i in 0 until maxOf(r.size, c.size)) {
            val a = r.getOrElse(i) { 0 }
            val b = c.getOrElse(i) { 0 }
            if (a != b) return a > b
        }
        return false
    }

    /**
     * 下载 APK 到应用缓存目录。proxyPrefix 用于国内加速（如 https://mirror.ghproxy.com/ ），
     * 会拼在 GitHub 下载地址前面；留空则直连。
     */
    suspend fun download(apkUrl: String, proxyPrefix: String, onProgress: (Long, Long) -> Unit): File =
        withContext(Dispatchers.IO) {
            val url = if (proxyPrefix.isBlank()) apkUrl else proxyPrefix.trimEnd('/') + '/' + apkUrl
            val target = File(context.cacheDir, "update.apk")
            target.parentFile?.mkdirs()
            val req = Request.Builder().url(url).header("User-Agent", "ZCode-Mobile").build()
            try {
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) throw UpdateException("下载失败：HTTP ${resp.code}")
                    val total = resp.body?.contentLength() ?: -1L
                    val input = resp.body?.byteStream() ?: throw UpdateException("下载失败：空响应")
                    target.outputStream().use { out ->
                        val buf = ByteArray(16 * 1024)
                        var read: Int
                        var done = 0L
                        var lastReport = 0L
                        while (input.read(buf).also { read = it } >= 0) {
                            out.write(buf, 0, read)
                            done += read
                            if (done - lastReport > 256 * 1024) {
                                lastReport = done
                                onProgress(done, total)
                            }
                        }
                        out.flush()
                    }
                }
            } catch (e: Exception) {
                target.delete()
                throw e
            }
            onProgress(target.length(), target.length())
            target
        }

    /** 拉起系统安装器；返回 false 表示缺少「安装未知应用」授权，需要先引导用户开启 */
    fun canInstall(): Boolean =
        android.os.Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    fun openInstallPermissionSettings() {
        val i = Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.packageName))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(i)
    }

    fun install(file: File) {
        val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
        val i = Intent(Intent.ACTION_INSTALL_PACKAGE)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(i)
    }
}

class UpdateException(message: String) : Exception(message)
