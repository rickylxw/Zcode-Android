package com.zcode.mobile

import android.app.Application
import com.zcode.mobile.data.BridgeApi
import com.zcode.mobile.data.BridgeSocket
import com.zcode.mobile.data.SettingsRepo
import com.zcode.mobile.data.UpdateChecker

class ZcodeApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}

/** 手工依赖容器：App 内全局唯一的设置/REST/WS/更新实例 */
class AppContainer(app: Application) {
    val context: Application = app
    val settings = SettingsRepo(app)
    val api = BridgeApi(settings)
    val socket = BridgeSocket(settings)
    val updater = UpdateChecker(app)
}
