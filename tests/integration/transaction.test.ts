import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteClient } from "../../packages/infrastructure/src/sqlite/client.js";
import { runMigrations } from "../../packages/infrastructure/src/sqlite/migrations.js";
import { TransactionRunner } from "../../packages/infrastructure/src/sqlite/transaction.js";

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

describe("TransactionRunner", () => {
  test("commits successful work and rolls back failed work", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "contextos-transaction-"));
    client = SqliteClient.open({ databaseFile: join(tempDir, "contextos.sqlite") });
    runMigrations(client);
    const runner = new TransactionRunner(client);

    runner.run((tx) => {
      tx.execute("INSERT INTO projects (id, name, root_path, root_path_hash, status, created_at, updated_at) VALUES ('p_commit', 'Committed', 'D:/project', 'hash-1', 'ACTIVE', 1, 1)");
    });

    expect(client.db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = 'p_commit'").get()).toMatchObject({ count: 1 });

    expect(() =>
      runner.run((tx) => {
        tx.execute("INSERT INTO projects (id, name, root_path, root_path_hash, status, created_at, updated_at) VALUES ('p_rollback', 'Rolled back', 'D:/project', 'hash-2', 'ACTIVE', 1, 1)");
        throw new Error("rollback now");
      })
    ).toThrow("rollback now");

    expect(client.db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = 'p_rollback'").get()).toMatchObject({ count: 0 });
  });
});
