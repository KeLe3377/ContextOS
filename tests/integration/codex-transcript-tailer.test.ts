import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodexTranscriptTailer } from "../../packages/infrastructure/src/adapters/codex-transcript-tailer.js";

describe("CodexTranscriptTailer", () => {
  test("reads only complete appended JSONL rows and advances by byte offset", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "contextos-codex-tail-"));
    try {
      const path = join(tempDir, "rollout.jsonl");
      await writeFile(path, `${JSON.stringify({ ordinal: 1, type: "session_meta" })}\n`, "utf8");
      const tailer = new CodexTranscriptTailer();

      const first = tailer.read({ path });
      expect(first).toMatchObject({
        previousOffset: 0,
        rows: [expect.objectContaining({ ordinal: 1, parseError: null })],
        partialLine: false,
        resetReason: null
      });
      expect(first.nextOffset).toBeGreaterThan(0);

      await appendFile(path, `${JSON.stringify({ ordinal: 2, type: "response_item" })}\n{"ordinal":3`, "utf8");
      const second = tailer.read({ path, offset: first.nextOffset });
      expect(second.rows).toEqual([
        expect.objectContaining({ ordinal: 2, parseError: null })
      ]);
      expect(second.partialLine).toBe(true);

      await appendFile(path, `,"type":"response_item"}\n`, "utf8");
      const third = tailer.read({ path, offset: second.nextOffset });
      expect(third.rows).toEqual([
        expect.objectContaining({ ordinal: 3, parseError: null })
      ]);
      expect(third.partialLine).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("resets when the stored offset is beyond the current file size", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "contextos-codex-tail-reset-"));
    try {
      const path = join(tempDir, "rollout.jsonl");
      await writeFile(path, `${JSON.stringify({ ordinal: 1 })}\n${JSON.stringify({ ordinal: 2 })}\n`, "utf8");
      const tailer = new CodexTranscriptTailer();
      const first = tailer.read({ path });

      await truncate(path, 0);
      await appendFile(path, `${JSON.stringify({ ordinal: 10 })}\n`, "utf8");
      const reset = tailer.read({ path, offset: first.nextOffset });

      expect(reset.resetReason).toBe("offset_beyond_eof");
      expect(reset.previousOffset).toBe(first.nextOffset);
      expect(reset.rows).toEqual([expect.objectContaining({ ordinal: 10 })]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps malformed complete rows visible without blocking later rows", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "contextos-codex-tail-malformed-"));
    try {
      const path = join(tempDir, "rollout.jsonl");
      await writeFile(path, `{"ordinal":1}\n{bad json}\n{"ordinal":2}\n`, "utf8");
      const result = new CodexTranscriptTailer().read({ path });

      expect(result.rows).toHaveLength(3);
      expect(result.rows[1]).toMatchObject({ json: null, ordinal: null });
      expect(result.rows[1].parseError).toContain("JSON");
      expect(result.rows[2]).toMatchObject({ ordinal: 2, parseError: null });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
