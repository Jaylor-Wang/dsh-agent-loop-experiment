# agent-loop 独立收敛实验

这是 E:\Github\dsh-agent-loop 的实验入口。保留官方 0.2.2-rc.1 的循环实现，只通过公开提示词与 agent 钩子添加收敛策略。独立入口默认关闭策略；作为 DSH bundle 安装时，bundle 配置明确开启。准备包和测试不会自动安装进当前 Web profile。

## 运行

在本目录的 bash 执行：

```bash
npm run setup:local
npm test
npm run experiment
```

setup:local 从本机 DSH 安装复用同版本依赖，缺少的依赖创建本地目录链接，不访问注册表、不写宿主安装。如果 DSH 安装位置不同，通过 DSH_IMPLEMENTATION_ROOT 指定。已有依赖版本不符时会拒绝，不自动覆盖。所有实验会话独立运行在内存中。

本地链接安装沿用已准备的依赖，无需在实验包内另跑 npm install 或 pnpm install，也不要仅为消除 profile 的 peer 警告补装宿主已有的 Cordis、React。当前 15 个运行/验证依赖均链接到 DSH 安装目录；Zod 复用官方循环自身的 4.4.3，不能替换成宿主根目录的其他版本。后续宿主升级后，重新运行 setup:local 和相关验证，版本不符时先处理兼容性。

无需编译：这个副本是 npm 包的编译产物，实验层使用原生 ES module。原官方说明仍位于 [README.zh.md](./README.zh.md)。实验包标记 private，名称为 dsh-agent-loop-experiment，版本保持不变。

## 作为 Web 插件替换官方循环

已声明 dsh.bundle.patch，并提供 [cordis.patch.yml](./cordis.patch.yml) 和 [src/replacement.js](./src/replacement.js)。bundle 禁用 id 为 agent-loop 的官方条目，再添加唯一的 dsh-agent-loop-experiment:loop 条目。原模块名称仅用于补丁校验；DSH 不允许通过同 id 的 name 字段直接改名。替换类继承官方循环，保留平铺 agents/maxParallelToolCalls 配置、volatile 并发配置和同一个 agentLoop 服务，先挂载策略再执行官方初始化。不会覆盖全局 node_modules 中的官方文件。

本包固定支持 DSH 0.2.2-rc.1；engines.dsh 精确约束该版本。后续 DSH 升级需重新核验、更新副本与测试，不能把当前结果视为未来版本的兼容保证。

先在本目录执行：

```bash
npm run setup:local
npm test
npm run inspect:profile
```

inspect:profile 只在内存中合成替换后的配置，不启动服务、不读取凭据、不修改 profile。当前 Web profile 的检查结果：原循环禁用、一个新循环启用、软预算 8、原配置保留、0 警告。对于声明了 agents 或非默认并发的其他 profile，必须把原配置迁移到新条目；检查不通过时不要切换。

待当前任务完成后，停止运行中的 dsh web，在本机终端安装本地链接：

```bash
dsh plugin --profile web add "link:E:/Github/dsh-agent-loop"
```

这条官方插件管理命令会把本地包加入 profile 依赖与 bundle 列表。link 直接使用本目录及已准备好的依赖，private 包也可本地安装，不需要发布到 npm。不要手工同时挂载包根入口和 replacement 入口，也不要额外启用原循环。链接安装后，本目录代码变化在下次进程重启时生效。

安装后从本目录再次执行 npm run inspect:profile，确认 bundleAlreadySelected 为 true、activeLoopCount 为 1、officialDisabled 与 convergenceEnabled 为 true、ready 为 true，再启动：

```bash
dsh web
```

此修改属于服务端循环，不需要重建 Web 前端，也不能仅靠刷新页面生效。重启原 DSH Web 进程后刷新其原地址，并新建会话测试。运行证明可查看新会话记录中首个 system/message 是否包含固定指导；超过软预算且仍需继续的轮次应有一条 source.kind 为 loop-convergence 的 user/message。短任务没有预算提醒属于预期。

当前 Web profile 的 awesome-agent 预设使用普通 persona prefix，不是 complete 提示词；它可与此指导组合。实际启用仍以重启后会话记录为准。

## 调整、停用与回退

以下为 profile 的 cordis.patch.yml 覆盖片段，追加在已有顶层列表，不要覆盖其他配置。DSH 的 config 是整体替换，必须一并保留 agents 和 maxParallelToolCalls：

