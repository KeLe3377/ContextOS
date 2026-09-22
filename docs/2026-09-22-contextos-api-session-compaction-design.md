# ContextOS API 版会话压缩 — 集成设计文档

- 状态：设计（待实现）
- 日期：2026-09-22
- 范围：Jev（TypeSafe System One）+ LLM 两段式 API 压缩，生成结构化中文 Resume Capsule
- 明确不做：Kev-4B、Qwen 本地部署、模型量化、任何本地推理
- 不改动：`docs/superpowers/plans/2026-09-21-contextos-local-semantic-compaction.md`

---

## 1. 目标与边界

### 1.1 目标

在既有「Evidence → 确定性 Resume Capsule → Continue」链路上，叠加一条**可替换的 API 压缩路径**：

1. **Jev API**：对每一个「工具调用 + 工具结果」配对，判定 `KEEP_FULL` / `KEEP_CALL_ONLY` / `DROP`。
2. **LLM API**：基于压缩后的内容，生成**结构化中文 Resume Capsule**。
3. 两段产物都是**可删除、可重新生成的派生产物**；Evidence 永远不可变。
4. 任一 API 失败时**自动降级**到现有确定性 Capsule，Continue 始终可用，并明确显示当前来源。

### 1.2 非目标（明确退出活跃范围）

- 不恢复 `Compaction Artifact → Extractor → Candidate → Review` 流水线。
- Candidate/Review **不得**重新进入 Continue 关键路径。
- 不做本地模型部署/量化（Kev-4B、Qwen 等）。

### 1.3 必须保持的产品语义（沿用核心修剪的硬约束）

- 首次绑定仍从 rollout EOF 开始，不摄入绑定前历史。
- 轮询间隔下限仍为 5000ms。
- Evidence + reader offset + Resume Capsule 三者仍**同事务一致提交**。
- 不改写/删除 migration 0012/0013/0014；不删用户既有表与数据。

---

## 2. 当前正式链路（已用代码确认，非推测）

```
DesktopSync.read(session)
  └─ AutomationService.commitRead()                      apps 内部：packages/application/src/core/automation-service.ts
       ├─ evidence.prepareAgentOutput()                   （磁盘 blob 先写，事务外）
       └─ sync.runIngestionTransaction()                  （better-sqlite3 savepoint）
            ├─ evidence.commitPreparedAgentOutput()       → Evidence 行（不可变）
            ├─ sync.upsert(nextState)                     → reader offset 前进
            └─ resumeCapsuleWriter.write({                → Resume Capsule
                 sessionId,
                 ...buildSessionContinuity({...})         ← packages/application/src/core/session-continuity.ts
               })

ContinueSessionService.continue()                      packages/application/src/core/runtime-services.ts
  └─ runtime.getResumeCapsule(session.id).contextText
       └─ formatResumePrompt({ session, contextPackage, adapterName, continuity })
```

关键事实：

| 事项 | 事实 |
| --- | --- |
| 确定性 Capsule | `buildSessionContinuity`：12,000 字符上限、500 字符 nextAction、复用 canonical codec + `PrefixTranscriptSanitizer`、**确定性**（无模型/时钟/文件系统） |
| Capsule 存储 | `sessions.runtime_state` JSON 的 `resumeCapsule` 字段（`ResumeCapsuleState`）。**扩展它不需要 migration。** |
| 事件模型 | `AgentTranscriptEvent = { ordinal, timestamp?, kind: message\|tool_call\|tool_result\|summary, role?, text?, name?, callId?, truncated?, isError? }` |
| 配对键 | `callId` —— `tool_call` 与 `tool_result` 靠它配对 |
| Evidence 读取 | `evidence.readSessionTranscriptBatches({ projectId, sessionId, stream: "desktop-sync", limit: 24 })` → `{ id, canonicalText }[]`（oldest first） |
| Settings | `settings` 表（singleton 行，含 `context_config_json` / `privacy_config_json` JSON 列）；`patchSettings` 目前仅改 4 个固定列 + revision |
| migrations | 到 `0014`；新配置**优先复用 JSON 列**或新增 `0015`（不碰 0012/0013/0014） |

---

## 3. 架构总览

