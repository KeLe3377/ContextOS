# ContextOS 对话摘要接入方案

日期：2026-09-20　状态：**设计稿，未实现**　作者：与用户对话中整理

---

## 1. 摘要

导入一个 Codex 对话后，ContextOS 目前**只存原文和结构化事件，不生成任何概括**
（`summary` 是模板字符串，详见
`2026-09-20-codex-appserver-readonly-sync-plan.md` §16）。

本方案分两阶段：

| 阶段 | 做什么 | 依赖 |
|---|---|---|
| **A** | 接一个 OpenAI 兼容的文本模型，导入后生成真实概括 | `TEXT_MODEL_*`（本地已配好） |
| **B** | 引入 TypeSafe Jev 做前置判断，只对「值得概括」的调用模型 | `TYPESAFE_API_KEY`（本地已配好） |

**先做 A，B 等 A 跑顺、发现成本高了再说。**

一个前置结论（已核实，别走弯路）：**Jev 不能用来生成概括**。
它只输出 typed decisions（`choice` / `boolean` + 概率），不产生字符串。
证据见 §7。

---

## 2. 现状

### 2.1 导入后库里有什么

实测一次 `POST /api/sessions/{id}/import-transcript/auto` → 201：

```
sizeBytes 183313 · parserVersion codex-jsonl.v5 · transcriptTruncated false
eventCount 61 = message 16 + toolCall 15 + toolResult 15 + summary 15
roleCounts { user: 5, assistant: 11 } · turnCount 5
resumeCapsule.summary = "Imported 16 Codex transcript messages."   <- 模板串
```

三层产物：

| 层 | 位置 | 内容 |
|---|---|---|
| 原文全文 | `evidence_snapshots.storage_ref` 指向的磁盘文件 | `contentText`，格式化纯文本，上限 1,000,000 字符 |
| 结构化事件 | 同一条 evidence 的 `metadata.events`（JSON 数组） | `{ordinal, kind, role?, text, timestamp?}`，`kind ∈ message/tool_call/tool_result/summary` |
| 恢复胶囊 | `sessions.runtime_state` | `summary` + 累积 `evidenceSnapshotIds` |

### 2.2 两个会绊人的现状细节

**① `evidence_snapshots` 表没有 summary 列。**
`runtime-repository.ts:493` 的 INSERT 列清单里只有 `title`，没有 `summary`，
所以 `input.summary` 只被写进 Resume Capsule，**没有落到 evidence 上**。
实测 `evidence.summary` 返回 `undefined` 正是这个原因。
→ 生成出来的概括要么放 Resume Capsule，要么塞进 `metadata`，**不能指望 evidence.summary**。

**② `settings.contextConfig` 会返回给前端，不能放密钥。**
`contracts/runtime.ts:18` 里 `contextConfig: z.record(z.unknown())` 是个自由
配置袋，看起来很适合塞模型配置 —— 但 `SettingsDto` 整体会返回给前端
（`localEndpoint`、`dataDirectory` 都在里面），**密钥放进去等于泄露**。
→ 模型配置一律走**服务端环境变量**。

---

## 3. 目标 / 非目标

**目标**

- A1：导入后自动生成一段人能读的概括，填进 Resume Capsule。
- A2：模型不可用 / 超时 / 返回垃圾时，**静默降级**保留模板串，导入本身不失败。
- A3：同一份内容不重复付费（按已有 `contentHash` 复用）。
- B1（阶段二）：用 Jev 先判「这条值得概括吗」，只对值得的调模型。

**非目标**

- 不做向量检索 / 语义搜索。
- 不改导入的原文与事件结构（那是稳定的 parser 契约）。
- 不做多轮交互式摘要（一次导入只生成一次）。
- 不在前端暴露任何密钥。

---

## 4. 阶段 A：接文本模型

### 4.1 触发时机与接入点

```
用户点「导入」
  ↓
runtime-services.ts:249  importAdapterTranscriptInternal
  ↓
adapter.importTranscript()          -> contentText + events
  ↓
runtime-services.ts:312  persistTranscript
  ↓
runtime-repository.ts:481  importSessionTranscript   <- 数据库事务，写 template summary
  ↓
★ 新增：事务提交之后，异步生成概括，再 patch 回去
```

**关键约束：`importSessionTranscript` 是一个 `db.transaction()`**
（`runtime-repository.ts:482`）。绝不能在事务内部发 HTTP 请求 ——
better-sqlite3 的事务会持有写锁，一次几秒的网络往返会把整个 daemon 堵住。

正确做法：**事务先提交，拿到 `evidenceId` 之后**，再调模型，
成功则用 `writeResumeCapsule` / `patchResumeCapsule` 回填。

### 4.2 配置

