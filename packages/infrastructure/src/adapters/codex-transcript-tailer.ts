import { statSync, readSync, openSync, closeSync } from "node:fs";

export type CodexTranscriptTailRow = {
  ordinal: number | null;
  byteStart: number;
  byteEnd: number;
  line: string;
  json: unknown | null;
  parseError: string | null;
};

export type CodexTranscriptTailResult = {
  path: string;
  previousOffset: number;
  nextOffset: number;
  fileSize: number;
  rows: CodexTranscriptTailRow[];
  partialLine: boolean;
  resetReason: "offset_beyond_eof" | null;
};

export class CodexTranscriptTailer {
  read(input: { path: string; offset?: number; maxBytes?: number }): CodexTranscriptTailResult {
    const file = statSync(input.path);
    const previousOffset = Math.max(0, input.offset ?? 0);
    const resetReason = previousOffset > file.size ? "offset_beyond_eof" : null;
    const offset = resetReason ? 0 : previousOffset;
    const maxBytes = Math.max(0, input.maxBytes ?? file.size - offset);
    const bytesToRead = Math.min(file.size - offset, maxBytes);

    if (bytesToRead <= 0) {
      return {
        path: input.path,
        previousOffset,
        nextOffset: offset,
        fileSize: file.size,
        rows: [],
        partialLine: false,
        resetReason
      };
    }

    const buffer = Buffer.alloc(bytesToRead);
    const fd = openSync(input.path, "r");
    try {
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
      return parseTailBuffer({
        path: input.path,
        buffer: buffer.subarray(0, bytesRead),
        previousOffset,
        offset,
        fileSize: file.size,
        resetReason
      });
    } finally {
      closeSync(fd);
    }
  }
}

function parseTailBuffer(input: {
  path: string;
  buffer: Buffer;
  previousOffset: number;
  offset: number;
  fileSize: number;
  resetReason: "offset_beyond_eof" | null;
}): CodexTranscriptTailResult {
  const rows: CodexTranscriptTailRow[] = [];
  let cursor = 0;
  let nextOffset = input.offset;

  while (cursor < input.buffer.length) {
    const newline = input.buffer.indexOf(10, cursor);
    if (newline === -1) break;

    const rawLine = input.buffer.subarray(cursor, newline);
    const line = rawLine.toString("utf8").replace(/\r$/, "");
    const byteStart = input.offset + cursor;
    const byteEnd = input.offset + newline + 1;
    cursor = newline + 1;
    nextOffset = byteEnd;

    if (!line.trim()) continue;

    let json: unknown | null = null;
    let parseError: string | null = null;
    let ordinal: number | null = null;
    try {
      json = JSON.parse(line) as unknown;
      if (json && typeof json === "object" && "ordinal" in json) {
        const value = (json as { ordinal?: unknown }).ordinal;
        ordinal = typeof value === "number" ? value : null;
      }
    } catch (error) {
      parseError = error instanceof Error ? error.message : "Invalid JSONL row";
    }

    rows.push({ ordinal, byteStart, byteEnd, line, json, parseError });
  }

  return {
    path: input.path,
    previousOffset: input.previousOffset,
    nextOffset,
    fileSize: input.fileSize,
    rows,
    partialLine: cursor < input.buffer.length,
    resetReason: input.resetReason
  };
}
