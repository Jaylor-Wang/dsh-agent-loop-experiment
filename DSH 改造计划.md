# DSH 改造计划：从软提示到可控收敛循环

## 1. 目标与结论

本计划针对当前 DSH 在复杂任务中模型轮次多、重复补读、整文件重写、失败后重新生成大段内容的问题，目标是：

1. 减少无进展的模型请求，而不是简单限制总步数。
2. 把必须遵守的工具规则从系统提示提升为工具执行前的运行时判定。
3. 失败恢复只复用已经存在的安全 payload，不让模型重新生成同一份大内容。
4. 兼容代码修改、SVG/HTML 生成、数据处理、文档编辑、只读问答和子任务等场景。
5. 第一阶段不修改官方 agent-loop 核心，不改变默认行为；只有公开 hook 无法满足需求时才进入核心分支。

核心判断：模型能力不足和全局规则遵守率低确实存在，但当前 DSH 更大的问题是规则停留在提示词层。当前实验插件只在 `agent/pre-step` 追加一次软提醒，不能判断模型是否取得进展，也不能阻止不合适的工具副作用。需要借鉴 OMP 的三项机制：有限状态、有限恢复、工具执行前校验。

## 2. 当前基线与不可破坏约束

### 2.1 当前实现

实验入口位于 `src/index.js`，通过公开插件 hook 挂载收敛策略，并挂载官方循环。官方循环副本位于 `lib/index.js`，当前 SHA-256 为：

```text
a6fa8e0c7c90191caf5f4a3bb5c624a86e9845cf3c79d020b71420d0e20ae4c1
```

当前策略主要位于：

- `src/convergence.js`：系统指导、软步骤预算、提醒注入。
- `src/failure-recovery.js`：大段 write 参数错误的逐字 payload 恢复。
- `src/replacement.js`：官方循环替换入口，目前不是默认独立入口。
- `test/convergence.test.js`：策略接线、预算、前缀、取消、并发、作用域等测试。
- `test/failure-recovery.test.js`：失败 write 恢复和工具流水线安全测试。
- `test/live-runner.test.js`：真实适配器和 loopback SSE 验证。

### 2.2 必须保持的行为

- 默认 `enabled: false` 时，模型请求、工具调用和请求消息必须与官方基线一致。
- 官方 `lib/index.js` 在插件层改造阶段保持字节不变。
- 不自动修改、发布或覆盖宿主 DSH 安装目录。
- 不改变 provider、model、reasoningEffort、裁剪器和工具并发的默认语义。
- 不因达到软预算就自动宣布完成。
- 不把只读问答、代码 review、用户明确要求的完整替换误判为局部修改。
- 任何硬拦截都必须先有结构化错误结果、明确下一步和有限重试上限。
- 真实模型收益必须通过 A/B 任务验证，不能用固定脚本请求数作为性能结论。

## 3. OMP 借鉴范围

不移植 OMP 的完整 `agent-loop.ts`。它包含 Harmony、Cursor、provider stream、speculative execution 和 live steering 等 DSH 没有同构实现的兼容代码，整体移植会扩大风险。

只借鉴以下控制思想：

1. **分阶段处理模型输出**：模型请求准备、assistant 结果分类、工具执行前准备、工具批次提交、下一步判定分离。
2. **模型输出默认不可信**：工具名、参数、call id、结果状态必须经过运行时校验，不能只依赖提示词。
3. **软要求先提醒、失败后升级**：第一次保留 provider cache 和正常工具选择；仍不满足时再强制工具或拒绝绕路副作用。
4. **按异常类型独立计数**：pause、工具格式错误、DSML 泄漏、相同失败和无进展不能共用一个总计数器。
5. **所有恢复有上限**：达到上限后停止继续消耗模型轮次，并保留可诊断的状态和原因。
6. **工具结果顺序稳定**：允许安全工具并发，但历史提交和模型可见结果保持调用顺序。

OMP 对应证据：

- 有限恢复常量位于 `agent-loop.ts` 的 `MAX_PAUSED_TURN_CONTINUATIONS`、`MAX_DSML_LEAK_NUDGES` 和 `MAX_SOFT_TOOL_ESCALATIONS`。
- 软工具要求定义于 `types.ts` 的 `SoftToolRequirement`。
- 工具执行前准备集中处理 call id、intent、参数校验和 `beforeToolCall`。
- 工具结果在全部 settle 后按 assistant call 顺序提交。

## 4. 目标架构

