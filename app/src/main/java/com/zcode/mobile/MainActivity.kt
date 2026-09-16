package com.zcode.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.zcode.mobile.ui.AppNav
import com.zcode.mobile.ui.theme.ZcodeTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // 便于自动化/调试：adb shell am start 传 --es server --es token 可自动连接
        val autoServer = intent?.getStringExtra("server")
        val autoToken = intent?.getStringExtra("token")
        setContent {
            ZcodeTheme {
                AppNav(autoServer = autoServer, autoToken = autoToken)
            }
        }
    }
}