```yaml
- id: dsh-agent-loop-experiment:loop
  name: dsh-agent-loop-experiment/replacement
  config:
    agents: []
    maxParallelToolCalls: 10
    convergence:
      enabled: true
      softStepBudget: 8
```

把 enabled 改为 false 可保留替换循环而关闭收敛策略。重启后开始新会话做对照，旧历史中的指导和提醒不会被抹除。

完整恢复官方：先停止 dsh web，移除手动添加的新条目覆盖片段，然后执行：

```bash
dsh plugin --profile web remove dsh-agent-loop-experiment
dsh web
```

bundle 被移除后，禁用官方循环的补丁也随之消失；原 agent-loop 条目自动恢复。不会删除会话记录或源码目录。若 profile 里另外写了 id: agent-loop / disabled: true 的个人覆盖，也要移除或改为 false，避免个人层继续禁用官方循环。

若包暂时仍安装着，也可在个人层同时设置原 agent-loop 的 disabled: false 和 dsh-agent-loop-experiment:loop 的 disabled: true，重启即可回到官方。两条需配对修改，保证只有一个循环服务启用。

## 策略行为

配置位于 [src/convergence.js](./src/convergence.js)：

| 配置 | 默认值 | 含义 |
|---|---:|---|
| enabled | false | 显式开启收敛策略 |
| softStepBudget | 8 | 完成这么多个模型步骤后，在下一次已经需要的请求中提醒一次 |
| recoverFailedWrites | true | 策略开启时提供大段写入参数错误的短引用恢复；可独立关闭 |
| runtimePolicy.mode | observe | 运行时观察策略模式：`off`（关闭）、`observe`（仅观测与统计，不拦截）、`enforce`（拦截无进展） |
| runtimePolicy.noProgressLimit | 2 | 相同操作指纹连续重复的容忍阈值（enforce 下拦截连续重复无进展调用） |
| runtimePolicy.recoveryAttemptLimit | 1 | 恢复引用可尝试次数上限 |
| runtimePolicy.minLargeWriteBytes | 8192 | 大写入字节阈值判定标准 |
| fileMutationPolicy.mode | observe | 文件写/改策略模式：`off`、`observe`、`enforce` |
| fileMutationPolicy.minLargeWriteBytes | 8192 | 大文件重写识别阈值（字节） |
| fileMutationPolicy.reminderLimit | 1 | 针对重写风险的提示次数上限 |
| softToolRequirement.enabled | true | 软工具要求管理器开关（提醒模型使用预期工具，拦截绕路副作用） |
| softToolRequirement.reminderLimit | 1 | 每项软要求的提醒次数上限 |
| softToolRequirement.maxViolations | 2 | 违反要求后容忍并阻断绕路的最大次数 |

`SoftToolRequirementManager.addRequirement(session, options)` 由宿主按具体任务显式激活要求；要求状态仅保留到当前 turn 结束。提醒仅随已有输入注入，满足工具只有成功返回后才结算；拒绝结果为带 `code`、`nextAction` 与 `retryable` 的 JSON。当前没有自动强制 tool choice；真实模型误拒绝率尚未验证，enforce 使用前需完成第 5 节 A/B。


开启后，从第一步开始加入固定指导，固定指导不随着步骤变化：

- 在输出第一段大内容之前决定落盘路径。新交付文件通过原生 write 写入；需要计算时，优先复用项目已有工具，或通过原生 write 创建可复用脚本并按路径执行。完整文件和大脚本不得放入 node -e、python -c、pwsh -Command 等 shell 参数；出现 spawn ENAMETOOLONG 后，本轮后续大段输入继续使用文件方式。
- 对输入已知且相关的计算，在一次运行内完成范围有限的参数比较、生成和验证，集中可调参数，复用脚本与已确认结果；只返回简明结论、失败检查和产物路径，大量生成内容保留在文件中。后续选择依赖新证据，或批量执行会显著增加成本或副作用时，保留分阶段探索；简单的一次性计算无需额外搭建脚本。
- 局部修改优先复用已有且仍有效的相关文件内容，只补读缺失或过期上下文，再用原生 edit 和唯一匹配修改，避免重新输出整份文件。生成产物应修改源文件或生成器，再沿用既有构建流程生成。保留无关改动、编码和换行；新文件、用户明确要求完整替换、必要的大范围重写或无法可靠局部编辑时，仍可用 write。覆盖既有内容前须先检查，之后验证受影响行为。
- 独立读取、搜索和检查可在同一响应内批量调用，保留依赖顺序和工具独占屏障；只有缺失的环境信息阻碍下一步时才探测能力。
- 创建资源时记录任务自己的会话、服务 ID 和临时路径。验证后批量关闭兼容资源、清理临时产物，保留必要先后顺序；使用已知路径和既有结果，避免重复目录检查或未经请求的备份副本。异步停止操作仍需收集完成结果。
- 取得结果后推进完整的下一步决策，避免没有新证据的重复检查；完成必要工作与验证后交付。所有指导仍服从用户要求、正确性、权限检查、必要验证与取消。

