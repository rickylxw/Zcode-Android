# App-Server 协议逆向 · 工作进度文档

> 更新日期：2026-09-22
> 目标版本：ZCode CLI / 桌面端 0.16.9（`E:/Program Files/ZCode/resources/glm/zcode.cjs`）
> 状态：**协议验证完成；集成已完成（bridge 0.3.0 默认 app-server 引擎，全部冒烟通过）**
> 相关脚本：`bridge/test/appserver-probe.mjs`（协议探测）、`bridge/test/appserver-engine-test.mjs`（引擎直测）、`bridge/test/ws-test.mjs`（端到端）、`bridge/test/bridge-stop-queue-test.mjs`（stop/崩溃自愈/队列）、`bridge/test/appserver-flow.mjs`（旧，部分结论已过时）

---

## 1. 为什么要逆向 App-Server

当前桥接服务（bridge/）采用「无头 CLI + SQLite + 日志 tail」架构，有三个靠它无法根治的短板：

| 短板 | 现状 | App-Server 能带来的 |
|---|---|---|
| 流式粒度粗 | 依赖 SQLite 落库粒度，只能块级推送，非字符级 | `session/update` 等事件原生字符级流式 |
| 电脑端发起的任务手机上看不到实时进度 | 桌面运行时不向外部进程暴露流 | 与桌面端同一个运行时，事件天然共享 |
| 会话互斥缺失 | 手机发起回合后，电脑端仍可对同一会话发送，存在同步问题 | 同一运行时内回合状态天然互斥 |

结论：要彻底解决这三件事，必须让 bridge 从「旁路读库」升级为「接入 App-Server」。

## 2. 架构对比

```
当前（已上线）：
手机 App ──REST/WS──> bridge ──spawn 无头 CLI（-p --resume --json）──> 独立运行时
                         └──只读 SQLite / tail 日志──> 桌面端 ZCode（另一个运行时）

目标（逆向后）：
手机 App ──REST/WS──> bridge ──JSON-RPC(stdio)──> app-server（与桌面端同源运行时）
                                                    ↑ 桌面端 UI 也连它
```

已确认的事实：**手机端无头 CLI 与电脑端桌面客户端走的是两个不同运行时**（这就是同步问题的根源）。官方网页端（🌐 远程控制）底层连的正是 App-Server。

## 3. 逆向方法与素材

1. **直接起进程观测**：`ELECTRON_RUN_AS_NODE=1` + Electron 的 node 跑 `zcode.cjs app-server`，stdin/stdout 全程抓包（`appserver-flow.mjs`）。
2. **产物 grep**：解包桌面端 main bundle，按关键词（`remote/v4`、`webRemoteControl`、`external-relay`、`deviceSid`、`pass_hash`）统计命中（`grep-remote.mjs`），定位远程控制中继协议位置。
3. **参考项目**：`windviki/zcode-webui`（第三方 WebUI，实现了 App-Server 客户端）、`zai-org/ZCode` 官方仓库。结论是**不引入它们作为依赖，只从本项目环境里提取需要的协议格式**（已按此执行）。

## 4. 已确认的协议事实（0.16.9，probe 实测 + 服务端 bundle 静态提取）

### 4.1 传输与握手

