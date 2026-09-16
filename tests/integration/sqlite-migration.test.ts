import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { getSchemaVersion, runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { coreTableNames } from "../../packages/infrastructure/src/sqlite/schema.js";

let tempDir: string | undefined;
let client: SqliteClient | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("SQLite migrations", () => {
  test("migrates an empty database and records schema version", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "contextos-sqlite-"));
    client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });

    runMigrations(client);

    expect(getSchemaVersion(client)).toBe(8);
    const tables = client.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const tableName of coreTableNames) {
      expect(tables).toContain(tableName);
    }
  });

  test("enforces foreign keys after migration", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "contextos-sqlite-"));
    client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
    runMigrations(client);

    expect(() =>
      client!.db
        .prepare("INSERT INTO sessions (id, project_id, agent_adapter_id, status, runtime_state, created_at, updated_at) VALUES ('s_missing', 'p_missing', 'codex', 'CREATED', '{}', 1, 1)")
        .run()
    ).toThrow();
  });
});




