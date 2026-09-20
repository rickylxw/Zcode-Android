// CI（GitHub Actions）直连官方仓库；本地构建优先国内镜像，网络不通时自动回退官方源。
// 阿里云镜像偶尔滞后（曾缺最新 Compose 工件导致 CI 失败），所以 CI 下完全不经过它。
// 注意：pluginManagement 块独立编译，看不到脚本顶层 val，环境变量需在块内直接读取。

pluginManagement {
    val onCi = System.getenv("CI") == "true"
    val aliyun = listOf(
        "https://maven.aliyun.com/repository/google",
        "https://maven.aliyun.com/repository/central",
        "https://maven.aliyun.com/repository/gradle-plugin",
    )
    repositories {
        if (!onCi) aliyun.forEach { maven(it) }
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    val onCi = System.getenv("CI") == "true"
    val aliyun = listOf(
        "https://maven.aliyun.com/repository/google",
        "https://maven.aliyun.com/repository/central",
    )
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        if (!onCi) aliyun.forEach { maven(it) }
        google()
        mavenCentral()
    }
}

rootProject.name = "ZCode Android"
include(":app")
