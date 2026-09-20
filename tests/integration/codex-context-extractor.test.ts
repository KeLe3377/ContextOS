import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtractionInput } from "../../packages/application/src/ports/context-extractor.js";
import {
  CodexContextExtractor,
  extractionRunsRoot,
  type ExtractionSpawn
} from "../../packages/infrastructure/src/extraction/codex-context-extractor.js";

const sourceEvidenceId = "ev_source";
const artifactId = "cmp_1";

let tempDir: string;

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

type SpawnCall = { command: string; args: string[]; cwd: string; shell: boolean; detached: boolean };

/** A fake process seam: it records how it was spawned and lets the test decide what it produces. */
function fakeProcess(options: {
  onRun?: (context: { cwd: string; args: string[]; child: FakeChild }) => void;
  exitCode?: number | null;
  spawnError?: boolean;
} = {}) {
  const calls: SpawnCall[] = [];
  const state = { holdOpen: false, kills: 0 };

  const spawn: ExtractionSpawn = (command, args, spawnOptions) => {
    const child = new FakeChild();
    calls.push({
      command,
      args: [...args],
      cwd: spawnOptions.cwd,
      shell: spawnOptions.shell,
      detached: spawnOptions.detached
    });

    setImmediate(() => {
      if (options.spawnError) {
        child.emit("error", new Error("spawn failed"));
        return;
      }
      options.onRun?.({ cwd: spawnOptions.cwd, args: [...args], child });
      if (!state.holdOpen && !child.killed) child.emit("close", options.exitCode ?? 0);
    });

    return child as unknown as ChildProcess;
  };

  return {
    spawn,
    calls,
    state,
    killTree: () => {
      state.kills += 1;
    }
  };
}

function extractionInput(overrides: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    identity: {
      projectId: "proj_1",
      sessionId: "sess_1",
      artifactId,
      sourceEvidenceId,
      sourceContentHash: "sha256:source",
      compactionProviderId: "deterministic",
      compactionProviderVersion: "v1",
      sanitizerVersion: "v1"
    },
    projectIntent: "ship the pipeline",
    sessionIntent: "wire the extractor",
    transcript: [
      { ordinal: 1, kind: "message", role: "user", name: null, text: "please wire the extractor", truncated: false }
    ],
    knownCandidateFingerprints: [],
    limits: { maxChars: 10_000, maxItems: 100, maxItemChars: 2_000 },
    ...overrides
  };
}

function modelOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    resumeCapsule: { summary: "Worked on the extractor.", nextAction: "Register the handler." },
    contextItems: [
      {
        itemType: "FACT",
        title: "Extraction reads compaction artifacts",
        summary: "Extraction consumes the artifact rather than raw Evidence.",
        body: "The extractor is fed a bounded input derived from a compaction artifact.",
        confidence: 0.8,
        evidenceIds: [sourceEvidenceId],
        fingerprintMaterial: "  Extraction reads compaction artifacts  ",
        explanation: "Stated directly in the transcript."
      }
    ],
    ...overrides
  });
}

function extractor(process: ReturnType<typeof fakeProcess>, overrides: Record<string, unknown> = {}) {
  return new CodexContextExtractor({
    dataDir: tempDir,
    command: "codex",
    spawn: process.spawn,
    killTree: process.killTree,
    ...overrides
  });
}

function runDir(): string {
  return join(extractionRunsRoot(tempDir), artifactId);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "contextos-extractor-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("codex context extractor isolation", () => {
  test("spawns an argv array without a shell, from an isolated run workspace", async () => {
    const process = fakeProcess({
      onRun: ({ cwd }) => writeFileSync(join(cwd, "output.json"), modelOutput(), "utf8")
    });

    await extractor(process).extract(extractionInput());

    expect(process.calls).toHaveLength(1);
    const call = process.calls[0]!;
    expect(call.command).toBe("codex");
    expect(call.shell).toBe(false);
    expect(call.args[0]).toBe("exec");
    expect(call.args).toHaveLength(2);
    expect(call.cwd).toBe(runDir());
    expect(call.cwd.startsWith(extractionRunsRoot(tempDir))).toBe(true);
  });

  test("writes the bounded input to input.json inside the run workspace", async () => {
    let captured = "";
    const process = fakeProcess({
      onRun: ({ cwd }) => {
        captured = readFileSync(join(cwd, "input.json"), "utf8");
        writeFileSync(join(cwd, "output.json"), modelOutput(), "utf8");
      }
    });

    await extractor(process).extract(extractionInput());

    const parsed = JSON.parse(captured) as ExtractionInput;
    expect(parsed.identity.sourceEvidenceId).toBe(sourceEvidenceId);
    expect(parsed.transcript).toHaveLength(1);
    expect(captured).not.toContain("storageRef");
  });
});