两个阶段、各有两个可替换实现（API 版与确定性版）：

```
                         ┌──────────────────────────────┐
   Evidence（不可变）  ─▶ │  CompactionProvider（阶段 1）  │
                         │   · JevCompactionProvider     │  判定 KEEP_FULL /
                         │   · DeterministicCompactionProvider │ KEEP_CALL_ONLY / DROP
                         └───────────────┬──────────────┘
                                         ▼
                              压缩后事件（派生物，可删）
                                         │
                         ┌───────────────▼──────────────┐
                         │  ResumeCapsuleGenerator（阶段 2）│
                         │   · ResumeCapsuleGenerator(LLM)│  结构化中文 Capsule
                         │   · DeterministicCapsuleGenerator│ ← 现有 buildSessionContinuity
                         └───────────────┬──────────────┘
                                         ▼
                              Resume Capsule（写入 runtime_state）
                                         │
                                         ▼
                                    Continue（formatResumePrompt）
```

### 3.1 四个稳定且可替换的接口

```ts
// ---- 阶段 1：压缩判定 ----
export type CompactionAction = "KEEP_FULL" | "KEEP_CALL_ONLY" | "DROP";

export interface JevCompactionProvider {
  readonly id: "jev";
  compact(input: CompactionInput, signal?: AbortSignal): Promise<CompactionResult>;
}

export interface DeterministicCompactionProvider {
  readonly id: "deterministic";
  compact(input: CompactionInput, signal?: AbortSignal): Promise<CompactionResult>;
}

// ---- 阶段 2：Capsule 生成 ----
export interface ResumeCapsuleGenerator {
  readonly id: "llm";
  generate(input: CapsuleInput, signal?: AbortSignal): Promise<CapsuleResult>;
}

export interface DeterministicCapsuleGenerator {
  readonly id: "deterministic";
  generate(input: CapsuleInput, signal?: AbortSignal): Promise<CapsuleResult>;
}
```

- `DeterministicCapsuleGenerator` = 现有 `buildSessionContinuity` 的**薄包装**，是唯一保证成功的实现（无网络、无密钥、纯函数）。
- `DeterministicCompactionProvider` = 规则版压缩（保留最近 N 条、错误/失败结果全留、长成功结果截断到 `truncateHeadChars`、其余按“装不下就停”选择）。它用于「开启了压缩但 Jev 不可用」时仍能压缩。
- 所有实现**只读 Evidence**，产出派生物；不得写 Evidence，不得触碰 Candidate/Review。

### 3.2 组合器（编排）

`ApiCompactionCoordinator`（application 层，注入到 `AutomationService`）负责选择与降级：

```
resolveConfig(session.projectId)  →  { apiCompactionEnabled, deterministicFallbackEnabled,
                                       jev{endpoint,model,apiKeyRef,timeoutMs},
                                       llm{endpoint,model,apiKeyRef,timeoutMs},
                                       inputTokenBudget, outputTokenBudget }

if (!apiCompactionEnabled || !hasKey(jev) || !hasKey(llm))  → deterministicCapsule
else try:
    compacted = jevCompactionProvider.compact(evidence)          // 超时/错误 → throw
    capsule   = llmCapsuleGenerator.generate(compacted)          // 超时/错误 → throw
    validate(capsule)                                            // schema + evidence 引用 + token 上限
    → source = "api"
catch any:
    if (!deterministicFallbackEnabled) → 记录降级原因，仍返回 deterministic（Continue 不能被阻塞）
    → source = "deterministic"，reason = <分类>
```

> 说明：即使 `deterministicFallbackEnabled=false`，Continue 也必须可用——此时**仍然**产出确定性 Capsule，只是把「期望 API 但被禁用降级」记为显式状态；两者差别在于是否尝试 API 路径，而不是是否可用。

---

## 4. Jev 判定（阶段 1）

### 4.1 API 契约（已确认）

- `POST https://api.typesafe.ai/v1/systemone`
- `Authorization: Bearer <TYPESAFE_API_KEY>`，`Content-Type: application/json`
- 请求：`{ model: "jev-latest", state, questions }`
- `questions`：`map<id, Question>`，`Question = noul | choice | score`；**question id 不发给模型**，instructions 必须自包含。
- 响应：`{ model, answers: { <id>: { type, noul | choice | score, confidence?, probabilities? } }, usage: { input_tokens, output_tokens } }`
- 错误：`401` / `422` / `429` / `529`（429、529 指数退避重试）。

