import type { JsReconFindings } from "shared";

import type { BackendSDK } from "../types";

export type JsReconAuditEvent = {
  runId: string;
  time: string;
  scopeId: string;
  host: string;
  requestBudget: number | "all";
  delayMs: number;
  type: "start" | "request" | "response" | "failure" | "finish";
  url?: string;
  statusCode?: number;
  outcome?: string;
};

type AuditRow = { event_json: string };

type Statement = {
  all: <T extends object>(...params: string[]) => Promise<T[]>;
  run: (...params: string[]) => Promise<unknown>;
};

type Database = {
  exec: (sql: string) => Promise<void>;
  prepare: (sql: string) => Promise<Statement>;
};

export type JsReconRepository = {
  save: (projectId: string, findings: JsReconFindings) => Promise<void>;
  appendAudit: (projectId: string, event: JsReconAuditEvent) => Promise<void>;
  listAudit: (
    projectId: string,
    scopeId: string,
    host: string,
  ) => Promise<JsReconAuditEvent[]>;
};

export const createJsReconRepository = (sdk: BackendSDK): JsReconRepository => {
  let database: Database | undefined;

  const db = async (): Promise<Database> => {
    if (database === undefined) {
      const handle = await sdk.meta.db();
      await handle.exec(
        `CREATE TABLE IF NOT EXISTS js_recon (
          project_id TEXT NOT NULL,
          hostname TEXT NOT NULL,
          findings TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, hostname)
        )`,
      );
      await handle.exec(
        `CREATE TABLE IF NOT EXISTS js_recon_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          hostname TEXT NOT NULL,
          event_json TEXT NOT NULL
        )`,
      );
      await handle.exec(
        "CREATE INDEX IF NOT EXISTS js_recon_audit_lookup ON js_recon_audit (project_id, scope_id, hostname, id)",
      );
      database = handle;
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
    appendAudit: async (projectId, event) => {
      const handle = await db();
      const statement = await handle.prepare(
        "INSERT INTO js_recon_audit (project_id, scope_id, hostname, event_json) VALUES (?, ?, ?, ?)",
      );
      await statement.run(
        projectId,
        event.scopeId,
        event.host,
        JSON.stringify(event),
      );
    },
    listAudit: async (projectId, scopeId, host) => {
      const handle = await db();
      const statement = await handle.prepare(
        "SELECT event_json FROM js_recon_audit WHERE project_id = ? AND scope_id = ? AND hostname = ? ORDER BY id DESC LIMIT 100",
      );
      const rows = await statement.all<AuditRow>(projectId, scopeId, host);
      return rows.map((row) => JSON.parse(row.event_json) as JsReconAuditEvent);
    },
  };
};
