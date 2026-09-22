import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { getSchemaVersion, runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { coreTableNames } from "../../packages/infrastructure/src/sqlite/schema.js";
import { SqliteAutomationRepository } from "../../packages/infrastructure/src/sqlite/automation-repository.js";

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

function tableNames(): string[] {
  return client!.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => (row as { name: string }).name);
}

describe("SQLite migrations", () => {
  test("migrates an empty database and records schema version", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "contextos-sqlite-"));
    client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });

    runMigrations(client);

    expect(getSchemaVersion(client)).toBe(15);
    const tables = tableNames();

    for (const tableName of coreTableNames) {
      expect(tables).toContain(tableName);
    }
  });

  test("upgrades a schema 0011 database to the current version and backfills project automation settings", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "contextos-sqlite-"));
    const migrationsDir = resolve(process.cwd(), "migrations");
    const partialDir = join(tempDir, "migrations-through-0011");
    await mkdir(partialDir, { recursive: true });
    for (const name of readdirSync(migrationsDir).filter((entry) => /^\d+_.+\.sql$/.test(entry))) {
      if (Number(name.split("_", 1)[0]) > 11) continue;
      await copyFile(join(migrationsDir, name), join(partialDir, name));
    }

    client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
    runMigrations(client, partialDir);
    expect(getSchemaVersion(client)).toBe(11);
    expect(tableNames()).not.toContain("automation_jobs");

    client.db.prepare(
      "INSERT INTO projects (id, name, root_path, root_path_hash, status, created_at, updated_at) VALUES ('proj_upgrade', 'Upgrade', '.', 'hash', 'ACTIVE', 1, 1)"
    ).run();

    runMigrations(client);

    expect(getSchemaVersion(client)).toBe(15);
    const tables = tableNames();
    for (const tableName of coreTableNames) {
      expect(tables).toContain(tableName);
    }
    // Existing rows survive the upgrade, and every Project starts in SUGGEST_ONLY.
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 1 });
    expect(client.db.prepare("SELECT mode, poll_interval_ms, max_concurrent_jobs, revision FROM project_automation_settings WHERE project_id = 'proj_upgrade'").get())
      .toEqual({ mode: "SUGGEST_ONLY", poll_interval_ms: 30_000, max_concurrent_jobs: 1, revision: 1 });
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

  test("prevents Evidence Snapshot updates and deletes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "contextos-sqlite-"));
    client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
    runMigrations(client);
    client.db.prepare("INSERT INTO projects (id, name, root_path, root_path_hash, status, created_at, updated_at) VALUES ('proj_immutable', 'Immutable', '.', 'hash', 'ACTIVE', 1, 1)").run();
    client.db.prepare("INSERT INTO evidence_snapshots (id, project_id, evidence_type, title, content_hash, metadata_json, captured_at, created_at) VALUES ('ev_immutable', 'proj_immutable', 'TEXT', 'Immutable', 'sha256:test', '{}', 1, 1)").run();

    expect(() => client!.db.prepare("UPDATE evidence_snapshots SET title = 'Changed' WHERE id = 'ev_immutable'").run())
      .toThrow("Evidence Snapshots are immutable");
    expect(() => client!.db.prepare("DELETE FROM evidence_snapshots WHERE id = 'ev_immutable'").run())
      .toThrow("Evidence Snapshots are immutable");
  });

  test("upgrades a schema 0013 database and reads historical candidates without provenance", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "contextos-sqlite-"));
    const migrationsDir = resolve(process.cwd(), "migrations");
    const partialDir = join(tempDir, "migrations-through-0013");
    await mkdir(partialDir, { recursive: true });
    for (const name of readdirSync(migrationsDir).filter((entry) => /^\d+_.+\.sql$/.test(entry))) {
      if (Number(name.split("_", 1)[0]) > 13) continue;
      await copyFile(join(migrationsDir, name), join(partialDir, name));
    }

    client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
    runMigrations(client, partialDir);
    expect(getSchemaVersion(client)).toBe(13);

    // A candidate written before provenance existed.
    client.db.prepare("INSERT INTO projects (id, name, root_path, root_path_hash, status, created_at, updated_at) VALUES ('proj_old', 'Old', '.', 'hash', 'ACTIVE', 1, 1)").run();
    client.db.prepare(
      `INSERT INTO extraction_candidates
         (id, project_id, kind, fingerprint, payload_json, confidence, status, extractor_id, extractor_version, created_at, updated_at, revision)
       VALUES ('cand_old', 'proj_old', 'RESUME_CAPSULE', 'sha256:old', '{"kind":"RESUME_CAPSULE","summary":"s","nextAction":null}', 0.5, 'PENDING', 'codex-cli', '1.0.0', 1, 1, 1)`
    ).run();
    expect(client.db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('extraction_candidates') WHERE name = 'provenance_json'").get())
      .toEqual({ count: 0 });

    runMigrations(client);

    expect(getSchemaVersion(client)).toBe(15);
    const repository = new SqliteAutomationRepository(client.db);
    const candidate = repository.getCandidate("cand_old")!;
    expect(candidate.kind).toBe("RESUME_CAPSULE");
    expect(candidate.provenance).toEqual({});
  });
});
