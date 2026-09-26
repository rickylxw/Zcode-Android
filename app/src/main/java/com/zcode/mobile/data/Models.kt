package com.zcode.mobile.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ProjectDto(
    val directory: String,
    val sessionCount: Int = 0,
    val lastActive: Long = 0,
)

@Serializable
data class SessionDto(
    val id: String,
    val title: String = "",
    val directory: String = "",
    val parentId: String? = null,
    val additions: Long? = null,
    val deletions: Long? = null,
    val files: Long? = null,
    val timeCreated: Long = 0,
    val timeUpdated: Long = 0,
    val running: Boolean = false,
    val archived: Boolean = false,
    val archivedAt: Long? = null,
    val queuedCount: Int = 0,
)

/** 待发送指令：source='phone' 可在手机管理；source='desktop' 来自电脑端（只读） */
@Serializable
data class QueuedInputDto(
    val id: String = "",
    val kind: String = "sendText",
    val text: String = "",
    val source: String = "desktop",
)

@Serializable
data class BlockDto(
    val type: String,
    val text: String? = null,
    val tool: String? = null,
    val status: String? = null,
    val inputPreview: String? = null,
)

@Serializable
data class TodoItemDto(
    val content: String,
    val status: String = "pending",
)

@Serializable
data class SettingsDto(
    // 审批超时策略：allow = 审批 120 秒未应答自动放行；deny = 自动拒绝/不答
    val approvalTimeoutPolicy: String = "allow",
)

@Serializable
data class MessageDto(
    val id: String,
    val role: String,
    // 消息语义（bridge 提供）：user_prompt=真实用户输入，todo_reminder=待办提醒，
    // background_notification=后台任务通知；null 为旧版 bridge 或非 user 消息
    val semantic: String? = null,
    val timeCreated: Long? = null,
    val blocks: List<BlockDto> = emptyList(),
)

@Serializable
data class SessionDetailDto(
    val session: SessionDto,
    val running: Boolean = false,
    val queued: List<QueuedInputDto> = emptyList(),
    val messages: List<MessageDto> = emptyList(),
)

@Serializable
data class PingDto(val ok: Boolean = false, val bridge: String = "", val projects: Int = 0)

@Serializable
data class ProjectsResp(val projects: List<ProjectDto> = emptyList())

@Serializable
data class SessionsResp(val sessions: List<SessionDto> = emptyList())

@Serializable
data class ModelListDto(val provider: String = "", val models: List<String> = emptyList())

@Serializable
data class UsageBucket(
    val turns: Int = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val reasoningTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    val totalTokens: Long = 0,
    val durationMs: Long = 0,
)

@Serializable
data class UsageDay(
    val date: String = "",
    val turns: Int = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val totalTokens: Long = 0,
)

@Serializable
data class UsageResp(val summary: UsageSummaryDto = UsageSummaryDto(), val daily: List<UsageDay> = emptyList())

@Serializable
data class UsageSummaryDto(
    val today: UsageBucket = UsageBucket(),
    val last7Days: UsageBucket = UsageBucket(),
    val allTime: UsageBucket = UsageBucket(),
)

/** 进度事件（来自桥接对 ZCode 运行日志的 tail） */
data class ProgressEvent(
    val sessionId: String,
    val jobId: String?,
    val kind: String,
    val toolName: String? = null,
    val durationMs: Long? = null,
)
