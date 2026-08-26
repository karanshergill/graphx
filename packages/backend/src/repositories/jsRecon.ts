import type { JsReconFindings } from "shared";

import type { BackendSDK } from "../types";

type Statement = {
  run: (...params: string[]) => Promise<unknown>;
};

type Database = {
  exec: (sql: string) => Promise<void>;
  prepare: (sql: string) => Promise<Statement>;
};

export type JsReconRepository = {
  save: (projectId: string, findings: JsReconFindings) => Promise<void>;
};

export const createJsReconRepository = (sdk: BackendSDK): JsReconRepository => {
  let database: Database | undefined;

  const db = async (): Promise<Database> => {
    if (database === undefined) {
      database = await sdk.meta.db();
      await database.exec(
        `CREATE TABLE IF NOT EXISTS js_recon (
          project_id TEXT NOT NULL,
          hostname TEXT NOT NULL,
          findings TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, hostname)
        )`,
      );
    }
    return database;
  };

  return {
    save: async (projectId, findings) => {
      const handle = await db();
      const statement = await handle.prepare(
        "INSERT OR REPLACE INTO js_recon (project_id, hostname, findings, updated_at) VALUES (?, ?, ?, ?)",
      );
      await statement.run(
        projectId,
        findings.host,
        JSON.stringify(findings),
        new Date().toISOString(),
      );
    },
  };
};
