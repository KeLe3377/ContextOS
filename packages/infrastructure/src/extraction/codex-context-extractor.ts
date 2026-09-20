import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { extractionOutputSchema, type ExtractionContextItem, type ExtractionOutput } from "../../../contracts/src/extraction.js";
import {
  ExtractionError,
  computeCandidateFingerprint,
  type ContextExtractor,
  type ExtractionCandidate,
  type ExtractionInput,
  type ExtractionResult
} from "../../../application/src/ports/context-extractor.js";

/**
 * Extracts structured context by running the local Codex CLI in a throwaway workspace.
 *
 * The isolation rules are the point of this class:
 * - the run happens under `<dataDir>/runs/extraction/<artifactId>/`, never inside a registered
 *   Project root, so the agent's own rollout for the run cannot be mistaken for project work;
 * - the prompt travels as one argv element and the payload as `input.json` — never through a
 *   shell;
 * - stdout, stderr and the output file are bounded, and a timeout kills the whole process tree;
 * - the input and output files, which hold transcript text and model output, are removed in
 *   `finally`; only a manifest of hashes, counts, duration and failure code is kept;
 * - nothing here logs the prompt, the model output, user messages or any credential.
 *
 * Design: docs/2026-09-20-contextos-jev-compaction-integration-design.md §12
 */

export const codexContextExtractorId = "codex-cli";
export const codexContextExtractorVersion = "contextos-codex-extractor.v1";

/** Root of every extraction run workspace. Discovery must treat anything under it as plumbing. */
export function extractionRunsRoot(dataDir: string): string {
  return join(dataDir, "runs", "extraction");
}

export type ExtractionSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; shell: false; windowsHide: boolean; detached: boolean }
) => ChildProcess;

export type CodexContextExtractorOptions = {
  dataDir: string;
  command?: string;
  /** Arguments placed before the prompt; the prompt is always appended as its own element. */
  args?: readonly string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxOutputBytes?: number;
  /** Test seams. */
  spawn?: ExtractionSpawn;
  killTree?: (child: ChildProcess) => void;
  now?: () => number;
};

const defaultTimeoutMs = 120_000;
const defaultMaxStdoutBytes = 256 * 1024;
const defaultMaxStderrBytes = 64 * 1024;
const defaultMaxOutputBytes = 512 * 1024;

const promptTemplate = [
  "You extract durable project context from one agent transcript.",
  "",
  "Read ./input.json. It holds a bounded transcript plus the project and session intent.",
  "Write ./output.json with exactly this shape and no additional fields:",
  '{"resumeCapsule":{"summary":string,"nextAction":string},"contextItems":[{"itemType":"FACT"|"SUMMARY"|"CONSTRAINT"|"OPEN_QUESTION"|"RISK"|"HANDOFF","title":string,"summary":string,"body":string,"confidence":number,"evidenceIds":string[],"fingerprintMaterial":string,"explanation":string}]}',
  "",
  "Rules:",
  "- Every contextItems[].evidenceIds must contain the source evidence id from input.json.",
  "- Do not invent decisions, work items or rules.",
  "- Do not summarise tool output that is not in input.json.",
  "- Answer with JSON only."
].join("\n");

export class CodexContextExtractor implements ContextExtractor {
  readonly id = codexContextExtractorId;
  readonly version = codexContextExtractorVersion;

  private readonly dataDir: string;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly maxOutputBytes: number;
  private readonly spawn: ExtractionSpawn;
  private readonly killTree: (child: ChildProcess) => void;
  private readonly now: () => number;

  constructor(options: CodexContextExtractorOptions) {
    this.dataDir = options.dataDir;
    this.command = options.command ?? process.env.CONTEXTOS_CODEX_COMMAND ?? "codex";
    this.args = options.args ?? ["exec"];
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.maxStdoutBytes = options.maxStdoutBytes ?? defaultMaxStdoutBytes;
    this.maxStderrBytes = options.maxStderrBytes ?? defaultMaxStderrBytes;
    this.maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
    this.spawn = options.spawn ?? spawn;
    this.killTree = options.killTree ?? killProcessTree;
    this.now = options.now ?? (() => Date.now());
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const startedAt = this.now();
    const runDir = join(extractionRunsRoot(this.dataDir), runDirectoryName(input.identity.artifactId));
    const inputPath = join(runDir, "input.json");
    const outputPath = join(runDir, "output.json");

    mkdirSync(runDir, { recursive: true });
    const inputJson = JSON.stringify(input);
    writeFileSync(inputPath, inputJson, { encoding: "utf8", mode: 0o600 });

    let failureCode: string | null = null;
    try {
      const run = await this.runProcess({ cwd: runDir, prompt: promptTemplate });
      const rawOutput = this.readOutput(outputPath, run.stdout);
      const parsed = parseOutputJson(rawOutput);
      const candidates = toCandidates(parsed.contextItems, input);

      return {
        extractorId: this.id,
        extractorVersion: this.version,
        resumeCapsule: parsed.resumeCapsule,
        candidates,
        stats: {
          inputItems: input.transcript.length,
          inputChars: input.transcript.reduce((sum, item) => sum + item.text.length, 0),
          candidateCount: candidates.length,
          durationMs: this.now() - startedAt
        }
      };
    } catch (error) {
      failureCode = error instanceof ExtractionError ? error.code : "EXTRACTOR_RUN_FAILED";
      throw error;
    } finally {
      // The body files are the sensitive part; the manifest is not.
      rmSync(inputPath, { force: true });
      rmSync(outputPath, { force: true });
      writeManifest(join(runDir, "manifest.json"), {
        artifactId: input.identity.artifactId,
        sourceEvidenceId: input.identity.sourceEvidenceId,
        inputSha256: sha256(inputJson),
        inputChars: inputJson.length,
        inputItems: input.transcript.length,
        durationMs: this.now() - startedAt,
        failureCode
      });
    }
  }