- **传输**：换行分隔的 JSON-RPC 风格消息，走 stdin/stdout；`zcode.cjs app-server` 裸跑即可（`ELECTRON_RUN_AS_NODE=1` + 普通 node 均可）。宿主层另有「`app-server --stdio` + `zcode-hello` JSON 握手 + 13 字节二进制帧」的组合（windviki/zcode-webui 的用法，见 `bridge/vendor/frame.mjs`），bridge 走 JSONL 即可，不需要那套。
- **协议标识**：create/resume 返回 `protocol: {name:"ZCode Protocol", version:1}`。
- **双向请求**：server→client 有带 `id`+`method` 的请求，**必须应答**，否则该次调用挂起。已确认两类：
  - `session/requestRuntimePreferences`，params `{sessionId, scope}`，scope 枚举 `runtime-materialization | user-execution`（create 时问一次、首个回合执行前再问一次，应答格式相同）。
    **应答是严格 schema（asar 内 BH 定义），多一个键都会 ZodError**：
    `{ nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: "preflight-v1" }`
    ⚠️ **修正旧结论**：应答**不收** providerId/modelId/mode/reasoningLevel；三个布尔也**不属于 session/create**。旧版"死循环"的根因就是应答 schema 不符被拒 → server 反复重问。
  - `interaction/requestOfficialMcpAuthHeaders`（官方插件 MCP 鉴权头询问）：回 `{}` 即可，不影响流程。
  - `interaction/requestPermission`（工具审批）。params：`{sessionId, requestId, toolCallId, toolName, riskLevel, reason, input, options[]}`，options 每项含 `optionId`（allow_once/allow_project/deny）和预构造的 `response`。
    **应答 = 回显所选 option 的 response 对象**（如 allow_once 即 `{decision:"allow", reason:"Approved once"}`）。
    实测：应答 `{allowed:true}` 会被判 `Permission request failed` 降级为 deny（不会挂起）；正确应答后工具真实执行。
  - `interaction/requestUserInput`（AskUserQuestion）。params 含 `questions[]`（options 带 value）。
    **应答 schema（服务端 rYe，严格）**：`{action:"accept"|"decline"|"cancel", content?, reason?}`。
    实测选选项发 `content:{answer:"<选项值>"}` → 服务端回 `permission.resolved` + `decision:"modify"` + `modifiedInput.answers`，模型正常拿到用户选择。
- **`--stdio` 变体与 bridge 无关**：`zcode.cjs app-server --stdio` 启动后 stdout 无任何输出（宿主服务专用，等二进制帧握手）；bridge 只用裸 `app-server` JSONL。
- **模型选择**：走 `session/setModel {sessionId, model:{providerId, modelId, options:{reasoningLevel}}}`，实测接受。

### 4.2 会话方法（wire 实测）

| 方法 | 参数（实测） | 返回要点 |
|---|---|---|
| `session/create` | `{workspace:{workspaceKey, workspacePath}}`（严格模式，别多给） | `session.sessionId/traceId/mode(默认 build)/status`、`settings.model.available[]`（模型目录含 reasoning levels）、`projection`、`runtime.eventSeq` |
| `session/resume` | `{sessionId, workspace:{...}}` | 同 create + 全量历史 `messages[]`（info+parts 结构）；workspace 不匹配报 `session_not_found_or_workspace_mismatch` |
| `session/send` | `{sessionId, content}`（严格；**mode 不在此参数里**） | `{accepted:true, stateRevision}`；回合进行中再发 → `-32010 "A prompt is already running for this session"` |
| `session/subscribe` | `{sessionId, deliveryKind:"desktop-continuous"\|"web-remote-replayable"}` | `{eventSeq, events[]}`——**事件必须订阅后才投递**；eventSeq 是断点续传水位 |
| `session/stop` | `{sessionId}` | `{}`；生效时回合以 `turn.completed` + `resultType:"cancelled"` 收尾（不是独立事件） |
| `session/messages` | `{sessionId, afterMessageId?, limit}` | `messages[]`，可完全替代 SQLite 读历史 |
| `session/events` | `{sessionId, afterSeq?, limit}` | `events[]`，掉线补拉用 |
| `session/list` | `{}` | 全部会话（与桌面端同一存储，含桌面正开的会话） |
| `session/setMode` / `setThoughtLevel` | `{sessionId, mode \| ...}` | 全量状态 |
| `session/read` / `usage` / `debug` / `subagents` / `fork` / `compact` / `goal` / `close` / `cancelBackgroundTask` | 未逐一展开 | 已验：read=全量状态；usage=token 统计；close=`{closed:true}` |
| `runtime/capabilities` | `{}` | `{independentPlanState:true}` |

