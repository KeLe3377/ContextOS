import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type SqliteClientOptions = { databaseFile: string };

export class SqliteClient {
  readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(options: SqliteClientOptions): SqliteClient {
    mkdirSync(dirname(options.databaseFile), { recursive: true });
    const db = new Database(options.databaseFile);
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("temp_store = MEMORY");
    return new SqliteClient(db);
  }

  close(): void {
    this.db.close();
  }
}
