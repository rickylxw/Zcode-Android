package com.zcode.mobile.ui.remote

import android.annotation.SuppressLint
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material.icons.filled.Public
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
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
import com.zcode.mobile.ui.appContainer
import com.zcode.mobile.ui.common.LoadingBox
import kotlinx.coroutines.launch

/**
 * 官方网页端（zcode.z.ai 远程控制）：WebView 全屏加载电脑端生成的远程链接。
 * 走智谱云端中继，可在任何网络下获得字符级流式的完整桌面镜像。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RemoteScreen(onBack: () -> Unit) {
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

    LaunchedEffect(Unit) {
        savedUrl = container.settings.remoteUrlOnce()
        draft = savedUrl.orEmpty()
        loaded = true
        editing = savedUrl.isNullOrBlank()
    }

    fun saveAndOpen() {
        val u = draft.trim()
        if (!u.startsWith("http")) {
            error = "链接格式不对，应以 https:// 开头"
            return
        }
        error = null
        scope.launch { container.settings.saveRemoteUrl(u) }
        savedUrl = u
        editing = false
    }

    BackHandler(enabled = savedUrl != null && !editing) {
        val wv = webView
        if (wv?.canGoBack() == true) wv.goBack() else onBack()
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
            !loaded -> LoadingBox()

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
                    onClick = { saveAndOpen() },
                    enabled = draft.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("保存并打开")
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    "安全提示：该链接等同于电脑控制权，请勿分享给他人。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            else -> Column(Modifier.fillMaxSize().padding(padding)) {
                if (loadingPage) {
                    LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
                }
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        WebView(ctx).apply {
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                            webViewClient = object : WebViewClient() {
                                override fun onPageFinished(view: WebView?, u: String?) {
                                    loadingPage = false
                                }
                                override fun doUpdateVisitedHistory(view: WebView?, u: String?, isReload: Boolean) {
                                    loadingPage = true
                                }
                            }
                            loadUrl(savedUrl!!)
                        }
                    },
                    onRelease = { it.destroy() },
                )
            }
        }
    }
}
