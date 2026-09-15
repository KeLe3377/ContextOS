import type { SqliteClient } from "./client.js";

export type SqlValue = string | number | bigint | Buffer | null;
export type SqlParams = Record<string, SqlValue> | SqlValue[];

export type TransactionContext = {
  execute(sql: string, params?: SqlParams): void;
  get<T = unknown>(sql: string, params?: SqlParams): T | undefined;
  all<T = unknown>(sql: string, params?: SqlParams): T[];
};

export class TransactionRunner {
  constructor(private readonly client: SqliteClient) {}

  run<T>(work: (tx: TransactionContext) => T): T {
    const runInTransaction = this.client.db.transaction(() => {
      const tx: TransactionContext = {
        execute: (sql, params = []) => {
          this.client.db.prepare(sql).run(params);
        },
        get: <Row = unknown>(sql: string, params: SqlParams = []) => this.client.db.prepare(sql).get(params) as Row | undefined,
        all: <Row = unknown>(sql: string, params: SqlParams = []) => this.client.db.prepare(sql).all(params) as Row[]
      };
      return work(tx);
    });

    return runInTransaction();
  }
}
