# App-Server 协议逆向 · 工作进度文档

> 更新日期：2026-09-20
> 目标版本：ZCode CLI / 桌面端 0.16.9（`E:/Program Files/ZCode/resources/glm/zcode.cjs`）
> 状态：**部分打通（握手 + 建会话 + 发消息可跑通），完整集成暂缓**
> 相关实验脚本：`bridge/test/appserver-flow.mjs`、`bridge/test/sync-exp.mjs`、`bridge/test/grep-remote.mjs`

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

## 4. 已确认的协议事实

- **传输**：换行分隔的 JSON-RPC 风格消息，走 stdin/stdout（stdio pipe 即可，无需额外端口）。
- **双向请求**：不只是 client→server；server 也会向 client 发带 `id`+`method` 的请求，**必须应答**，否则流程卡死。
- **启动握手**：进程起来后先收到一批 `startup/*` 消息（等约 5s 完成）。
- `session/create`
  - 参数：`workspace: { workspaceKey, workspacePath }`
  - **坑（已定位）**：只传 workspace 会让 server 反复发 `session/requestRuntimePreferences` 死循环。根因是 `session/create` 还需要布尔字段 `nativeSearchEnhancementsEnabled`、`memoryEnabled`、`askUserQuestionAutoResolutionEnabled`，缺失时 server 不停重试询问运行时偏好。
- `session/requestRuntimePreferences`（server→client 请求）
  - 每个会话会问一次；应答格式：`{ providerId, modelId, mode, reasoningLevel }`
  - 实测应答 `bigmodel-api-2 / GLM-5.3 / yolo / max` 可被接受。**这一步等价于 bridge 现有 selection.js 的模型自愈逻辑**——App-Server 原生管理模型选择，接入后可替代手写 `session_entry` 读写。
- `session/send`
  - 参数：`{ sessionId, text, mode }`，发送后开始产出流式事件。
- **事件流**：`session/send` 之后 server 持续推送带 `method` 的通知消息（流式增量、工具调用等）；`appserver-flow.mjs` 已能按 method 分类统计，但**各类事件的完整 payload 结构尚未逐一归档**。

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

## 6. 尚未确认 / 待完成

- [ ] 流式事件完整 schema（text delta、tool_call、thinking、usage 等逐类归档 payload）
- [ ] **接入既有会话**：目前只验证了 `session/create` 新建；`--resume` 等价的「attach 已有 sessionId」的协议入口未验证
- [ ] 中止回合的协议（对应现有 `session/stop` 能力）
- [ ] server→client 请求的完整清单（除 `requestRuntimePreferences` 外还有哪些必须应答）
- [ ] 队列输入（`session_input` 的 queue 语义）在协议层的对应物
- [ ] 长连接生命周期：bridge 重启后如何恢复订阅、错误码语义
- [ ] 与桌面端同时连接同一会话时的行为（正是互斥问题的关键场景，需专项实验）

## 7. 落地改造计划（bridge 侧）

预估总工作量 **7–12 小时**（协议收尾 3–4h + bridge 重构 3–5h + 回归测试 2–3h）：

1. `bridge/src/appserver.js`（新增）：常驻 app-server 子进程管理、请求应答路由、事件分发；runtimePreferences 应答直接复用 selection.js 的模型解析。
2. `bridge/src/zcode.js`（改造）：`runTurn` 从 spawn 无头 CLI 切换为 app-server `session/send`；无头模式保留为回退路径。
3. `bridge/src/store.js`（保留）：SQLite 读取继续作为列表/历史的兜底数据源，app-server 只接管「进行中的回合」。
4. 会话互斥：接入 app-server 后天然获得；在过渡期先上轻量方案（logtail 检测到该会话的 `turn_started` 且存在手机发起的无头任务 → abort 无头进程，电脑端优先）。
5. App 端：基本无改动（事件经 bridge WS 透传后格式不变，仅流式粒度变细）。

## 8. 风险与注意事项

- **协议随版本漂移**：App-Server 无公开文档，0.16.9 的结论在后续版本可能失效；`session/create` 三个布尔字段这类隐性约束只能靠实测发现，升级 CLI 后需重跑 `appserver-flow.mjs` 回归。
- **bridge.config.json 含 token、不可提交**；实验脚本同样不要写死任何敏感信息。
- 数据库只读红线不变：即使接入 App-Server，bridge 对 `db.sqlite` 也只读（模型选择改走协议而非直写 `session_entry`）。
- 长驻 app-server 进程是单点：崩溃后 bridge 需自动重启它并重放订阅，这点在改造 zcode.js 时必须一并设计。

## 9. 决策记录

- **暂缓完整集成**：当前「无头 CLI + SQLite + 日志 tail」架构已覆盖核心场景且稳定上线（v0.4.17），App-Server 改造收益主要是流式粒度与互斥的彻底解，投入 7–12h，排期待定。
- **互斥锁先行**：用户已确认以轻量方案（桌面回合优先，中止手机无头进程）进 ToDo，不等 App-Server。
- **不引入第三方 WebUI 依赖**：协议格式只从本机 ZCode 安装里提取。
