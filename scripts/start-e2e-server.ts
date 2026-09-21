import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonServer } from "../apps/daemon/src/bootstrap.js";
import type { ContextExtractor } from "../packages/application/src/ports/context-extractor.js";

const dataDir = await mkdtemp(join(tmpdir(), "contextos-e2e-"));
process.env.CONTEXTOS_CODEX_COMMAND = process.execPath;
process.env.CONTEXTOS_CODEX_ARGS = JSON.stringify(["-e", "process.exit(2)"]);

/**
 * 受控自动化 fixture。
 *
 * 只有在显式设置了 CONTEXTOS_E2E_AUTOMATION_FIXTURE=1 时才会安装；未设置时生产行为完全不变。
 * 它只替换“提取器”这一个环节，候选仍要经过真实的 ExtractionService、CandidateApplicationService、
 * SQLite 与 API，不会绕过任何持久化或审核逻辑。
 *
 * 输出固定，便于界面断言：
 * - 一条恢复摘要；
 * - 一条高置信度摘要类上下文条目（可自动接受）；
 * - 一条事实类条目（必须送审）；
 * - 一条风险类条目（用于拒绝与重新提取）。
 */
const automationFixtureEnabled = process.env.CONTEXTOS_E2E_AUTOMATION_FIXTURE === "1";

const fixtureExtractor: ContextExtractor | undefined = automationFixtureEnabled
  ? {
      id: "e2e-fixture-extractor",
      version: "e2e.v1",
      async extract(input) {
        const evidenceId = input.identity.sourceEvidenceId;
        return {
          extractorId: "e2e-fixture-extractor",
          extractorVersion: "e2e.v1",
          resumeCapsule: { summary: "受控恢复摘要：已完成同步与压缩。", nextAction: "批准下一条提取建议。" },
          candidates: [
            {
              itemType: "SUMMARY",
              title: "受控高置信度摘要条目",
              summary: "由端到端 fixture 生成的摘要条目。",
              body: "摘要正文。",
              confidence: 0.96,
              evidenceIds: [evidenceId],
              explanation: "端到端 fixture 说明。",
              fingerprint: "sha256:fixture-summary"
            },
            {
              itemType: "FACT",
              title: "受控事实条目",
              summary: "由端到端 fixture 生成的事实条目。",
              body: "事实正文。",
              confidence: 0.5,
              evidenceIds: [evidenceId],
              explanation: "用于验证仍需人工审核。",
              fingerprint: "sha256:fixture-fact"
            },
            {
              itemType: "RISK",
              title: "受控风险条目",
              summary: "由端到端 fixture 生成的风险条目。",
              body: "风险正文。",
              confidence: 0.4,
              evidenceIds: [evidenceId],
              explanation: "用于验证拒绝与重新提取。",
              fingerprint: "sha256:fixture-risk"
            }
          ],
          stats: { inputItems: input.transcript.length, inputChars: 0, candidateCount: 3, durationMs: 1 }
        };
      }
    }
  : undefined;

const server = await createDaemonServer({
  ...(fixtureExtractor ? { contextExtractor: fixtureExtractor } : {}),
  config: {
    host: "127.0.0.1",
    port: 4722,
    dataDir,
    databaseFile: join(dataDir, "contextos.sqlite")
  }
});

if (automationFixtureEnabled) {
  console.log("automation e2e fixture enabled: deterministic extractor installed");
}

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await server.listen({ host: "127.0.0.1", port: 4722 });