新增一个通用的、与具体任务无关的策略内核，建议命名为 `src/runtime-policy.js`。它不直接生成大段提示词，只负责观察事件、建立状态、计算指纹、返回有限决策。

### 4.1 状态边界

状态按 `session -> agent -> turn -> step` 管理，使用 `WeakMap` 保存运行态，避免阻止 session 或 agent 回收：

```text
SessionState
  turn
  step
  phase: idle | requesting | tool_batch | waiting | stopping | ended
  toolCalls
  toolResults
  progressRecords
  recoveryRecords
  reminderKinds
  policyMode
```

生命周期：

- `turn/start`：创建或重置当前 turn 状态。
- `step/start`：创建本步记录，保存输入消息数量、工具结果数量和开始时间。
- `tools/pre-execute`：对工具调用进行分类和预执行判定。
- `tools/execute`：记录实际执行或被策略拒绝的调用。
- `tools/result`：保存结果状态、错误码、目标路径和进展判定。
- `turn/end`：清理短期恢复引用，输出本轮摘要。
- `working-directory/change`、工具注册变化或取消：使相关恢复引用失效。

不要把完整文件内容放进状态或日志。只保留大小、路径归一化结果、短 hash、错误码和调用 ID。

### 4.2 统一决策模型

内部决策统一为以下形式，具体 hook 只负责把它转换成 DSH 当前 hook 能接受的结果：

```js
{
  kind: 'allow' | 'observe' | 'remind' | 'deny' | 'recover' | 'stop',
  code: 'NO_PROGRESS' | 'LARGE_WRITE_EXISTING_FILE' | 'RETRYABLE_TOOL_FAILURE',
  reason: 'short human-readable explanation',
  retryable: boolean,
  retryLimit: number,
  nextAction: 'edit' | 'read' | 'retry_reference' | 'continue' | 'finish'
}
```

决策必须是纯判定结果。状态写入、消息注入、工具拒绝和恢复引用消费分别执行，避免 hook 重入或 admission 失败时状态提前提交。

## 5. 分阶段实施

## 阶段 0：建立真实基线，暂不改变行为

### 目标

确认问题到底来自模型生成时间、模型请求数量、工具耗时还是重复操作，避免只优化“步数”而牺牲完成质量。

### 工作项

1. 扩展现有 `scripts/live.mjs` 的聚合指标，增加：
   - model request count。
   - 每次请求流耗时和总模型耗时。
   - tool call count、failed tool count、repeated read count。
   - 大 write 次数、edit 次数、write/edit 字节量。
   - 相同错误指纹重复次数。
   - 提醒数、提前停止数、恢复引用数。
   - 任务质量、必需产物是否存在、验证是否通过。
2. 选取至少四类任务：
   - SVG/HTML 内容生成。
   - 已有代码的局部修改。
   - 数据或文档处理。
   - 只读检查或 review。
3. 每类任务使用相同模型、推理档位、工具和上下文，交替运行 baseline 与 convergence，至少各 3 次。
4. 记录当前鹈鹕任务作为专项样本，但不把 pelican、SVG 或某个文件名写入通用策略。

### 完成条件

- 能输出 baseline/convergence 的可比较 JSON。
- 质量检查失败时退出码为 1。
- 没有模型原文、凭据或完整文件内容落盘。
- 现有 `npm test` 仍全部通过。

## 阶段 1：只观测的运行时策略内核

### 目标

先知道模型做错了什么，再决定拦截什么。此阶段只记录分类和指标，不改变工具执行结果，不新增模型请求。

### 文件变更

新增：

- `src/runtime-policy.js`：状态、指纹、分类、统计。
- `test/runtime-policy.test.js`：状态边界和指纹测试。

修改：

- `src/convergence.js`：增加 `policy` 配置，并安装 runtime policy。
- `test/convergence.test.js`：验证 `observe` 模式不改变基线。
- `scripts/live.mjs`：输出策略统计。
- `EXPERIMENT.md`：记录观测字段和解释。

### 指纹规则

指纹必须稳定、短小、通用，不包含完整 payload：

```text
normalized tool name
+ operation class
+ normalized target path
+ error code/category
+ result status
+ content byte range
```

可使用 SHA-256 后取前 16 至 24 个 hex 字符。路径需要按工作目录归一化；绝对路径和相对路径指向同一目标时应得到相同 fingerprint。

以下情况算“有证据的进展”：