### 4.2 配对与提问

对每个配对（按 `callId`）提两个 `noul` 问题：

| 问题 | 含义 | true 判据 |
| --- | --- | --- |
| `<id>_keep_call` | 这个调用还值得留在 resume 里吗 | 解释了当前状态、带文件路径/命令/必要代码上下文、记录了错误或失败、记录了决定或未完成工作 |
| `<id>_keep_result` | 结果的**完整原文**还必须逐字保留吗 | 是错误/失败、是用户依赖的验证、是必要输出/代码的唯一副本 |

每个问题的 `instructions` 用**结构化对象**内嵌该调用数据（`{ toolCall, question }`），避免索引歧义；`state` 放 `{ goal, recentMessages, toolCalls[] }`（结果截断到 ~600 字符以控 token）。

### 4.3 判定映射（阈值可配，默认 0.5）

```
pinned（最近 N 条 / 首条）        → KEEP_FULL        reason=pinned
isError = true                   → KEEP_FULL        reason=protected_failure   （强制保护）
keepCall ≥ τ 且 keepResult ≥ τ    → KEEP_FULL        reason=kept
keepCall ≥ τ 且 keepResult < τ    → KEEP_CALL_ONLY   reason=result_dropped      （结果截断到 truncateHeadChars）
keepCall < τ                     → DROP             reason=call_dropped        （调用与配对结果一并删除）
```

- `KEEP_FULL`：保留调用 + 完整结果。
- `KEEP_CALL_ONLY`：保留调用，截断结果。
- `DROP`：调用与配对结果**同时**删除（按 `callId` 成对移除，绝不留下孤立结果）。
- 配对完整性是**不变量**：任何输出都必须满足「无孤立 tool_result、无孤立 tool_call」。

### 4.4 强制保护清单（优先级高于 Jev 判定）

以下内容**不得**被 DROP；实现上既是提问判据，也是输出后的硬校验（违反则修正为 KEEP_FULL）：

1. 最近消息（`preserveRecentMessages`，默认 6）
2. 用户需求和纠正（含 `role=user` 且含否定/纠正语义）
3. 已确认决定
4. 后续约束
5. 错误及失败结果（`isError=true`）
6. 未完成工作
7. 文件路径、命令与必要代码上下文

---

## 5. LLM Capsule（阶段 2）

### 5.1 输出 Schema（结构化中文）

```ts
type Fact = { text: string; evidenceIds: string[] };   // 事实必须引用 Evidence ID

type StructuredResumeCapsule = {
  objective: string;          // 目标（中文）
  currentState: string;       // 当前状态
  completed: Fact[];          // 已完成
  decisions: Fact[];          // 已确认决定
  constraints: Fact[];        // 后续约束
  failures: Fact[];           // 错误与失败
  unresolved: Fact[];         // 未完成/未决
  nextActions: string[];      // 下一步动作
  recentFiles: string[];      // 最近涉及的文件
  evidenceRange: { from: string; to: string; count: number; ids: string[] };
};
```

### 5.2 校验（不通过即降级）

1. **Schema 校验**：Zod 严格解析；未知字段拒绝。
2. **Evidence 引用存在性**：`decisions/constraints/failures/unresolved` 中每个 `evidenceIds` 必须 ⊆ 本 Session 已捕获的 Evidence 集合（`evidenceRange.ids`），否则视为「不存在的 Evidence 引用」→ 降级。
3. **token 上限检查**：生成文本的估算 token ≤ `outputTokenBudget`，输入（压缩后内容）估算 token ≤ `inputTokenBudget`，否则降级。
4. **正文不外泄**：Capsule 只写 `runtime_state`；**普通日志只记元数据**（见 §6），不记正文。

### 5.3 提示词要点

- 系统提示：只用压缩后内容作答；事实必须给出 Evidence ID；不得编造。
- 输入：压缩后的事件序列，每个事件带 `evidenceId` 标注（让模型能引用）。
- 输出：严格 JSON（无 markdown 围栏），字段固定。