大段写入恢复位于 [src/failure-recovery.js](./src/failure-recovery.js)：只接受本轮原生根 write、8 KiB 至 1 MiB 的完整内容，并且错误必须精确为 `invalid escalation: justification is only valid together with sandbox_permissions`。原调用必须没有 sandbox_permissions，只允许 file_path/content/justification 三个参数；权限拒绝、取消、未知错误、PTC 原始子调用和 shell 命令不会产生恢复引用。插件不解析 shell，也不自动重试。

符合条件时，在下一次本来就需要的请求尾部追加一次 source.kind 为 loop-write-recovery 的通知。模型可调用 `retry_failed_write({"call_id":"原调用 ID"})`，复用原路径和逐字相同的内容，只移除无效 justification。模型无需再次生成大段正文。恢复调用仍通过共享 ToolExecutionPipeline 检查当前作用域、步骤准入、工具策略、文件写入意图与取消；嵌套 write 记录在官方 tool/ptc-dispatch-start 与 tool/ptc-dispatch 事件中，原失败保持可见。

仅在内存保留本轮最近一次引用；恢复尝试后消耗，后续可能修改文件的调用、工作目录变化、轮次结束或插件卸载使其失效，进程重启不会恢复引用。可在 convergence 下设置 recoverFailedWrites: false 关闭这一入口。当前 Web profile 已通过 link 安装本实验包，因此本次源码修改无需重装或构建前端；结束当前任务后重启原 dsh web 进程，再建新会话即可生效。

达到软预算时，每轮至多追加一次提醒到历史尾部。预算按本轮已接纳的 step/start 计数，重试不重复计算步骤；不随整个会话累计。提醒仍由官方循环提交，拒绝或取消不会提前标记为已提交。提醒要求检查剩余完成条件，工作未完成时继续做，并再次点明复用结果、合并范围有限的已知计算、局部 edit、生成源复用、大段内容落盘和兼容清理批处理；保留证据驱动的探索、依赖关系和必要检查，不要求强行回答。

这些提示适用于代码修改、数据处理、文档与内容生成等任务，没有特定任务名、文件类型、计算轮数或输出大小的启发式拦截。只读问答和审查不因这些提示获得写入授权；小任务直接处理，未知问题按新证据推进。项目约定、用户明确要求的整文件交付以及必要重构仍优先；本策略不拦截工具，也不强制把所有工作合成一次执行。

策略不会限制总步骤、自动宣布完成、修改 provider/model/reasoningEffort、合并具有依赖的调用或改写已有工具结果。裁剪继续由 dsh-tool-result-trimmer 负责。自然结束、max-tokens、concludeTurn 和拒绝均保持官方行为；特别避免在自然结束后的空 preStep 探测中加入消息而制造新请求。

如果宿主使用 complete 系统提示，普通提示词 section 会按官方规则被覆盖；收敛指导可能不进入系统提示，应检查实际请求。运行中开启/关闭会改变当时的提示词，因此对照实验应从全新会话开始；本实验未承诺热切换时缓存前缀不变。

## 接入独立宿主

包入口挂载一个官方循环，并在相同作用域下挂载策略：

```js
import experiment from 'dsh-agent-loop-experiment';

await ctx.plugin(experiment, {
  loop: { maxParallelToolCalls: 10, agents: [] },
  convergence: { enabled: true, softStepBudget: 8 }
});
```

独立宿主须提供官方 agents、sessions、llm、tools、systemPrompt 和 sessionProjections 服务，并配置工具执行器与模型适配器。不要在已有官方循环上再挂载包入口。已有循环的独立宿主可以只加载 dsh-agent-loop-experiment/policy；在 agent setup 的作用域加载，则只影响该 agent。官方未修改基线由 dsh-agent-loop-experiment/baseline 导出；使用官方平铺配置的单一服务替换入口为 dsh-agent-loop-experiment/replacement。