- 新目标路径或新文件进入上下文。
- 读到新版本或新的验证结果。
- 成功执行了目标写入或 edit。
- 生成器源文件发生变化后重新构建产物。
- 验证命令输出了新的通过结果。
- 工具失败原因发生变化且没有重复同一调用。

以下情况只算“重复活动”，不算进展：

- 相同路径的重复 read/grep，且文件版本没有变化。
- 相同参数和相同失败码的重复调用。
- 相同目标的整文件 write，内容 hash 不变。
- 已经有通过验证结果后再次运行同一验证，且没有新改动。
- 只改变解释文字，没有改变工具输入或工作状态。

### 完成条件

- observe 模式下请求数、工具调用和结果与基线一致。
- 同一指纹在同一 turn 内能被识别并计数。
- 新 turn、邻居 agent、卸载和取消不会串用状态。
- 日志只输出摘要，不输出完整 write/edit 内容。

## 阶段 2：有限恢复与无进展控制

### 目标

将“重复错误”变成一次受控恢复，将无进展循环在低成本位置结束。恢复不能依赖模型重新生成大 payload。

### 2.1 恢复记录

在现有 `src/failure-recovery.js` 的单一 write 恢复基础上抽象 `RecoveryRecord`：

```text
owner agent identity
root call id
original call id
canonical tool name
safe arguments or payload reference
argument hash
target path
turn and step
attempt count
created sequence
invalidated reason
```

安全要求：

- 记录只保存原始参数中经过 allowlist 的字段，或保存在受控内存引用中。
- 不把大内容复制到 user/message 或统计 JSON。
- 只允许 owner agent、同一 turn、同一 admitted tool definition 使用。
- 恢复调用消耗引用，最多一次。
- mutating tool、工作目录变化、工具定义变化、turn/end、cancel、unload 后立即失效。
- 恢复仍必须通过现有 `ToolExecutionPipeline`、权限、scope、取消和文件写入意图检查。

### 2.2 可恢复错误分类

默认只允许以下类别进入恢复候选：

1. 参数配对错误，原始参数本身完整且只需删除无效字段。
2. 可安全复用原始 payload 的临时传输错误，且工具没有产生副作用。
3. 工具执行前策略拒绝，且允许通过明确的专用 recovery tool 重新提交，不得自动绕过策略。

不允许自动恢复：

- 权限拒绝。
- 文件内容或目标状态可能已经改变。
- shell 命令失败。
- 取消或超时。
- 未知错误。
- 已经执行过可能产生副作用的工具。

### 2.3 无进展控制

每类错误单独计数。建议默认值：

```text
sameFingerprintLimit = 2
sameToolFailureLimit = 1
recoveryAttemptLimit = 1
policyReminderLimit = 1 per code and turn
```

处理顺序：

1. 第一次重复：记录并在本来就需要的下一次模型请求中追加短提醒。
2. 第二次重复：如果存在安全 recovery reference，提供专用恢复工具；否则返回结构化错误并要求改变方法。
3. 达到上限：不再继续追加相同提醒；在已有 `agent/pre-step` 边界返回 reject 或使用合适的 turn stop 结果。
4. 如果出现新证据，重置对应 fingerprint 的连续计数，但不重置整个 turn 的历史统计。

不能在 `agent/pre-step` 的空输入探测中单独制造请求。只有本来就有未完成工作或已有输入时，才追加提醒。

### 完成条件

- 固定脚本覆盖成功、同错重试、不同错重置、取消、跨 turn、跨 agent、卸载。
- 相同错误最多产生配置允许的模型请求数。
- recovery payload 与原始 payload 逐字一致，且恢复调用仍经过官方 pipeline。
- 无进展停止不会误判自然完成、max-tokens、concludeTurn 和只读问答。

## 阶段 3：write/edit 运行时约束，先观察后强制

### 目标

减少局部修改时的整文件重写，同时避免误伤新文件、生成器产物和用户明确要求的完整替换。

### 配置

建议把策略拆成独立模式，不直接把它绑定到 convergence 的软预算：

```yaml
convergence:
  enabled: true
  softStepBudget: 8
  recoverFailedWrites: true
  runtimePolicy:
    mode: observe        # off | observe | enforce
    noProgressLimit: 2
    recoveryAttemptLimit: 1
  fileMutationPolicy:
    mode: observe        # off | observe | enforce
    minLargeWriteBytes: 8192
    reminderLimit: 1
```

默认仍使用 `observe`，经过真实 A/B 后才切换 `enforce`。

