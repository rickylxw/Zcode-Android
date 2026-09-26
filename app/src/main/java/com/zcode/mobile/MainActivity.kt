package com.zcode.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.zcode.mobile.ui.AppNav
import com.zcode.mobile.ui.theme.ZcodeTheme

class MainActivity : ComponentActivity() {

    private val notifPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* 拒绝则收不到后台通知，App 内功能不受影响 */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Android 13+ 通知权限：进 App 即申请（拒绝则收不到后台任务通知）
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        // 便于自动化/调试：adb shell am start 传 --es server --es token 可自动连接
        val autoServer = intent?.getStringExtra("server")
        val autoToken = intent?.getStringExtra("token")
        val autoRemote = intent?.getStringExtra("remote")
        setContent {
            ZcodeTheme {
                AppNav(autoServer = autoServer, autoToken = autoToken, autoRemote = autoRemote)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        (application as ZcodeApp).container.appInForeground = true
    }

    override fun onPause() {
        super.onPause()
        (application as ZcodeApp).container.appInForeground = false
    }
}