describe("codex context extractor output", () => {
  test("returns candidates with a locally computed fingerprint", async () => {
    const process = fakeProcess({
      onRun: ({ cwd }) => writeFileSync(join(cwd, "output.json"), modelOutput(), "utf8")
    });

    const result = await extractor(process).extract(extractionInput());

    expect(result.extractorId).toBe("codex-cli");
    expect(result.resumeCapsule).toEqual({ summary: "Worked on the extractor.", nextAction: "Register the handler." });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      itemType: "FACT",
      confidence: 0.8,
      evidenceIds: [sourceEvidenceId]
    });
    expect(result.candidates[0]!.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.candidates[0]).not.toHaveProperty("fingerprintMaterial");
    expect(result.stats).toMatchObject({ inputItems: 1, candidateCount: 1 });
  });

  test("computes the same fingerprint regardless of whitespace in the material", async () => {
    const build = (material: string) => {
      const process = fakeProcess({
        onRun: ({ cwd }) => writeFileSync(join(cwd, "output.json"), modelOutput({
          contextItems: [{ ...JSON.parse(modelOutput()).contextItems[0], fingerprintMaterial: material }]
        }), "utf8")
      });
      return extractor(process).extract(extractionInput());
    };

    const first = await build("extraction reads compaction artifacts");
    const second = await build("  extraction   reads compaction artifacts  ");

    expect(second.candidates[0]!.fingerprint).toBe(first.candidates[0]!.fingerprint);
  });

  test("falls back to bounded stdout when there is no output file", async () => {
    const process = fakeProcess({
      onRun: ({ child }) => child.stdout.emit("data", Buffer.from(`\`\`\`json\n${modelOutput()}\n\`\`\``, "utf8"))
    });

    const result = await extractor(process).extract(extractionInput());

    expect(result.candidates).toHaveLength(1);
  });
});