### 3.1 分类输入

分类只依赖结构化事实和宿主提供的可选证据，不使用 pelican、SVG、HTML 等任务名启发式：

- 工具名是 `write` 或 `edit`。
- `file_path` 是否存在且是否为当前工作目录内路径。
- 目标是否在本轮被 read/grep/编辑过。
- 目标是否被判定为新文件或已存在文件。
- write 内容字节数、内容 hash 和上次已知版本。
- 同一轮是否先修改了生成器/源文件，再执行构建或生成命令。
- 用户或宿主是否通过显式 callback 声明 full replacement 或 generated artifact。
- 当前工具是否为根调用、PTC 子调用、恢复调用或其他代理调用。

### 3.2 放行规则

直接放行：

- 目标不存在且任务是创建新文件。
- 内容很小，低于 `minLargeWriteBytes`。
- 用户明确要求完整替换，且宿主能够提供可靠的显式判定。
- 生成器源或模板已经改变，当前 write 是已声明构建流程的产物。
- 没有 edit 工具可用，避免策略制造不可执行的要求。

建议 edit 或进入观察记录：

- 目标已知存在。
- 本轮已有 read/grep 或历史版本证据。
- write 内容很大。
- 当前任务上下文没有完整替换或生成产物证据。

拒绝条件必须比建议条件更严格。只有在 `enforce` 模式且同时满足“目标已知存在、内容大、edit 可用、没有 full replacement/generated callback、且重复写入或明显重写风险达到阈值”时，才拒绝 write。

### 3.3 拒绝结果

`tools/pre-execute` 返回结构化拒绝，内容至少包括：

```text
code: LARGE_WRITE_EXISTING_FILE
reason: target is known existing and the call appears to replace the whole file
nextAction: use edit with an exact unique match, or use the host-approved full-replacement path
retryable: false
```

不要只返回“请遵守全局规则”。错误必须告诉模型可执行的下一步，并且不能让它通过重新输出同一 write 绕过限制。

### 3.4 与 ast-grep 的关系

策略本身不解析任意源代码，不把 ast-grep 变成所有任务的必经步骤。对于代码任务，如果宿主或用户已经选择 ast-grep，则允许它作为 edit 前的证据来源。策略只检查工具调用和已观察结果，不强制模型为了通过策略额外运行 AST 工具。

### 完成条件

- observe 模式收集 write/edit 分类但不改变执行。
- enforce 模式覆盖新文件、已有文件局部修改、完整替换、生成器产物、无 edit 工具、子调用、取消和恢复调用。
- 误拒绝率在真实任务中为 0，或低于预先约定阈值且有清晰回退开关。
- 鹈鹕 SVG 任务的目标文件仍能生成；已存在文件的局部改动优先走 edit。
- 只读、review、数据和文档任务不被写入策略制造额外请求。

## 阶段 4：软工具要求和完成边界

### 目标

进一步借鉴 OMP 的 `SoftToolRequirement`，让模型第一次违反方法要求时只付一次低成本提醒，第二次才升级，而不是每轮重复解释。

### 4.1 软要求状态

建议为每个 active requirement 保存：

```text
id
requiredTool
satisfies(call) callback
reminderMessages
reminderCount
forcedCount
lastFailureFingerprint
```

典型要求：

- 已有文件的局部修改必须先使用 edit 或经过宿主批准的 AST 修改。
- 已经有计算脚本和已知参数时，后续计算应复用脚本，不重新塞入超长 shell 参数。
- 已有失败大 payload 时，优先调用 recovery tool，不重新生成正文。

### 4.2 状态转移

1. requirement 激活：在下一次本来就要发出的请求中注入一次 reminder。
2. 模型满足 requirement：清除当前 requirement，不改变正常 tool choice。
3. 模型调用其他工具：在 `tools/pre-execute` 阻止有副作用的绕路调用，并写入 synthetic tool result；允许无副作用的证据工具时需显式配置。
4. 下一步仍未满足：通过 `agent/request` hook 或官方支持的请求配置边界临时强制指定工具。此处必须先用 runtime fixture 确认 DSH 当前 request schema 是否支持 tool choice。
5. 强制失败达到上限：停止该 requirement，返回可诊断错误，不无限重采样。

### 4.3 完成判定

不能仅用“最后一次模型输出没有 tool call”判断任务完成。完成判定需要综合：

