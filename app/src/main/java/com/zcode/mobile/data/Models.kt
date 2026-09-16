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
data class MessageDto(
    val id: String,
    val role: String,
    val timeCreated: Long? = null,
    val blocks: List<BlockDto> = emptyList(),
)

@Serializable
data class SessionDetailDto(
    val session: SessionDto,
    val running: Boolean = false,
    val messages: List<MessageDto> = emptyList(),
)

@Serializable
data class PingDto(val ok: Boolean = false, val bridge: String = "", val projects: Int = 0)

@Serializable
data class ProjectsResp(val projects: List<ProjectDto> = emptyList())

@Serializable
data class SessionsResp(val sessions: List<SessionDto> = emptyList())

/** 进度事件（来自桥接对 ZCode 运行日志的 tail） */
data class ProgressEvent(
    val sessionId: String,
    val jobId: String?,
    val kind: String,
    val toolName: String? = null,
    val durationMs: Long? = null,
)