---

## 6. 派生产物元数据（可删、可重建）

每次生成都记录（写入 Capsule 的 `meta`，不进普通日志正文）：

| 字段 | 含义 |
| --- | --- |
| `evidenceRange` | Evidence 范围（from/to/count/ids） |
| `provider` | `jev` / `llm` / `deterministic` |
| `model` | 如 `jev-1.13.0`、`<llm-model>` |
| `configVersion` | 配置版本号（配置结构变更时递增） |
| `promptSchemaVersion` | Prompt / Schema 版本 |
| `createdAt` | 创建时间 |
| `inputTokens` / `outputTokens` | 输入/输出 token 数 |
| `latencyMs` | 延迟 |

> 派生物可安全删除并从 Evidence 重建；Evidence 本身永不修改。

---

## 7. 降级规则（Continue 永不被阻塞）

触发降级的条件（任一命中 → 使用现有确定性 Capsule）：

| 条件 | 分类码 |
| --- | --- |
| 未配置 API Key（引用为空或 `process.env[ref]` 缺失） | `NO_API_KEY` |
| Jev/LLM 超时 | `TIMEOUT` |
| HTTP 错误（非 429/529，或重试耗尽） | `HTTP_ERROR` |
| 限流（429/529 重试后仍失败） | `RATE_LIMITED` |
| 无效 JSON | `INVALID_JSON` |
| Schema 不合法 | `SCHEMA_INVALID` |
| Evidence 引用不存在 | `EVIDENCE_REF_MISSING` |
| token 超预算 | `TOKEN_BUDGET_EXCEEDED` |
| API 压缩开关关闭 | `DISABLED` |

- Continue 始终返回 `200`；Capsule 的 `source` 字段明确标注 `api` 或 `deterministic`，并携带降级 `reason`（供 UI 显示「当前使用 API 结果 / 确定性降级」）。
- 降级路径**不抛错**、不重试风暴、不写正文日志。

---

## 8. 配置（接入现有 Settings 机制）

新增一个 `compactionConfig` 配置块（存于 settings 的 JSON 列，**无 migration**；或新增 `0015` 列，二选一，实现时定）：

| 配置项 | 类型 | 说明 |
| --- | --- | --- |
| `apiCompactionEnabled` | boolean | API 压缩总开关 |
| `deterministicFallbackEnabled` | boolean | 确定性降级开关 |
| `jevEndpoint` | string | 默认 `https://api.typesafe.ai/v1/systemone` |
| `jevModel` | string | 默认 `jev-latest` |
| `jevApiKeyRef` | string | **环境变量名**（如 `TYPESAFE_API_KEY`），不是密钥本身 |
| `jevTimeoutMs` | number | Jev 超时 |
| `llmEndpoint` | string | OpenAI 兼容 endpoint |
| `llmModel` | string | LLM 模型名 |
| `llmApiKeyRef` | string | **环境变量名**（如 `TEXT_MODEL_API_KEY`） |
| `llmTimeoutMs` | number | LLM 超时 |
| `inputTokenBudget` | number | 输入 token 上限 |
| `outputTokenBudget` | number | 输出 token 上限 |
| `preserveRecentMessages` | number | 最近消息保护条数（默认 6） |
| `keepThreshold` | number | Jev 判定阈值（默认 0.5） |
| `truncateHeadChars` | number | KEEP_CALL_ONLY 结果保留字符数（默认 300） |

### 8.1 密钥安全

- **源码 / Settings / DB / 日志 / 测试快照 / 前端响应**中只出现**环境变量名**（安全引用）。
- 真实密钥只存在于**仓库根 `.env`**（`cp source/.env .env`，已被 `.gitignore` 忽略）。
- 集成层通过 `process.env[jevApiKeyRef]` 取真实值；daemon 启动时用**极小的 `.env` 加载器**（无 dotenv 依赖）注入 `process.env`（仅在变量缺失时填充）。
- 任何日志/错误信息都不得回显密钥；HTTP 响应与前端 DTO 只暴露「是否已配置」布尔值，不暴露值。

---

