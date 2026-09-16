package com.zcode.mobile.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val LightColors = lightColorScheme(
    primary = Color(0xFF3F51B5),
    secondary = Color(0xFF00897B),
    surface = Color(0xFFF7F7FA),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF7AA2F7),
    secondary = Color(0xFF73DACA),
    background = Color(0xFF16161E),
    surface = Color(0xFF1A1B26),
)

@Composable
fun ZcodeTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val dynamic = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    val context = LocalContext.current
    val colors = when {
        dynamic -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        dark -> DarkColors
        else -> LightColors
    }
    MaterialTheme(colorScheme = colors, content = content)
}
