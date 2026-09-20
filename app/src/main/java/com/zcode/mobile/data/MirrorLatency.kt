package com.zcode.mobile.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * APK 下载加速镜像。
 * - prefix 会拼在 GitHub 的 APK 下载地址前：prefix + https://github.com/.../xx.apk
 * - probe 用一个轻量 HTTPS 端点测连通延迟（TLS 握手 + 首字节，能代表该镜像可达性）
 * - 延迟由 SettingsScreen 进入时并发探测，结果缓存于单例 StateFlow
 */
data class Mirror(val name: String, val prefix: String, val probeUrl: String, val direct: Boolean = false)

object Mirrors {
    // ghproxy 系镜像同时支持 api.github.com 与 release 下载，用它测速最有代表性
    private val MIRRORS = listOf(
        Mirror("直连（不加速）", "", "https://api.github.com/", direct = true),
        Mirror("ghproxy.com", "https://mirror.ghproxy.com/", "https://mirror.ghproxy.com/https://api.github.com/"),
        Mirror("gh-proxy.com", "https://gh-proxy.com/", "https://gh-proxy.com/https://api.github.com/"),
        Mirror("ghfast.top", "https://ghfast.top/", "https://ghfast.top/https://api.github.com/"),
        Mirror("gh.llkk.cc", "https://gh.llkk.cc/", "https://gh.llkk.cc/https://api.github.com/"),
        Mirror("hk.gh-proxy.com", "https://hk.gh-proxy.com/", "https://hk.gh-proxy.com/https://api.github.com/"),
    )

    val all: List<Mirror> get() = MIRRORS

    fun findByPrefix(prefix: String): Mirror? = MIRRORS.find { it.prefix == prefix }
}

data class MirrorLatency(val ms: Long?, val probing: Boolean = false)

/** 并发探测各镜像延迟；结果全局缓存（每次进设置页可下拉刷新重测） */
class MirrorLatencyTester {

    private val scope = CoroutineScope(Dispatchers.IO)

    private val _latencies = MutableStateFlow<Map<String, MirrorLatency>>(emptyMap())
    val latencies: StateFlow<Map<String, MirrorLatency>> = _latencies.asStateFlow()

    private val inFlight = ConcurrentHashMap<String, Boolean>()

    /** 标记全部为探测中并起测（已有结果的先显示旧值） */
    fun probeAll() {
        for (m in Mirrors.all) {
            _latencies.value = _latencies.value + (m.prefix to (_latencies.value[m.prefix] ?: MirrorLatency(null, probing = true)))
            if (inFlight.putIfAbsent(m.prefix, true) != null) continue // 该镜像已在测
            scope.launch {
                val ms = probe(m.probeUrl)
                inFlight.remove(m.prefix)
                _latencies.value = _latencies.value + (m.prefix to MirrorLatency(ms, probing = false))
            }
        }
    }

    companion object {
        /** HEAD 请求测延迟；失败/超时返回 null（不可用） */
        suspend fun probe(url: String, timeoutMs: Int = 4000): Long? = withContext(Dispatchers.IO) {
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = "HEAD"
                conn.connectTimeout = timeoutMs
                conn.readTimeout = timeoutMs
                conn.instanceFollowRedirects = true
                conn.setRequestProperty("User-Agent", "ZCode-Mobile")
                conn.useCaches = false
                val start = System.currentTimeMillis()
                conn.connect()
                val code = conn.responseCode
                val elapsed = System.currentTimeMillis() - start
                conn.disconnect()
                // 2xx/3xx 视为可用（部分镜像对 HEAD 返回 405 时也算可达——放宽到 <500）
                if (code in 200..499) elapsed else null
            } catch (e: Exception) {
                null
            }
        }
    }
}