describe("codex context extractor failures", () => {
  test("reports an unavailable command", async () => {
    const process = fakeProcess({ spawnError: true });

    await expect(extractor(process).extract(extractionInput())).rejects.toMatchObject({ code: "EXTRACTOR_UNAVAILABLE" });
  });

  test("kills the process tree and reports a timeout", async () => {
    const process = fakeProcess();
    process.state.holdOpen = true;

    await expect(extractor(process, { timeoutMs: 10 }).extract(extractionInput()))
      .rejects.toMatchObject({ code: "EXTRACTOR_TIMEOUT" });

    expect(process.state.kills).toBe(1);
  });

  test("reports a non-zero exit", async () => {
    const process = fakeProcess({ exitCode: 3 });

    await expect(extractor(process).extract(extractionInput()))
      .rejects.toMatchObject({ code: "EXTRACTOR_EXIT_NONZERO" });
  });

  test("stops when stdout exceeds its bound", async () => {
    const process = fakeProcess({
      onRun: ({ child }) => child.stdout.emit("data", Buffer.from("x".repeat(500), "utf8"))
    });

    await expect(extractor(process, { maxStdoutBytes: 100 }).extract(extractionInput()))
      .rejects.toMatchObject({ code: "EXTRACTOR_STDOUT_LIMIT" });
    expect(process.state.kills).toBe(1);
  });

  test("stops when the output file exceeds its bound", async () => {
    const process = fakeProcess({
      onRun: ({ cwd }) => writeFileSync(join(cwd, "output.json"), "y".repeat(500), "utf8")
    });

    await expect(extractor(process, { maxOutputBytes: 100 }).extract(extractionInput()))
      .rejects.toMatchObject({ code: "EXTRACTOR_STDOUT_LIMIT" });
  });

  test("rejects output that is not JSON", async () => {
    const process = fakeProcess({
      onRun: ({ cwd }) => writeFileSync(join(cwd, "output.json"), "I could not do that.", "utf8")
    });

    await expect(extractor(process).extract(extractionInput()))
      .rejects.toMatchObject({ code: "EXTRACTOR_OUTPUT_NOT_JSON" });
  });

  test("rejects output with an extra field", async () => {
    const process = fakeProcess({
      onRun: ({ cwd }) => {
        const output = JSON.parse(modelOutput()) as Record<string, unknown>;
        writeFileSync(join(cwd, "output.json"), JSON.stringify({ ...output, fingerprint: "sha256:model-chosen" }), "utf8");
      }
    });

    await expect(extractor(process).extract(extractionInput()))
      .rejects.toMatchObject({ code: "EXTRACTOR_OUTPUT_SCHEMA_INVALID" });
  });

  test("rejects output that violates the schema", async () => {
    const process = fakeProcess({
      onRun: ({ cwd }) => writeFileSync(join(cwd, "output.json"), modelOutput({
        contextItems: [{ itemType: "RULE", title: "no", summary: "no", body: "no", confidence: 2, evidenceIds: [], fingerprintMaterial: "x", explanation: "y" }]
      }), "utf8")
    });

    await expect(extractor(process).extract(extractionInput()))
      .rejects.toMatchObject({ code: "EXTRACTOR_OUTPUT_SCHEMA_INVALID" });
  });

  test("rejects a candidate that does not cite the source Evidence", async () => {
    const process = fakeProcess({
      onRun: ({ cwd }) => {
        const output = JSON.parse(modelOutput()) as { contextItems: Array<Record<string, unknown>> };
        output.contextItems[0]!.evidenceIds = ["ev_somewhere_else"];
        writeFileSync(join(cwd, "output.json"), JSON.stringify(output), "utf8");
      }
    });

    await expect(extractor(process).extract(extractionInput()))
      .rejects.toMatchObject({ code: "EXTRACTOR_EVIDENCE_IDS_INVALID" });
  });

  test("rejects a candidate that cites Evidence beyond this run", async () => {
    const process = fakeProcess({
      onRun: ({ cwd }) => {
        const output = JSON.parse(modelOutput()) as { contextItems: Array<Record<string, unknown>> };
        output.contextItems[0]!.evidenceIds = [sourceEvidenceId, "ev_other"];
        writeFileSync(join(cwd, "output.json"), JSON.stringify(output), "utf8");
      }
    });

    await expect(extractor(process).extract(extractionInput()))
      .rejects.toMatchObject({ code: "EXTRACTOR_EVIDENCE_IDS_INVALID" });
  });
});

describe("codex context extractor cleanup", () => {
  test("removes the body files and keeps a content-free manifest", async () => {
    const process = fakeProcess({
      onRun: ({ cwd }) => writeFileSync(join(cwd, "output.json"), modelOutput(), "utf8")
    });

    await extractor(process).extract(extractionInput());

    expect(existsSync(join(runDir(), "input.json"))).toBe(false);
    expect(existsSync(join(runDir(), "output.json"))).toBe(false);

    const manifest = readFileSync(join(runDir(), "manifest.json"), "utf8");
    const parsed = JSON.parse(manifest) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      artifactId,
      sourceEvidenceId,
      inputItems: 1,
      failureCode: null
    });
    expect(parsed.inputSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest).not.toContain("please wire the extractor");
    expect(manifest).not.toContain("Worked on the extractor");
  });

  test("removes the body files and records the failure code when the run fails", async () => {
    const process = fakeProcess({ exitCode: 9 });

    await expect(extractor(process).extract(extractionInput())).rejects.toMatchObject({ code: "EXTRACTOR_EXIT_NONZERO" });

    expect(existsSync(join(runDir(), "input.json"))).toBe(false);
    const parsed = JSON.parse(readFileSync(join(runDir(), "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(parsed.failureCode).toBe("EXTRACTOR_EXIT_NONZERO");
  });

  test("keeps the run workspace outside any registered project root", async () => {
    const process = fakeProcess({
      onRun: ({ cwd }) => writeFileSync(join(cwd, "output.json"), modelOutput(), "utf8")
    });

    await extractor(process).extract(extractionInput());

    // The workspace is under the data directory, and the discovery matcher is told to ignore
    // that root, so an extraction run can never be attributed to a business Project.
    expect(runDir().startsWith(join(tempDir, "runs", "extraction"))).toBe(true);
    expect(extractionRunsRoot(tempDir)).toBe(join(tempDir, "runs", "extraction"));
  });
});
