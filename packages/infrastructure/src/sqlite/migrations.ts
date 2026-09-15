import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteClient } from "./client.js";

export function runMigrations(client: SqliteClient, migrationsDir = resolve(process.cwd(), "migrations")): void {
  client.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);");

  const applied = new Set(
    client.db.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version)
  );

  const migrations = readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .map((name) => ({ name, version: Number(name.split("_", 1)[0]) }))
    .sort((left, right) => left.version - right.version);

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const sql = readFileSync(resolve(migrationsDir, migration.name), "utf8");
    const apply = client.db.transaction(() => {
      client.db.exec(sql);
      client.db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, Date.now());
    });
    apply();
  }
}

export function getSchemaVersion(client: SqliteClient): number {
  const table = client.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) return 0;
  const row = client.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
  return row.version ?? 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseFile = process.env.CONTEXTOS_DATABASE_FILE ?? ".contextos/contextos.sqlite";
  const client = SqliteClient.open({ databaseFile });
  try {
    runMigrations(client);
    console.log(`Applied migrations through schema version ${getSchemaVersion(client)}`);
  } finally {
    client.close();
  }
}
