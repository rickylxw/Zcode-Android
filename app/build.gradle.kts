plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.zcode.mobile"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.zcode.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 15
        versionName = "0.4.7"
    }

    // 签名密钥不进仓库：本地构建用 app/release.jks（见 README「发布」），
    // CI 从环境变量 KEYSTORE_FILE/KEYSTORE_PASSWORD/KEY_ALIAS/KEY_PASSWORD 读取。
    // 密钥丢失 = 无法再给老用户发更新，请务必备份 app/release.jks。
    signingConfigs {
        create("release") {
            val envFile = System.getenv("KEYSTORE_FILE")
            storeFile = if (envFile != null) File(envFile) else file("release.jks")
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: "zcode-update-2026"
            keyAlias = System.getenv("KEY_ALIAS") ?: "zcode"
            keyPassword = System.getenv("KEY_PASSWORD") ?: "zcode-update-2026"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // AGP 9 内建 Kotlin：jvmTarget 默认对齐 compileOptions，无需 kotlinOptions 块
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.markdown.renderer)
    implementation(libs.markdown.renderer.m3)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
