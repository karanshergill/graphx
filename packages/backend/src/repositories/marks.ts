import { normalizeHostname } from "shared";

import type { BackendSDK } from "../types";

type Statement = {
  all: <T extends object>(...params: string[]) => Promise<T[]>;
  run: (...params: string[]) => Promise<unknown>;
};

type Database = {
  exec: (sql: string) => Promise<void>;
  prepare: (sql: string) => Promise<Statement>;
};

export type DomainMarksRepository = {
  list: (projectId: string) => Promise<string[]>;
  add: (projectId: string, hostnames: string[]) => Promise<void>;
  remove: (projectId: string, hostnames: string[]) => Promise<void>;
};

const validHostnames = (hostnames: string[]): string[] => {
  const valid = new Set<string>();
  for (const hostname of hostnames) {
    const normalized = normalizeHostname(hostname);
    if (normalized !== undefined) valid.add(normalized);
  }
  return [...valid];
};

export const createDomainMarksRepository = (
  sdk: BackendSDK,
): DomainMarksRepository => {
  let database: Database | undefined;

  const db = async (): Promise<Database> => {
    if (database === undefined) {
      database = await sdk.meta.db();
      await database.exec(
        `CREATE TABLE IF NOT EXISTS domain_marks (
          project_id TEXT NOT NULL,
          hostname TEXT NOT NULL,
          marked_at TEXT NOT NULL,
          PRIMARY KEY (project_id, hostname)
        )`,
      );
    }
    return database;
  };

  return {
    list: async (projectId) => {
      const handle = await db();
      const statement = await handle.prepare(
        "SELECT hostname FROM domain_marks WHERE project_id = ? ORDER BY hostname",
      );
      const rows = await statement.all<{ hostname: string }>(projectId);
      return rows.map((row) => row.hostname);
    },
    add: async (projectId, hostnames) => {
      const valid = validHostnames(hostnames);
      if (valid.length === 0) return;
      const handle = await db();
      const statement = await handle.prepare(
        "INSERT OR IGNORE INTO domain_marks (project_id, hostname, marked_at) VALUES (?, ?, ?)",
      );
      const markedAt = new Date().toISOString();
      for (const hostname of valid) {
        await statement.run(projectId, hostname, markedAt);
      }
    },
    remove: async (projectId, hostnames) => {
      const valid = validHostnames(hostnames);
      if (valid.length === 0) return;
      const handle = await db();
      const statement = await handle.prepare(
        "DELETE FROM domain_marks WHERE project_id = ? AND hostname = ?",
      );
      for (const hostname of valid) {
        await statement.run(projectId, hostname);
      }
    },
  };
};
