package com.zcode.mobile.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.mikepenz.markdown.m3.Markdown
import com.zcode.mobile.data.BlockDto
import com.zcode.mobile.data.TodoItemDto

/**
 * 助手消息渲染：按 ``` 代码围栏切分——代码块用自带复制按钮的深底样式，
 * 其余（标题/加粗/列表/链接/行内代码/表格等）交给 Markdown 库渲染。
 * 所有文本均包在 SelectionContainer 里：长按可选词复制。
 */
@Composable
fun AssistantText(text: String) {
    Column {
        val segments = splitFences(text)
        segments.forEach { seg ->
            if (seg.isCode) {
                CodeBlock(seg.content.trim('\n'), seg.lang)
            } else if (seg.content.isNotBlank()) {
                SelectionContainer {
                    Markdown(seg.content.trim('\n'))
                }
            }
        }
    }
}

private data class Seg(val isCode: Boolean, val content: String, val lang: String? = null)

private fun splitFences(text: String): List<Seg> {
    if (!text.contains("```")) return listOf(Seg(false, text))
    val out = mutableListOf<Seg>()
    var rest = text
    while (true) {
        val start = rest.indexOf("```")
        if (start < 0) {
            out.add(Seg(false, rest))
            break
        }
        if (start > 0) out.add(Seg(false, rest.substring(0, start)))
        val bodyStart = start + 3
        val lineEnd = rest.indexOf('\n', bodyStart)
        val lang = (if (lineEnd >= 0) rest.substring(bodyStart, lineEnd) else "")
            .trim().takeWhile { !it.isWhitespace() }.takeIf { it.isNotEmpty() }
        val codeStart = if (lineEnd >= 0) lineEnd + 1 else bodyStart // 跳过语言标注行
        val end = rest.indexOf("```", codeStart)
        if (end < 0) {
            out.add(Seg(true, rest.substring(codeStart), lang))
            break
        }
        out.add(Seg(true, rest.substring(codeStart, end), lang))
        rest = rest.substring(end + 3)
    }
    return out
}

@Composable
fun CodeBlock(code: String, lang: String? = null) {
    val context = LocalContext.current
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    lang ?: "代码",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontFamily = FontFamily.Monospace,
                )
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { copyToClipboard(context, code) }, modifier = Modifier.height(32.dp)) {
                    Icon(
                        Icons.Filled.ContentCopy,
                        contentDescription = "复制代码",
                        modifier = Modifier.width(16.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            SelectionContainer {
                Text(
                    code,
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

fun copyToClipboard(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("code", text))
}

/** 思考过程：默认折叠的暗色块 */
@Composable
fun ReasoningBlock(text: String) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(
                    Icons.Filled.Psychology,
                    contentDescription = null,
                    modifier = Modifier.width(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    "思考过程",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { expanded = !expanded }, modifier = Modifier.height(28.dp)) {
                    Icon(
                        if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                        contentDescription = if (expanded) "收起" else "展开",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (expanded) {
                SelectionContainer {
                    Text(
                        text.trim('\n'),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/** 思考中（流式）：回合进行中的实时思考块，默认展开、限高滚动、随文本增长自动滚到底 */
@Composable
fun LiveReasoningBlock(text: String) {
    val scroll = rememberScrollState()
    LaunchedEffect(text.length) {
        if (scroll.maxValue > 0) scroll.animateScrollTo(scroll.maxValue)
    }
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(
                    Icons.Filled.Psychology,
                    contentDescription = null,
                    modifier = Modifier.width(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    "思考中…",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    "⟳",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            SelectionContainer {
                Text(
                    text.trim('\n'),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .heightIn(max = 220.dp)
                        .verticalScroll(scroll)
                        .padding(top = 4.dp),
                )
            }
        }
    }
}

private fun toolStatusOk(status: String?) = when (status) {
    "completed" -> true
    "error", "failed" -> false
    else -> null // pending/unknown
}

/** 待办清单（流式）：回合进行中随 TodoWrite 实时更新的清单卡 */
@Composable
fun LiveTodoCard(todos: List<TodoItemDto>) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(
                    Icons.Filled.Check,
                    contentDescription = null,
                    modifier = Modifier.width(16.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    "待办清单（实时）",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(4.dp))
            todos.forEach { t ->
                val done = t.status == "completed"
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(vertical = 2.dp),
                ) {
                    Text(
                        if (done) "✓" else "○",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (done) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        t.content,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                        textDecoration = if (done) TextDecoration.LineThrough else TextDecoration.None,
                    )
                }
            }
        }
    }
}

/** 工具调用块：名称 + 状态 + 入参摘要 */
@Composable
fun ToolBlock(block: BlockDto) {
    val ok = toolStatusOk(block.status)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .background(
                MaterialTheme.colorScheme.surfaceContainer.copy(alpha = 0.6f),
                RoundedCornerShape(6.dp),
            )
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Icon(
            Icons.Filled.Build,
            contentDescription = null,
            modifier = Modifier.width(14.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(6.dp))
        Text(
            block.tool ?: "工具",
            style = MaterialTheme.typography.labelMedium,
            fontFamily = FontFamily.Monospace,
        )
        Spacer(Modifier.width(8.dp))
        when (ok) {
            true -> Icon(Icons.Filled.Check, contentDescription = "完成", tint = MaterialTheme.colorScheme.secondary, modifier = Modifier.width(14.dp))
            false -> Icon(Icons.Filled.Close, contentDescription = "失败", tint = MaterialTheme.colorScheme.error, modifier = Modifier.width(14.dp))
            null -> Text("…", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        block.inputPreview?.takeIf { it.isNotBlank() }?.let { preview ->
            Spacer(Modifier.width(8.dp))
            Text(
                preview.split('\n').first(),
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
    }
}