## 9. 事务与异步边界

- 网络调用（Jev/LLM）**不得**发生在 better-sqlite3 同步事务内。
- 流程：`prepareAgentOutput`（磁盘 blob，事务外）→ **事务外**计算 Capsule（确定性兜底 + 可选 API）→ 打开事务 → 提交 Evidence 行 + 推进 offset + 写 Capsule（`source`/`meta`/`contextText`）→ 提交。
- 因此 `commitRead` 需变为可 `await`（`syncSessionTranscript` 已是 async）。API 调用受 `timeoutMs` 与 `AbortSignal` 约束，避免拖垮同步链路。
- 只在**新批次**（`!prepared.existing`）时重建 Capsule，避免重复批次触发无谓 API 花费。

---

## 10. 测试矩阵（必须覆盖）

| # | 用例 | 类型 |
| --- | --- | --- |
| 1 | Jev + LLM 成功 → `source=api` | mock + 真实 |
| 2 | `KEEP_FULL` | mock |
| 3 | `KEEP_CALL_ONLY`（结果截断） | mock |
| 4 | `DROP`（调用+结果成对删除） | mock |
| 5 | 工具调用与结果保持配对（无孤立） | mock |
| 6 | 关键决定/约束/失败/未完成不丢失 | mock |
| 7 | 无密钥 → `NO_API_KEY` 降级 | mock |
| 8 | 超时 → `TIMEOUT` 降级 | mock |
| 9 | 限流 → `RATE_LIMITED` 降级（含退避） | mock |
| 10 | 服务错误 → `HTTP_ERROR` 降级 | mock |
| 11 | 无效结构化输出 → `SCHEMA_INVALID` 降级 | mock |
| 12 | 不存在的 Evidence 引用 → `EVIDENCE_REF_MISSING` 降级 | mock |
| 13 | 确定性降级产出与 `buildSessionContinuity` 一致 | mock |
| 14 | Continue 不被 API 故障阻塞（仍 200 且带 source） | mock |
| 15 | API Key 不出现在日志与响应 | mock |

---

## 11. 验收指标（脱敏中英混合样本）

- **关键事实丢失率**：保护清单 7 类事实在压缩后仍可追溯的比例（目标 100%）。
- **压缩率**：`1 - charsAfter/charsBefore`（工具结果维度）。
- **API 延迟**：Jev / LLM 各自 P50。
- **token 消耗**：input/output。
- **单次会话费用估算**：`tokens × 单价`（单价未提供时，报告以 token 计量并标注假设）。

> 首次真实探针（`scripts/jev-compaction-probe.ts`，2026-09-22）：模型 `jev-1.13.0`，延迟 1981ms，2894 in / 194 out；`DROP` 命中过时 `grep`，失败 `run_tests` 受保护，`apply_patch` 判 `KEEP_CALL_ONLY`。

---

## 12. 验证分层（最终报告必须区分）

1. **mock 验证**：用受控 provider/transport，覆盖 §10 全矩阵。
2. **真实 API 验证**：真实 Jev + LLM 至少各一次（临时 Session，不碰用户库）。
3. **确定性降级验证**：断网/无密钥/注入故障下 Continue 仍可用。
4. **未完成 / 外部阻塞**：明确列出（如 LLM 单价未知导致费用只能给 token 计量）。

---

## 13. 风险

| 风险 | 缓解 |
| --- | --- |
| API 延迟拖慢同步链路 | 事务外调用 + `timeoutMs` + `AbortSignal` + 仅新批次重建 |
| token 超预算 | 输入截断 + `inputTokenBudget` 预检 + 超限降级 |
| Evidence 引用幻觉 | 输出后按 Session Evidence 集合硬校验，缺失即降级 |
| 配对破坏 | `callId` 成对移除 + 输出后不变量断言 |
| 密钥泄露 | 只存环境变量名；`.env` gitignored；日志/响应脱敏 |
| 成本失控 | 开关 + 预算 + 阈值；降级不重试风暴 |

---

## 14. 落地顺序

