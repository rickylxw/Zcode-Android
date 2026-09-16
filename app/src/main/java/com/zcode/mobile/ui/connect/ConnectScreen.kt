package com.zcode.mobile.ui.connect

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.zcode.mobile.data.BridgeException
import com.zcode.mobile.data.SettingsRepo
import com.zcode.mobile.ui.appContainer
import kotlinx.coroutines.launch

/** 连接页：填写电脑上桥接服务的地址与配对 token；autoServer/autoToken 用于自动化直连 */
@Composable
fun ConnectScreen(autoServer: String? = null, autoToken: String? = null, onConnected: () -> Unit) {
    val container = appContainer()
    val scope = rememberCoroutineScope()

    var address by remember { mutableStateOf(autoServer ?: "") }
    var token by remember { mutableStateOf(autoToken ?: "") }
    var testing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun tryConnect() {
        val normalized = SettingsRepo.normalizeUrl(address)
        if (normalized == null) {
            error = "地址格式不对，示例：192.168.1.5:8787"
            return
        }
        if (token.isBlank()) {
            error = "请填写配对 token（启动桥接服务时控制台会显示）"
            return
        }
        testing = true
        error = null
        scope.launch {
            try {
                container.api.ping(normalized, token) // 先验证再保存
                container.settings.save(normalized, token)
                container.socket.disconnect() // 丢弃旧连接，用新配置重连
                onConnected()
            } catch (e: Exception) {
                error = when (e) {
                    is BridgeException -> "连不上电脑：${e.message}"
                    else -> "连不上电脑，请检查：① 桥接服务是否在运行 ② 手机与电脑是否同一网络 ③ 地址与 token 是否正确"
                }
            } finally {
                testing = false
            }
        }
    }

    // 自动化直连：地址与 token 均由外部提供时直接发起
    LaunchedEffect(autoServer, autoToken) {
        if (!autoServer.isNullOrBlank() && !autoToken.isNullOrBlank() && !testing) tryConnect()
    }

    // 已保存配置时预填（不覆盖自动化传入的值）
    LaunchedEffect(Unit) {
        if (address.isBlank() && token.isBlank()) {
            container.settings.current()?.let {
                address = it.serverUrl.removePrefix("http://").removePrefix("https://")
                token = it.token
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            Icons.Filled.Computer,
            contentDescription = null,
            modifier = Modifier.size(72.dp),
            tint = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.height(12.dp))
        Text("ZCode 手机端", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(4.dp))
        Text(
            "连接电脑上的 ZCode 桥接服务",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(32.dp))

        OutlinedTextField(
            value = address,
            onValueChange = { address = it },
            label = { Text("电脑地址") },
            placeholder = { Text("192.168.1.5:8787") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("配对 Token") },
            supportingText = { Text("在电脑上运行桥接服务后，控制台会打印 token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )

        error?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }

        Spacer(Modifier.height(24.dp))
        Button(
            onClick = { tryConnect() },
            enabled = !testing,
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            if (testing) {
                CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
            } else {
                Text("连接")
            }
        }
    }
}