  /**
   * Reads the model's answer, preferring the output file and falling back to bounded stdout.
   */
  private readOutput(outputPath: string, stdout: string): string {
    if (!existsSync(outputPath)) return stdout;
    const size = statSync(outputPath).size;
    if (size > this.maxOutputBytes) {
      throw new ExtractionError("EXTRACTOR_STDOUT_LIMIT", "Extractor output exceeded the size limit");
    }
    return readFileSync(outputPath, "utf8");
  }

  private runProcess(input: { cwd: string; prompt: string }): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const child = this.spawn(this.command, [...this.args, input.prompt], {
        cwd: input.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32"
      });

      const finish = (work: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        work();
      };

      const abort = (error: ExtractionError): void => {
        finish(() => {
          try {
            this.killTree(child);
          } catch {
            // Killing is best effort; the failure below is what the caller must see.
          }
          reject(error);
        });
      };

      const timer = setTimeout(() => {
        abort(new ExtractionError("EXTRACTOR_TIMEOUT", "Extractor run exceeded its time limit"));
      }, this.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > this.maxStdoutBytes) {
          abort(new ExtractionError("EXTRACTOR_STDOUT_LIMIT", "Extractor wrote more than the allowed stdout"));
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > this.maxStderrBytes) {
          abort(new ExtractionError("EXTRACTOR_STDOUT_LIMIT", "Extractor wrote more than the allowed stderr"));
          return;
        }
        stderr += chunk.toString("utf8");
      });

      child.once("error", () => {
        abort(new ExtractionError("EXTRACTOR_UNAVAILABLE", "Extractor command could not be started"));
      });
      child.once("close", (code: number | null) => {
        finish(() => {
          if (code === 0) resolve({ stdout, stderr, code });
          else reject(new ExtractionError("EXTRACTOR_EXIT_NONZERO", `Extractor exited with code ${code ?? "unknown"}`));
        });
      });
    });
  }
}

function parseOutputJson(raw: string): ExtractionOutput {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new ExtractionError("EXTRACTOR_OUTPUT_NOT_JSON", "Extractor did not return a JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
  } catch {
    throw new ExtractionError("EXTRACTOR_OUTPUT_NOT_JSON", "Extractor did not return valid JSON");
  }

  const result = extractionOutputSchema.safeParse(parsed);
  if (!result.success) {
    // The issues can quote model output, so only the stable code travels onward.
    throw new ExtractionError("EXTRACTOR_OUTPUT_SCHEMA_INVALID", "Extractor output did not match the required schema");
  }
  return result.data;
}

function toCandidates(items: readonly ExtractionContextItem[], input: ExtractionInput): ExtractionCandidate[] {
  const sourceEvidenceId = input.identity.sourceEvidenceId;

  for (const item of items) {
    if (!item.evidenceIds.includes(sourceEvidenceId)) {
      throw new ExtractionError("EXTRACTOR_EVIDENCE_IDS_INVALID", "A candidate did not cite the source Evidence");
    }
    for (const evidenceId of item.evidenceIds) {
      if (evidenceId !== sourceEvidenceId) {
        throw new ExtractionError("EXTRACTOR_EVIDENCE_IDS_INVALID", "A candidate cited Evidence outside this run");
      }
    }
  }

  return items.map((item) => {
    const { fingerprintMaterial, ...rest } = item;
    return { ...rest, fingerprint: computeCandidateFingerprint(fingerprintMaterial) };
  });
}

function runDirectoryName(artifactId: string): string {
  return artifactId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function writeManifest(path: string, manifest: Record<string, unknown>): void {
  try {
    writeFileSync(path, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
  } catch {
    // A manifest that cannot be written must not turn a successful extraction into a failure.
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Kills the whole tree: a bare `child.kill()` leaves grandchildren running on Windows. */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
