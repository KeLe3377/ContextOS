import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Local-only store for the semantic-compaction API keys.
 *
 * The keys never enter the database, a log line, an HTTP response or a test snapshot. They live
 * in a single JSON file under the daemon data directory (`.contextos/`, already gitignored), and
 * the settings row only ever records a `keyConfigured` flag plus a masked hint.
 *
 * The file is best-effort `0600`. On Windows the ACL model ignores the mode, which is why the
 * path is also excluded from sync and export at the product level rather than relying on it.
 */
export type CompactionSecrets = {
  jevApiKey?: string;
  llmApiKey?: string;
};

export type CompactionSecretsPatch = {
  /** `undefined` leaves the current value; `null` clears it; a string replaces it. */
  jevApiKey?: string | null;
  llmApiKey?: string | null;
};

export class CompactionSecretStore {
  constructor(private readonly dataDir: string) {}

  filePath(): string {
    return join(this.dataDir, "compaction-secrets.json");
  }

  read(): CompactionSecrets {
    const path = this.filePath();
    if (!existsSync(path)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object") return {};
      const record = parsed as Record<string, unknown>;
      const secrets: CompactionSecrets = {};
      if (typeof record.jevApiKey === "string" && record.jevApiKey.length > 0) secrets.jevApiKey = record.jevApiKey;
      if (typeof record.llmApiKey === "string" && record.llmApiKey.length > 0) secrets.llmApiKey = record.llmApiKey;
      return secrets;
    } catch {
      // A corrupted secret file must never break settings loading; treat it as unconfigured.
      return {};
    }
  }

  write(patch: CompactionSecretsPatch): CompactionSecrets {
    const current = this.read();
    const next: CompactionSecrets = { ...current };
    if (patch.jevApiKey !== undefined) {
      if (patch.jevApiKey === null || patch.jevApiKey === "") delete next.jevApiKey;
      else next.jevApiKey = patch.jevApiKey;
    }
    if (patch.llmApiKey !== undefined) {
      if (patch.llmApiKey === null || patch.llmApiKey === "") delete next.llmApiKey;
      else next.llmApiKey = patch.llmApiKey;
    }
    const path = this.filePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows ignores POSIX modes; the data directory itself is already local-only.
    }
    return next;
  }
}

/** The last four characters of a key, for a `••••abcd` display. Never the whole key. */
export function keyHint(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  return apiKey.length <= 4 ? apiKey : apiKey.slice(-4);
}