## 离线测试与真实对照

npm run experiment 使用固定模型响应脚本，预期两组都是 4 次请求、4 次工具调用；区别是收敛组追加一次提醒。它验证策略接线、正常完成与前缀保留，不能证明真实模型会少走步骤。

[experiments/task.json](./experiments/task.json) 提供一个只读任务：读取四条独立事件记录，返回准确 JSON。评分同时要求四条记录确实读过、答案值与键集合正确。任务用于验证真实适配器、工具批次与统计链路；不足以代表复杂开发任务。

复制 [experiments/live.example.json](./experiments/live.example.json) 为 experiments/live.local.json，填写自己的模型、协议和 endpoint，保持两组配置一致。凭据只通过 apiKeyEnv 指定的环境变量传入，不写入配置。默认仅验证初始化，不发送模型请求：

```bash
npm run experiment:live -- --config experiments/live.local.json --variant baseline
npm run experiment:live -- --config experiments/live.local.json --variant convergence
```

明确准备好发送模型请求后，添加 --run：

```bash
npm run experiment:live -- --config experiments/live.local.json --variant baseline --run --output experiments/baseline.local.json
npm run experiment:live -- --config experiments/live.local.json --variant convergence --run --output experiments/convergence.local.json
```

每条命令启动新的独立进程与内存会话；不会改动 GUI 或恢复当前会话。结果文件独占创建，重跑需使用新文件名。超时会取消实验任务，仍等待官方循环排空；超时、质量未通过或循环错误使退出码为 1。

记录模型请求数、每次请求流耗时列表与累计用时、任务总耗时、首个 token P50/P95、token usage、工具调用数、失败工具数、大 write 次数、edit 次数、写入/编辑字节量、重复读取、提醒数、恢复通知数、提前停止数、运行时策略观测指纹统计（重复指纹碰撞数、最大连续重复数）与答案质量。模型流计时包括适配器/上游等待和生成，不等同于纯推理或 HTTP 时间；未提供 usage 的响应会单独计数。仅记录聚合指标，不落盘模型原文或凭据。

建议真实评估选择至少三类任务，每类多次交替 A/B 执行，保持模型、推理档位、工具、裁剪和上下文起点相同。先比较完成质量，再比较请求数与总耗时。这个四记录任务通常在软预算之前就结束，可用于固定指导的试验；若要验证一次提醒的接线，可在独立实验配置中把预算设为 1，实际收益测试保留目标预算。

## 已验证与限制

测试使用真实的官方循环、Cordis、会话/投影注册表、LLM runtime、工具流水线与 native executor；模型响应脚本固定。额外测试通过本机 loopback SSE 服务和真实 pi-ai 适配器运行两组，并检查答案评分与待发送消息前缀。没有调用外部模型端点。

覆盖：默认关闭与基线一致、一次提醒、预算不强制结束、消息前缀、正常结束、max-tokens、工具失败、工具并发、工具结论与附加上下文、重试、取消、拒绝、后续轮次、作用域隔离和卸载。

初版检查结果：npm test 共 21 项全部通过，0 失败、0 跳过；npm run experiment 两组完成且历史前缀稳定；项目 lsp diag 执行 tsc --noEmit 通过；真实适配器 dry-run 通过；新增 bundle 替换/回退、平铺配置和版本约束测试通过。本次恢复迭代新增覆盖逐字复用、单次尝试、权限拒绝、取消、工作目录变化、步骤准入、引用失效、卸载，以及宿主官方 write 与文件写入意图的集成验证；最终结果：共 34 项测试通过，0 失败、0 跳过；lsp 文件诊断无错误，项目 tsc --noEmit 通过；已安装 Web profile 的只读组合检查 ready=true，0 警告。未调用外部模型，尚需重启后的真实任务复测。官方核心 SHA-256 为 a6fa8e0c7c90191caf5f4a3bb5c624a86e9845cf3c79d020b71420d0e20ae4c1，与复制时基线一致。

这只是本地实验包，尚未证明可以减少真实模型请求数或改善任务完成时间。复杂任务的补读、返工与完成率仍需真实对照，不能拿模拟响应的耗时作为性能结论。
