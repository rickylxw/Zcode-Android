package com.zcode.mobile.ui.remote

import android.content.Intent
import android.net.Uri
import android.os.Message
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import com.zcode.mobile.BuildConfig
import com.zcode.mobile.ui.appContainer
import kotlinx.coroutines.launch

/**
 * 官方网页端（zcode.z.ai 远程控制）。
 * 链接来自电脑端 ZCode「远程控制」，含配对凭证且有有效期——过期后在电脑端重新生成即可。
 * 优先用系统浏览器打开（带完整登录态和引擎）；应用内 WebView 作为备选（部分认证流程可能受限）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RemoteScreen(autoUrl: String? = null, onBack: () -> Unit) {
    val container = appContainer()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var savedUrl by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }
    var loaded by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var loadingPage by remember { mutableStateOf(false) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var useWebView by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        savedUrl = container.settings.remoteUrlOnce()
        draft = autoUrl ?: savedUrl.orEmpty()
        loaded = true
        editing = savedUrl.isNullOrBlank()
        if (!autoUrl.isNullOrBlank()) container.settings.saveRemoteUrl(autoUrl) // 自动化测试：直接保存
    }

    fun saveAndOpen(openBrowser: Boolean) {
        val u = draft.trim()
        if (!u.startsWith("http")) {
            error = "链接格式不对，应以 https:// 开头"
            return
        }
        error = null
        scope.launch { container.settings.saveRemoteUrl(u) }
        savedUrl = u
        editing = false
        if (openBrowser) {
            context.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } else {
            useWebView = true
        }
    }

    BackHandler(enabled = useWebView) {
        val wv = webView
        if (wv?.canGoBack() == true) wv.goBack() else useWebView = false
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("官方网页端") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    if (savedUrl != null && !editing) {
                        IconButton(onClick = { editing = true }) {
                            Icon(Icons.Filled.Edit, contentDescription = "更换链接")
                        }
                    }
                },
            )
        },
    ) { padding ->
        when {
            !loaded -> Column(Modifier.fillMaxSize().padding(padding)) {}

            editing || savedUrl == null -> Column(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(20.dp),
            ) {
                Icon(Icons.Filled.Language, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(44.dp))
                Spacer(Modifier.height(10.dp))
                Text("配置官方网页端", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(6.dp))
                Text(
                    "在电脑端 ZCode 打开「远程控制」后，把它生成的链接粘贴到这里。" +
                        "网页端通过智谱云端中继连接电脑，任何网络下都能获得完整实时体验（含字符级流式）。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(14.dp))
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    label = { Text("远程控制链接") },
                    placeholder = { Text("https://zcode.z.ai/remote/v4?sid=…") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = { saveAndOpen(openBrowser = false) },
                    enabled = draft.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("保存并在应用内打开")
                }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = { saveAndOpen(openBrowser = true) },
                    enabled = draft.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Filled.OpenInBrowser, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("在系统浏览器中打开（备用）")
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    "安全提示：该链接等同于电脑控制权，请勿分享给他人。" +
                        "链接有有效期，打不开或黑屏时请在电脑端重新生成。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            useWebView -> Column(Modifier.fillMaxSize().padding(padding)) {
                if (loadingPage) {
                    LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
                }
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        WebView(ctx).apply {
                            if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.mediaPlaybackRequiresUserGesture = false
                            // 去掉 UA 里的 WebView 标识，避免站点按内嵌浏览器降级或拒绝
                            settings.userAgentString =
                                settings.userAgentString?.replace("; wv", "")
                            // 登录/配对流程会用 window.open 新开窗口：默认会被静默丢弃导致黑屏，
                            // 这里拦截并让新窗口内容继续在当前 WebView 打开
                            settings.setSupportMultipleWindows(true)
                            CookieManager.getInstance().setAcceptCookie(true)
                            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                            webViewClient = object : WebViewClient() {
                                override fun shouldOverrideUrlLoading(
                                    view: WebView,
                                    request: WebResourceRequest,
                                ): Boolean = false // 全部在应用内打开（含 OAuth 跳转）

                                override fun onPageFinished(view: WebView?, u: String?) {
                                    loadingPage = false
                                }
                                override fun doUpdateVisitedHistory(view: WebView?, u: String?, isReload: Boolean) {
                                    loadingPage = true
                                }
                            }
                            webChromeClient = object : WebChromeClient() {
                                override fun onCreateWindow(
                                    view: WebView,
                                    isDialog: Boolean,
                                    isUserGesture: Boolean,
                                    resultMsg: android.os.Message,
                                ): Boolean {
                                    // 新窗口重定向到主 WebView
                                    val temp = WebView(view.context)
                                    temp.webViewClient = object : WebViewClient() {
                                        override fun shouldOverrideUrlLoading(v: WebView, url: String): Boolean {
                                            view.loadUrl(url)
                                            return true
                                        }
                                    }
                                    (resultMsg.obj as? WebView.WebViewTransport)?.webView = temp
                                    resultMsg.sendToTarget()
                                    return true
                                }
                            }
                            loadUrl(savedUrl!!)
                        }
                    },
                    onRelease = { it.destroy() },
                )
            }

            else -> Column(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(Icons.Filled.Language, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(44.dp))
                Spacer(Modifier.height(10.dp))
                Text("链接已保存", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(6.dp))
                Text(
                    savedUrl ?: "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3,
                )
                Spacer(Modifier.height(16.dp))
                Button(
                    onClick = { useWebView = true },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("在应用内打开")
                }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = {
                        savedUrl?.let { u ->
                            context.startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Filled.OpenInBrowser, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("在系统浏览器中打开（备用）")
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    "打不开或黑屏：链接可能已过期，请在电脑端重新生成并更换；" +
                        "或改用「应用内打开」。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