全部用环境变量，服务端读取，不进前端：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CONTEXTOS_SUMMARY_ENABLED` | `false` | 关掉时行为与现在完全一致 |
| `CONTEXTOS_SUMMARY_BASE_URL` | — | OpenAI 兼容端点，如 `https://openrouter.ai/api/v1` |
| `CONTEXTOS_SUMMARY_API_KEY` | — | 密钥 |
| `CONTEXTOS_SUMMARY_MODEL` | — | 如 `inception/mercury-2.5` |
| `CONTEXTOS_SUMMARY_TIMEOUT_MS` | `15000` | 超时后降级 |
| `CONTEXTOS_SUMMARY_MAX_CHARS` | `24000` | 送进模型的字符上限 |

前四项可直接复用本地 `source/jev-ultrafast-main/.env` 里已有的
`TEXT_MODEL_*` 一套（该文件的 `TEXT_MODEL_BASE_URL` / `TEXT_MODEL` 已配值），
只是换成 ContextOS 自己的前缀。

### 4.3 送什么给模型

**不要直接丢 `contentText`。** 它最多 100 万字符，且包含大量工具调用原文。

优先用**结构化事件**重建输入，按这个顺序取，直到逼近 `MAX_CHARS`：

1. `kind === "message"` 且 `role` 有值的（真实对话）
2. `kind === "summary"` 的（Codex 自己产生的推理摘要，信息密度高）
3. 只有在前两类不够长时才补 `tool_call` / `tool_result`

每条格式化成 `[role] text`，保留 `ordinal` 顺序。

> 已知污染：事件里可能混着 AGENTS.md 注入与 `<environment_context>`
> （见 appserver 方案 §13.6）。**这个过滤应当在阶段 A 之前或同时做掉**，
> 否则模型会拿注入内容当用户输入去总结。

### 4.4 请求与解析

- 端点：`POST {BASE_URL}/chat/completions`，OpenAI 兼容格式。
- 不依赖 response_format / JSON schema（各家支持不一），
  直接要求返回纯文本，再自己做一次 `trim()` + 长度校验。
- 输出要求写进 system prompt：3-5 句、中文、不臆造、不提工具调用细节、
  只说「做了什么、当前状态、下一步」。

**解析失败的判定**（任一命中即视为失败、走降级）：
空串 / 长度 < 10 / 长度 > 2000 / 明显是模型复述 prompt。

### 4.5 存到哪

| 字段 | 怎么改 |
|---|---|
| `resumeCapsule.summary` | 主落点。已有 `patchResumeCapsule` 可用 |
| evidence `metadata.generatedSummary` | 附带存一份，保留证据链 |
| evidence `metadata.summaryModel` / `summaryGeneratedAt` | 便于回溯是哪次生成的 |

不改 `evidence_snapshots` 表结构（没 summary 列，加列要写迁移，不值得）。

### 4.6 失败降级

任何一步出错都**不能让导入失败** —— 概括是增强，不是主流程：

```ts
try {
  const summary = await generateSummary(material, config);
  if (summary) { patchResumeCapsule(...); patchEvidenceMetadata(...); }
} catch {
  // 保留模板串。记一条 metadata.summaryError 便于排查，不抛给调用方。
}
```

需要覆盖的失败情形：未启用 / 缺配置 / 网络错 / 超时 / 非 2xx /
返回内容解析失败 / 内容为空。

### 4.7 幂等与去重

已有 `findSessionTranscriptByHash(sessionId, contentHash)`
（`runtime-repository.ts:525`）会复用相同内容的 evidence。
概括结果同样按 `contentHash` 判定：命中已有 evidence 且其
`metadata.generatedSummary` 非空 → 直接复用，不重新调用模型。

### 4.8 需要改的契约

- `contracts/sessions.ts:43` `resumeCapsuleDtoSchema.summary` —— 类型不用改
  （已经是 `z.string()`），但语义从「模板串」变成「模型产出」，注释要更新。
- 新增一个内部类型描述模型配置（不进 HTTP 契约，服务端内部用）。

---

## 5. 阶段 B：Jev 前置过滤（后置，非必需）

等 A 跑顺且调用量大到在意成本时再上。

思路（来自 `source/解释Jev与分类器-AI.md` §1789 的 Memory Decision Layer）：

```
候选内容
   ↓
Jev: 这个对话值得概括吗？(choice: full / brief / skip)  + 概率
   ↓
full  -> 完整摘要（多花 token）
brief -> 一句话摘要
skip  -> 不调模型，保留模板串
```

Jev 在这里的价值：**把「要不要花钱」这件事变成一个有概率的结构化判断**，
而不是靠字符数硬编码阈值。

接入参考：`source/jev-ultrafast-main/jev_ultrafast/questions.py`（question
schema 写法）与 `model.py`（调用封装 + `validate_choice`）。

---