- 工具是否设置 `concludesTurn`。
- 是否存在未完成的 recovery reference。
- 是否存在重复失败或无进展状态。
- 是否有任务要求的验证结果。
- 是否仍有 pending inbox message。
- 是否为自然文本答案、max-tokens、取消或错误。

只有在自然结束且没有待处理工作时，才允许 turn 完成。不要为了追求少轮次而自动把错误当完成。

### 完成条件

- 第一次违反只产生一次 reminder。
- 相同 requirement 不会跨无关 turn 泄漏。
- 强制工具 choice 若 DSH 公开 hook 不支持，则保留“拒绝绕路 + 明确错误”方案，不修改核心硬塞字段。
- 自然完成、结论工具、max-tokens、取消和 follow-up 的行为保持官方一致。

## 阶段 5：A/B 验证、启用与回退

### 5.1 测试分层

每个阶段都必须运行：

```bash
npm test
npm run experiment
npm run inspect:profile
```

代码变更涉及 JS 结构或类型声明时，补充：

```bash
lsp diag src -e
```

真实适配器验证使用独立配置和新输出文件，不覆盖已有结果：

```bash
npm run experiment:live -- --config experiments/live.local.json --variant baseline --run --output experiments/baseline.phaseN.json
npm run experiment:live -- --config experiments/live.local.json --variant convergence --run --output experiments/convergence.phaseN.json
```

### 5.2 必测场景矩阵

| 场景 | 预期行为 |
|---|---|
| 新文件大 write | 放行 |
| 已有文件小 edit | 放行 |
| 已有文件大 write 且 edit 可用 | observe 记录，enforce 拒绝或要求批准 |
| 用户明确完整替换 | 放行 |
| 生成器源修改后构建产物 | 放行或由宿主 callback 放行 |
| 无 edit 工具 | 不制造不可执行要求 |
| write 失败且 payload 可安全复用 | 一次 recovery reference |
| 权限拒绝 | 不提供 recovery |
| shell 或 PTC 子调用失败 | 默认不提供文件恢复 |
| 相同错误重复 | 达到上限后停止重复提醒 |
| 新证据出现 | 重置对应连续失败计数 |
| 自然文本回答 | 不插入额外空请求 |
| concludeTurn | 不继续请求，除非有新 pending input |
| 取消、超时、卸载 | 清理状态、恢复引用失效 |
| 邻居 agent | 不共享策略状态 |
| 只读问答与 review | 无 write/edit 拦截 |
| 数据和文档任务 | 只使用通用结构事实，不匹配任务名称 |

### 5.3 启用顺序

1. 生产默认：`runtimePolicy.mode=observe`、`fileMutationPolicy.mode=observe`。
2. 观察至少三类真实任务，每类至少 3 次 A/B。
3. 先只启用 `runtimePolicy.mode=enforce`，确认无进展控制不会误停。
4. 再对明确的开发 profile 启用 `fileMutationPolicy.mode=enforce`，其他 profile 保持 observe。
5. 每次只切换一个开关，使用新会话，记录 profile 配置和实验输出路径。
6. 若质量下降、误拒绝、错误恢复增加或模型请求数上升，立即把对应模式切回 `observe`，不要修改历史记录或回滚用户源码。

### 5.4 成功标准

建议采用以下门槛，而不是只看步数：

- 任务完成质量不低于 baseline。
- 必需产物和验证通过率不低于 baseline。
- 重复 read、相同错误重复和大 write 重写比例下降。
- 目标任务模型请求数和总模型耗时下降，或在质量不变时至少不增加。
- recovery 重新生成大 payload 的次数为 0。
- 受策略影响的工具调用均有结构化原因和可追踪统计。
- 只读、review、数据、文档和新文件任务没有明显回归。

## 6. 文件级实施清单

### 第一批：观测与策略内核

- [x] 新增 `src/runtime-policy.js`。
- [x] 新增 `test/runtime-policy.test.js`。
- [x] 在 `src/convergence.js` 中增加配置和生命周期挂载。
- [x] 扩展 `scripts/live.mjs` 的指标输出。
- [x] 保持 `lib/index.js` 哈希不变。
- [x] 更新 `EXPERIMENT.md` 的行为和指标说明。

### 第二批：有限恢复

- [x] 把 `src/failure-recovery.js` 的候选状态抽象为通用 recovery record。
- [x] 保留 `retry_failed_write` 兼容入口，避免已有会话行为改变。
- [x] 增加 recovery 分类、attempt 上限和失效原因。
- [x] 新增重复失败、状态失效和跨 agent 测试。