1. 契约与接口（`packages/contracts`、`packages/application/src/ports`）。
2. `DeterministicCompactionProvider` / `DeterministicCapsuleGenerator`（薄包装，先保证降级可用）。
3. `JevCompactionProvider`（真实 API，含退避/超时）。
4. `ResumeCapsuleGenerator`（LLM，含 schema + evidence 引用 + token 校验）。
5. `ApiCompactionCoordinator` + Settings 接入 + `.env` 加载器。
6. 接入 `AutomationService.commitRead` 与 Capsule DTO 扩展（`source`/`structured`/`meta`）。
7. 测试矩阵 + 构建 + E2E + 真实 API 验收。

---

## 15. 实现记录与验收（2026-09-22）

### 15.1 与设计稿的差异（实现时收敛）

| 项 | 设计稿 | 实现 |
| --- | --- | --- |
| 配置存储 | JSON 列或新增 0015 | **新增 migration `0015_compaction_config.sql`**：`settings.compaction_config_json`（非密钥 JSON）。未触碰 0012/0013/0014。 |
| 密钥存储 | secret store 或 env | **`<dataDir>/compaction-secrets.json`**（本机 local-only，best-effort 0600；`dataDir` 默认 `.contextos/` 已被 `.gitignore` 忽略），并支持按**环境变量名**回退（`.env`）。真实密钥永不进 DB/日志/响应/测试快照。 |
| 事务边界 | 事务内写 Capsule | **两段式**：事务内仍写确定性 Capsule（原子安全网，Evidence+offset+Capsule 一致）；提交后在新批次出现时运行编排器，把 `source`/`structured`/`meta`/`degradationReason` 回写。API 失败只保留确定性 Capsule。 |
| LLM `reasoning` | 直接透传 | 网关对 `reasoning: "none"` 返回 400，故**仅在解析为 JSON 对象时才发送**，空/`none`/非法值一律省略（避免无谓降级）。 |

### 15.2 交付物

- 契约：`packages/contracts/src/semantic-compaction.ts`（配置 DTO/Patch、结构化 Capsule、元数据、降级原因、来源枚举）；`runtime.ts`/`sessions.ts` 扩展。
- 端口：`packages/application/src/ports/semantic-compaction.ts`（4 个接口）。
- 实现：`packages/application/src/core/semantic-compaction/`（`jev-compaction-provider`、`llm-resume-capsule-generator`、`deterministic-compaction-provider`、`deterministic-capsule-generator`、`coordinator`、`config`、`transcript-pairs`、`meta`、`errors`）。
- 密钥存储：`packages/infrastructure/src/compaction/compaction-secret-store.ts`。
- 接入：`SettingsService`（get/patch/resolve）、`AutomationService.applySemanticCapsule`、`bootstrap.ts`。
- 前端：`frontend/src/semanticCompaction.ts` + `frontend/src/components/SemanticCompactionSettings.tsx`；会话详情显示 `Capsule 来源`。
- 脚本：`scripts/smoke-semantic-compaction.ts`。

### 15.3 验收结果

- 单测/集成：`semantic-compaction.test.ts`（13）、`semantic-compaction-sync.test.ts`（3）、`compaction-settings-api.test.ts`（6）、`semantic-compaction-frontend.test.ts`（3）全通过。
- 全量 `vitest`：除既有并行抖动 `transcript-import-api.test.ts`（单跑通过）外全通过；`sqlite-migration.test.ts` 已随 0015 更新为 15。
- **真实 Jev API 验证**：通过产品编排器（真实 Jev + mock LLM）得到 `source=api`，判定 `c1 KEEP_FULL / c2 KEEP_FULL（错误保护）/ c3 DROP / c4 KEEP_CALL_ONLY`，模型 `jev-1.13.0`，延迟 443ms，token 1871/156，Capsule 10 字段齐全。
- **真实 LLM API 验证：未通过（外部阻塞）**。Vercel AI Gateway 返回 `403 customer_verification_required`（需绑定信用卡）；同一次运行中 `realBoth` 正确降级为 `deterministic / HTTP_ERROR`，证明 Continue 不被外部故障阻塞。
- **确定性降级验证**：无密钥 / 禁用 / 超时 / 429 / HTTP 错误 / 无效 JSON / Schema 非法 / Evidence 引用不存在，均降级且 `contextText` 非空。