## 6. 风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 在事务内调模型，写锁被长时间持有 | 强制「先提交事务再生成」，见 §4.1 |
| R2 | 密钥经 `settings.contextConfig` 泄到前端 | 只用环境变量；settings 不新增任何模型字段 |
| R3 | 模型慢导致导入接口明显变慢 | 默认超时 15s；超时即降级；后续可改后台任务 + 轮询 |
| R4 | 100 万字符直接送模型，费用失控 | 用结构化事件重建输入，硬上限 24000 字符 |
| R5 | AGENTS.md / environment_context 注入被当成用户发言总结 | 先在 `readCodexEvent` 做前缀过滤（appserver 方案 §13.6） |
| R6 | 模型返回臆造内容 | prompt 明确禁止；结果只作为「参考摘要」展示，不覆盖原始事件 |
| R7 | 重复导入重复付费 | 按 `contentHash` + `metadata.generatedSummary` 复用 |
| R8 | 依赖外部服务，离线环境不可用 | 默认 `ENABLED=false`，离线行为与现在完全一致 |

---

## 7. 为什么不用 Jev 直接做概括

三重证据（详见 memory 2026-09-20）：

1. 文档原文：*「LLM 产生字符串，而 Jev 产生 typed decisions」*；
   定位是「分类、评分、判断、路由」，输出 `choice`/`boolean` + 概率。
2. `jev-ultrafast/model.py` 首行注释：
   *"TypeSafe makes choices; an optional small OpenAI-compatible model writes
   field values."* —— 文本由**另一个**模型写。
3. 本地 `.env` **两套密钥分开**：`TYPESAFE_API_KEY`（判断）与
   `TEXT_MODEL_API_KEY/BASE_URL/MODEL`（生成）。

补充：`source/jev-ultrafast-main` 本身是个 **browser agent**（Jev 选 operation
和元素，小模型只在 `TYPE_TEXT` 时写字），跟「对话概括」不是一回事，
但可作为 Jev 接入方式的代码参考。

---

## 8. 验证计划

| 门禁 | 条件 |
|---|---|
| G1 | 关掉 `ENABLED` 时，导入结果与现在**逐字节一致**（回归） |
| G2 | 配好模型后导入，`resumeCapsule.summary` 是中文自然语言，不再是模板串 |
| G3 | 把 API key 改成错的 → 导入仍返回 201，summary 回退模板串，`metadata.summaryError` 有值 |
| G4 | 把 base url 指向不可达地址 → 15s 内返回，不卡住后续请求 |
| G5 | 同一会话连续导入两次 → 模型**只被调用一次** |
| G6 | 拿一个含 AGENTS.md 注入的真实 rollout → 摘要里不出现仓库规则内容 |
| G7 | 抓包确认 `/api/settings` 响应里**不含**任何密钥字段 |

---

## 9. 工作量

| 项 | 估 |
|---|---|
| 环境变量读取 + 配置校验 | 小 |
| 从 events 重建摘要输入 + 截断 | 中 |
| HTTP 调用 + 超时 + 解析 | 中 |
| 事务外回填（capsule + metadata） | 中 |
| 注入过滤（可独立先做） | 小 |
| 测试（G1-G7） | 中 |

整体约半天到一天。注入过滤可以拆出来先做，独立且低风险。

---

## 10. 决策记录

- **D1**：概括放在导入流程**之后**异步回填，不放在事务里 —— 避免写锁被网络往返持有。
- **D2**：模型配置走环境变量，不进 `settings` —— `SettingsDto` 会返回前端。
- **D3**：不改 `evidence_snapshots` 表结构 —— 没有 summary 列，加列要迁移，性价比低。
- **D4**：失败一律静默降级 —— 概括是增强，不能让导入失败。
- **D5**：阶段 A 只接文本模型，不碰 Jev —— Jev 不生成文本，用它做概括是错的。
- **D6**：Jev 的正确位置是阶段 B 的「要不要概括」判断，不是「写出概括」。

---

## 11. 代码位置索引

| 位置 | 作用 |
|---|---|
| `codex-adapter.ts:234` | `parseCodexTranscript`（1M 上限 #265、50MB #236） |
| `codex-adapter.ts:308` | `readCodexEvent`（注入过滤要改这里） |
| `runtime-services.ts:249` | `importAdapterTranscriptInternal` |
| `runtime-services.ts:312` | `persistTranscript` |
| `runtime-services.ts:499` | `writeResumeCapsule`（run 生命周期用，非导入路径） |
| `runtime-services.ts:138` | `getTranscriptEvents`（返回最后 200 条） |
| `runtime-repository.ts:481` | `importSessionTranscript`（事务，写 template summary） |
| `runtime-repository.ts:525` | `findSessionTranscriptByHash`（去重） |
| `runtime-repository.ts:833` | `contextConfig` 读取处 |
| `contracts/runtime.ts:18` | `contextConfig: z.record(z.unknown())` |
| `contracts/sessions.ts:43` | `resumeCapsuleDtoSchema.summary` |