### 第三批：write/edit 策略

- [x] 新增 `src/file-mutation-policy.js`，或在 runtime policy 中保持独立模块边界。
- [x] 增加 `off/observe/enforce` 三种模式。
- [x] 增加 host callback 的显式 full replacement/generated artifact 放行接口。
- [x] 增加新文件、已有文件、生成产物、无 edit、子调用和取消测试。
- [x] 默认保持 observe，enforce 仅由显式配置启用。
- [ ] 真实 A/B 尚未完成：离线 contract check 不代表模型请求数、耗时或质量收益；达到第 5.3 节门槛前不得宣称已验证或建议生产启用 enforce。

### 第四批：软工具要求

- [x] 确认 DSH hook 机制，采用非侵入式“注入提醒 + 绕路副作用阻止 + 结构化错误引导”架构。
- [x] 支持一次 reminder、有限绕路拒绝和结构化引导；未实现自动 forced tool choice。
- [x] 公开 hook 保持核心纯洁，保留“拒绝绕路 + 结构化明确引导”机制，无需修改官方核心。
- [x] 增加软步骤提醒的自然完成、concludeTurn、follow-up 生命周期测试。
- [ ] 软工具要求的真实模型行为与真实任务误拒绝率仍需在 A/B 矩阵中验证。

### 最后才考虑的核心改造

只有以下证据成立时才复制并修改官方核心：

1. 公开 `agent/pre-step`、`tools/pre-execute`、`tools/result`、`agent/request` 无法实现必须的状态转移。
2. hook 层实现会重复执行、破坏 session event 顺序或无法保证工具结果配对。
3. 有最小复现测试证明核心缺少必要边界。

届时必须：

- 复制新的官方核心并记录新 SHA-256。
- 用 ast-grep 先做结构预览，再进行最小范围改写。
- 保留 baseline 导出和 replacement 回退路径。
- 为核心改动新增 loop-level 测试，而不是只依赖插件测试。
- 在 `EXPERIMENT.md` 明确版本锁定、兼容性和回退方法。

## 7. 风险与处理

### 风险 1：把模型的合理完整重写误判为违规

处理：默认 observe；enforce 只对结构化事实充分且风险高的调用生效；提供宿主 callback 放行；记录拒绝原因和目标 hash。

### 风险 2：策略自己制造更多模型轮次

处理：提醒只能在已有工作请求的边界注入；每种 code 每 turn 至多一次；不能在空 pre-step 探测中创建新请求；恢复优先使用工具而不是让模型重新生成内容。

### 风险 3：跨任务场景兼容性差

处理：不使用任务名称、文件扩展名或 pelican 专属判断；只使用工具结构、路径事实、版本证据和宿主显式声明；四类任务矩阵必须通过后才启用 enforce。

### 风险 4：恢复引用复用过期内容

处理：owner、turn、tool definition、cwd、mutating operation、attempt count 全部校验；只保存 hash 和受控参数；现有 pipeline 再校验一次。

### 风险 5：官方版本升级后 hook 语义变化

处理：`engines.dsh` 精确锁定；运行 `setup:local`、测试、profile inspect 和基线 hash 校验；升级时重新检查 event payload、request schema 和工具拒绝语义。

### 风险 6：策略错误被模型误认为任务失败

处理：所有拒绝结果使用稳定 `code`、简短原因和 `nextAction`；统计中区分 policy denied、tool error、not executed、aborted 和 real execution error。

## 8. 交付顺序与停止条件

每一阶段都必须满足以下顺序：

1. 先写测试或 fixture，证明当前行为。
2. 再实现最小策略变化。
3. 运行单元、固定脚本和 profile 检查。
4. 运行必要的真实 loopback 或真实模型 A/B。
5. 记录指标、失败检查和产物路径。
6. 只有证据支持下一阶段时才继续。

任一阶段出现以下情况，停止扩大范围并回退到上一模式：

- 请求数或模型耗时增加且质量没有改善。
- 任务质量、必需产物或验证通过率下降。
- 新文件、生成器产物、只读问答或 review 出现误拦截。
- 同一错误仍然无限重试。
- 策略状态跨 agent、turn 或 session 泄漏。
- 需要修改官方核心但尚无最小复现和核心级测试。

最终交付不以“模型更听话”为验收条件，而以“无进展和错误恢复被运行时识别、工具副作用受控、真实任务质量不降、模型请求和耗时下降”为验收条件。