另存在 workspace/*、workflows/*、usage/stats、skills/* 等命名空间（桌面端 UI 用，bridge 暂不需要）。

### 4.3 事件（`session/event` 通知）

信封：`{type, seq, eventId, sessionId, turnId, traceId, timestamp, deliveryKind, payload}`

**类型全集（服务端 bundle 枚举提取）**：
`session.created / session.resumed / session.updated / session.titleUpdated / session.closed / turn.started / turn.steerQueued / turn.steerDrained / turn.completed / turn.failed / message.upserted / message.removed / part.started / part.delta / part.upserted / part.removed / model.streaming / tool.updated / permission.requested / permission.resolved / userInput.requested / userInput.resolved / checkpoint.created / rewind.triggered / streamRecovery.updated`

实测样本（完整 payload 见 `bridge/test/out/probe-*.jsonl`）：
- `turn.started`：`{input, messageId, executionStartedAt, turnNumber, foregroundExecutionId, queryId}`
- `model.streaming`：`{assistantMessageId, delta, done, kind:"text_delta"|"reasoning_delta"}` ← **字符级流，桥接手机端的关键**
- `session.updated`：`{messageCount, providerId, modelId, toolCount, iteration}`
- `turn.completed`：`{response(全文), usage{inputTokens,outputTokens,cacheReadTokens,…}, toolCallCount, duration, resultType:"success"|"cancelled"|…, cacheStats}`
- **中止语义**：`session/stop` 生效后收到 `turn.completed` + `resultType:"cancelled"`（response 为空），伴随 `state.updated reason:"prompt_failed"`——**没有独立的 turn.aborted 事件**
- 状态旁路：`state.updated` 通知 `{patch, reason, revision, scope}`，reason 如 `prompt_started/prompt_failed`，patch 携带 `status: running/idle`（发送窗口判断）
- `permission.requested` / `permission.resolved`：requested payload = `{requestId, toolCallId, toolName, riskLevel, reason, input, options[], suggestedPermissionUpdates, fullAccessSupported}`；resolved 的 `decision` ∈ `allow / deny / modify`（modify = AskUserQuestion 应答被注入为 `modifiedInput.answers`）
- 实测另观察到：`tool.updated`（kind:"scheduled"/"batch"，工具调度与结果批次）、`checkpoint.created`（工具执行后自动 checkpoint）、`streamRecovery.updated`

### 4.4 队列/插话（重要定论）

**wire 层不支持 steer/queue**：`session/send` 严格只收 `{sessionId, content}`（实测 `delivery`、`requestedDelivery` 均 Unrecognized key 被拒）；宿主层的 `requestedDelivery: startNow|queue|guide` 队列体系没有暴露到 app-server wire。回合中发送直接 `-32010`。
结论：bridge 自建队列（`bqueue.js`）保持现状——收到 `turn.completed(resultType:"success")` 且 status=idle 后才发下一条。

## 5. 实验时间线

| 阶段 | 内容 | 结果 |
|---|---|---|
| 1 | 确认手机端/电脑端后台关系 | 确认是两个独立运行时；无头 CLI 同样走智谱后端 |
| 2 | 评估 zcode-webui / 官方仓库可否复用 | 可作协议参考，不作依赖；改为从本项目环境提取协议 |
| 3 | 起进程抓 stdio 协议 | 握手、双向请求模型、startup 消息确认 |
| 4 | `session/create` 死循环排查 | 定位根因为缺失三个布尔字段；补齐后建会话成功 |
| 5 | 应答 runtimePreferences + `session/send` | 回合可跑通，事件可分类收集 |
| 6 | 同步实验（向桌面正开会话发消息，`sync-exp.mjs`） | 证实旁路写入与桌面运行时不互通，坐实互斥需求 |
| 7 | 互斥锁方案讨论 | 决定：先用 logtail 检测 `turn_started` → 中止手机无头进程的轻量方案进 ToDo；App-Server 完整集成暂缓 |
| 8 | 静态提取：解包 grep app.asar（桌面渲染端自带一份完整协议客户端）+ zcode.cjs（服务端 zod schema） | 一次性拿到方法全集、事件 24 类枚举、requestRuntimePreferences 应答 schema（BH）、事件信封结构 |
| 9 | `appserver-probe.mjs` 三模式实测（discover 免费 / attach 免费 / turn 小额） | create/resume/send/subscribe/setModel/stop 全通；死循环根因修正（应答 schema 不符）；stop 语义确认（resultType:"cancelled"）；steer 线上不支持定论 |
| 10 | 补漏实验：`--stdio` 变体、对桌面**正在运行**的会话只读并发接入、permission/userInput 应答实测（probe 增 perm/ask 模式） | `--stdio` 定论（宿主专用无输出）；co-attach busy 会话被接受（共享可见性成立）；审批与提问应答格式全打通（工具真实执行、模型真实拿到选项） |

## 6. 尚未确认 / 待完成

- [x] 流式事件完整 schema —— 4.3 已归档（`part.delta` / `tool.updated` / `permission.*` / `userInput.*` 的 payload 细节待工具调用与审批场景触发后补充）
- [x] **接入既有会话** —— `session/resume` 验证通过（584 条历史消息、模型选择自动还原、workspace 校验生效）
- [x] 中止回合的协议 —— `session/stop`；识别 `turn.completed` + `resultType:"cancelled"`
- [x] server→client 请求完整清单 —— `requestRuntimePreferences`（两 scope，BH 严格应答）+ `requestOfficialMcpAuthHeaders`（回 `{}` 即可）；`permission.requested` / `userInput.requested` 的应答格式待审批场景验证（见下条）
- [x] 队列输入 —— 定论：wire 不支持，bridge 保留 `bqueue.js` 自建队列（见 4.4）
- [x] 长连接生命周期 —— subscribe 返回 eventSeq 水位 + `session/events {afterSeq}` 补拉；bridge 重启 = 重新 spawn app-server → resume → subscribe → 补拉缺口
- [x] **与桌面端同时连接同一会话（只读侧已验证）**：对桌面端**正在运行**的会话 `resume`+`subscribe` 被正常接受（eventSeq 水位返回、历史与进行中的消息实时可读，服务端无互斥拒绝）——"电脑端任务手机上看实时进度"在协议层成立。仅剩「第二客户端 `send` 到桌面正开会话」留集成期验证（会向用户桌面会话注入消息，需配合场景）。
- [x] `permission.requested` / `userInput.requested` 的应答格式 —— 均已实测打通（应答格式与端到端效果见 4.1/4.3）。

## 7. 落地改造计划（bridge 侧）——✅ 已完成（2026-09-22，bridge 0.3.0）

预估总工作量 **7–12 小时**（协议收尾 3–4h + bridge 重构 3–5h + 回归测试 2–3h）：

1. ✅ `bridge/src/appserver.js`（新增）：常驻 app-server 子进程管理（崩溃自动重启）、server→client 请求应答（runtimePreferences 三布尔 / permission 自动 allow_once / userInput 自动选第一项 / MCP auth headers 回空）、事件分发（LogTail 同款 `{kind, timestamp}` 形状，`model.streaming` 增量累积供流式快照）。
2. ✅ `bridge/src/zcode.js`（保留为回退）：`server.js` 加引擎门面（`startTurn`/`jobById`/`stopById`），默认 `appserver`，`bridge.config.json` 加 `"engine": "headless"` 或 `BRIDGE_ENGINE=headless` 切回无头。
3. ✅ `bridge/src/store.js`（保留）：列表/历史仍走 SQLite（app-server 与桌面端同库，数据一致）；`syncTasksIndex` 照常工作。
4. ✅ 队列（`bqueue.js`）**保留**：wire 不支持 steer/queue，发送窗口 = `turn.completed(resultType:"success")` 后自动投递（复用原有 tryDeliverQueued）。
5. ✅ 事件映射：`turn.started→turn_started`、`tool.updated(scheduled/batch)→tool_started/tool_completed`、`turn.completed→turn_completed`；`model.streaming` 增量不映射进度事件（防刷屏），走 stream 快照通道（泵优先取协议累积文本，回退 SQLite）。
6. ✅ App 端零改动（事件格式不变）。

### 集成冒烟结果（8799 端口冒烟实例）

| 项 | 结果 |
|---|---|
| WS 新会话回合（含 Write/Read 工具、审批自动放行） | **PASS**（17 条 progress 事件，响应/usage 正确） |
| WS resume 续接 | **PASS** |
| stop 中止 | **PASS**（客户端收到 CANCELLED 错误"回合已停止"） |
| 杀 app-server 子进程后自愈 | **PASS**（下一回合自动重启进程） |
| 队列自动投递 | **PASS**（回合结束后 3s 内投递完成） |

### 已知边界

- **被强杀弄脏的会话**：测试期间反复强杀进程后，某个会话 resume 后事件流异常（turn 静默）。桌面端正常使用不会触发；遇到时在桌面端关开该会话或新建会话即可。引擎对 send 被拒（-32010）已有 BUSY 错误兜底。
- 审批/提问在手机端暂无 UI，当前策略是自动放行/自动选第一项（与无头 yolo 行为一致）；事件流中 `permission.*` / `userInput.*` 照常推送，后续做手机端审批 UI 时直接消费这些事件即可。

## 7.5 跨运行时互斥（桌面优先）——✅ 已实现并验证（2026-09-22）

**前提结论**：桌面端运行时内嵌在 Electron 主进程里（进程树无运行时子进程、26 个 ZCode 进程零监听端口），外部没有任何附着通道——字面意义的"同一运行时实例"在现版桌面端上不可达（官方 `desktop-attached-remote`/service-port 那套只适用于独立 host 服务 zcode-server.cjs 部署）。因此互斥做在**跨运行时协调**层，信号取自双方都写的共享日志：

- **自己人识别**：bridge 订阅的 `session/event` 信封带 `turnId`，记入活跃回合的 `wireTurnIds`；
- **外来者识别**：LogTail（所有运行时共用一份日志）的 `turn.started` 也带 `turnId`；有活跃本方回合时，日志 turnId 不在 `wireTurnIds` 里 = 桌面端（或其他运行时）开始驱动该会话；
- **桌面优先让位**：识别为外来回合 → bridge 自动 `session/stop` 本方回合，手机端收到 `code:"YIELDED"`、文案"电脑端已在该会话开始执行，本任务已自动中止让位"；
- **发送前门禁**：会话在共享日志意义下正在执行、且本桥接无活跃任务时，手机 prompt 直接拒 `BUSY`："电脑端正在该会话中执行任务，已拒绝同时执行。可稍后再试，或先把消息放入队列。"

**验证**（`bridge/test/mutex-test.mjs`，外来运行时 = 独立 spawn 的 app-server，与桌面端同构）：
- 场景 A：外来回合运行中，手机 prompt 被门禁拦截 → **PASS**（外来回合正常完成）
- 场景 B：手机回合进行中，外来回合开始 → 手机自动让位（YIELDED），外来回合不受影响 → **PASS**（yield-check 插桩确认自识别/外识别/中止三步全部正确）

**残留竞态（可接受）**：两端几乎同时发起（秒级窗口）时，双方运行时各自都会接受（各自视角空闲），后写入方由让位机制裁决；让位检测依赖共享日志（≤500ms tick）+ 外来回合的 turn.completed 需对方进程存活才能落日志（进程被杀则运行标记由 8 分钟 reaper 兜底回收）。

## 7.6 两端同步修复（手动刷新问题）——✅ 已实现并验证（2026-09-22）

**症状**：桌面端发起的回合，手机端看完进度步骤后消息不自动出现，需要手动刷新。

**根因**：手机端只在收到 `SessionUpdated`（→load()）或 `TurnResult`（发起者）时才拉取消息，而 bridge 只在「bridge 自己发起的回合结束」时广播 `session_updated`；桌面端/CLI 发起的回合走 LogTail 路径，开始/结束都**不广播**——手机端永远不知道该刷新。另外流式泵只挂在 bridge job 上，桌面回合没有流式文本。

**修复**（bridge/src/server.js + App ChatViewModel）：
1. LogTail 与 app-server 两条事件路的 `turn_started` / `turn_completed` 现在都广播 `session_updated`（+ mini 看板 broadcastStatus）——任何端发起的回合，手机端会话列表运行标记与聊天页都会自动进入运行态/拉取最终消息。
2. **被动流式泵**：会话被手机订阅且处于运行中、但没有 bridge job 时（= 桌面端/CLI 回合），每秒从共享 SQLite 取助手消息快照推 `stream` 帧，回合结束 1.5s 后补发收尾帧；中途订阅（subscribeSession）与订阅者全部离开时自动起停。
3. bridge job 泵的推送面加入同会话订阅者（第二台设备看同一回合也有流）。
4. App 端 ChatViewModel：收到 `turn_completed` 进度时主动 `load()`（防御性双保险，下次打包生效）。

**验证**（`bridge/test/sync-test.mjs`，外来运行时模拟桌面端，WS 客户端扮演手机）：
session_updated ×2（开始+结束）、progress 全集（turn_started/model_request/turn_completed）、stream 3 帧、最终消息含新内容 → **PASS：桌面端回合全程自动同步到手机端**。

**注意事项**：桌面端进程被强杀导致 `turn.completed` 不落日志时，结束广播缺失（8 分钟 reaper 只清运行标记）；正常使用不触发。

### 队列投递假死修复（2026-09-22）

**症状**：手机端待发送队列加入后永不投递（用户视角：功能从未工作过）。

**根因链**（三层叠加，逐层修复）：
1. **同步断点**（主因，最早期）：投递即使成功，结果也不刷新到聊天页（见 7.6）——用户永远看不到队列"工作"。
2. **看板改动的回归**：mini 看板把 `runningSessions` 从 Set 改为 Map（携带时间戳），但漏改队列投递 onJob 里的 `runningSessions.add(...)`——Map 无 `.add`，同步抛 TypeError；而此时回合对象已注册进 appserver 的 turns 表，异常跳过清理路径 → **回合对象永久泄漏** → 之后所有队列扫描被 `jobForSession` 门禁拦截 → 投递彻底假死且无任何日志。修复：改用 `markRunning()`，并全局 grep 确认无同类遗漏。
3. **幽灵标记与静默失败**：被强杀回合的残留运行标记会让扫描跳过（无日志）；投递失败放回队首也不留痕。修复：跳过/失败均落日志；停止接口对账清理后立即触发投递；入队即触发投递（不再等 30s tick）；call 超时即回收 app-server 子进程（协议失联自愈，僵尸实例不再无限阻塞）。

**验证**：生产实例（8787）真实投递——空闲会话入队 "Reply with exactly: QUEUE_FINAL_OK" → 一次扫描完成投递 → 回复出现在会话中、队列清空。

### mini 看板动态刷屏修复（2026-09-22）

「最近动态」同一工具连出三条：bridge 自己的回合，工具事件从协议（tool.updated）和共享日志（tool.call.completed）两条通道各送一份，且 batch 事件一次工具可发多条。修复：
1. 协议通道不再映射 `tool.updated`（appserver.js 的 appServerEventKind 移除）——工具/模型请求事件统一由共享日志单通道提供，手机端步骤与看板动态各自只收一份；
2. mini.html 最近动态聚合：同一会话同类事件 15 秒内重复合并为一行并显示 ×N 计数（真实的高频工具调用也不再刷屏）。

### 7.7 交互能力上手机：权限审批与 AskUserQuestion —— ✅ 已实现并验证（2026-09-22，0.4.19）

此前手机端的审批/提问策略是无脑自动放行/自动选第一项。现改为**真实交互**：

- **bridge**（appserver.js）：`interaction/requestPermission` 与 `interaction/requestUserInput` 不再立即自动应答，而是经 `setInteractionHandler` 转发给订阅该会话的手机端（新 WS 消息 `{type:'request', requestId, kind, toolName, riskLevel, reason, input, options, questions}`），挂起等待 `{type:'respond', requestId, response}`；**120 秒超时或无人观看时回退默认策略**（放行单次/采纳第一项）。
- **App**（BridgeSocket + ChatViewModel + ChatScreen）：新增 `request` 消息解析与 `Event.InteractionRequest`；聊天页弹出审批对话框——权限请求展示工具名/风险等级/原因/入参并按 option 生成按钮（回显 `option.response` 应答），提问展示问题与选项（应答 `{action:'accept', content:{answer:值}}`），另有"稍后再说"（超时走默认策略）。
- **验证**（`bridge/test/approval-test.mjs`）：build 模式发起写文件任务 → 桥接转发权限请求 → 应答 allow_once → 工具真实执行 → 回合完成 → **PASS**。
- 至此桌面端的工具审批与提问交互在手机端补齐；yolo 模式服务端不发起审批，行为不变。

### 运行标记幽灵修复（2026-09-22）

看板「运行中的任务」出现早已结束却停不掉的任务：根因是测试/被强杀的进程来不及把 `turn.completed` 落入共享日志，启动回放（initialRunningSet）按「有 started 无 completed」把它们误判为运行中（旧窗口宽至 12 小时）。修复：
1. 启动回放只认**最近 30 分钟**静默的未完成回合（回合进行中必然持续产生事件，30 分钟静默只可能是幽灵）；
2. `/api/sessions/:id/stop` 在无本方任务但运行标记残留时，就地**对账清理**标记并广播（返回 `reconciled:true`），看板「停止」按钮此时起对账作用，不再报"停止失败"。

## 8. 风险与注意事项

- **协议随版本漂移**：App-Server 无公开文档，0.16.9 的结论在后续版本可能失效；`session/create` 三个布尔字段这类隐性约束只能靠实测发现，升级 CLI 后需重跑 `appserver-flow.mjs` 回归。
- **bridge.config.json 含 token、不可提交**；实验脚本同样不要写死任何敏感信息。
- 数据库只读红线不变：即使接入 App-Server，bridge 对 `db.sqlite` 也只读（模型选择改走协议而非直写 `session_entry`）。
- 长驻 app-server 进程是单点：崩溃后 bridge 需自动重启它并重放订阅，这点在改造 zcode.js 时必须一并设计。

## 9. 决策记录

- **暂缓完整集成**：当前「无头 CLI + SQLite + 日志 tail」架构已覆盖核心场景且稳定上线（v0.4.17），App-Server 改造收益主要是流式粒度与互斥的彻底解，投入 7–12h，排期待定。
- **互斥锁先行**：用户已确认以轻量方案（桌面回合优先，中止手机无头进程）进 ToDo，不等 App-Server。
- **不引入第三方 WebUI 依赖**：协议格式只从本机 ZCode 安装里提取。
- **协议验证完成（2026-09-22）**：`appserver-probe.mjs` 为回归入口——升级 CLI 后先跑 `discover`（免费）再跑 `attach`/`turn`；所有参数 schema 都是 zod `.strict()`，版本漂移会直接以 `Unrecognized keys` 报错暴露，probe 一跑便知。
- **集成完成（2026-09-22）**：bridge 0.3.0 默认 app-server 引擎，全部冒烟通过；生产实例（8787）下次重启自动生效，如遇问题用 `"engine": "headless"` 一键回退。
- **旧结论修正备案**：「create 缺三个布尔导致死循环」不准确——三个布尔属于 `requestRuntimePreferences` 的**应答**（严格 schema），create 本身只收 workspace；应答被 Zod 拒绝才是 server 反复重问的根因。
