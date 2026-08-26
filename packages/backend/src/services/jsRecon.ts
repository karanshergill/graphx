import { Buffer } from "buffer";

import type { Cursor } from "caido:utils";
import {
  err,
  extractJsRecon,
  type JsReconExtraction,
  type JsReconFindings,
  mergeJsRecon,
  normalizeHostname,
  ok,
  type Result,
} from "shared";

import { resolveScope } from "../agentapi/query";
import type { JsReconRepository } from "../repositories";
import type { BackendSDK } from "../types";

const PAGE_SIZE = 200;
const MAX_BUNDLES = 100;
const MAX_BODY_LENGTH = 2_000_000;
const MAX_TOTAL_LENGTH = 8_000_000;

const bodyToText = async (body: unknown): Promise<string | undefined> => {
  if (body === null || body === undefined) return undefined;
  const textMethod = (body as { text?: unknown }).text;
  if (typeof textMethod === "function") {
    return (textMethod as () => Promise<string>).call(body);
  }
  const view = body as {
    buffer?: ArrayBufferLike;
    byteOffset?: number;
    byteLength?: number;
  };
  if (view.buffer !== undefined && view.byteLength !== undefined) {
    return Buffer.from(
      view.buffer,
      view.byteOffset ?? 0,
      view.byteLength,
    ).toString("utf-8");
  }
  return undefined;
};

const buildHostJsRecon = async (
  sdk: BackendSDK,
  scopeId: string,
  host: string,
): Promise<JsReconFindings> => {
  const normalized = normalizeHostname(host);
  if (normalized === undefined) throw new Error(`Invalid host "${host}".`);

  // LIKE without wildcards is ASCII case-insensitive; the second clause also
  // matches Host headers carrying an explicit port.
  const filter =
    `(req.host.like:"${normalized}" or req.host.like:"${normalized}:%") ` +
    'and (req.path.like:"%.js" or req.path.like:"%.mjs") and resp.code.lt:400';

  const seenPaths = new Set<string>();
  const extractions: JsReconExtraction[] = [];
  let totalLength = 0;
  let truncated = false;
  let cursor: Cursor | undefined;

  for (;;) {
    let query = sdk.requests
      .query()
      .filter(filter)
      .first(PAGE_SIZE)
      .descending("req", "created_at");
    if (cursor !== undefined) query = query.after(cursor);
    const page = await query.execute();

    for (const item of page.items) {
      const path = item.request.getPath();
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      if (
        extractions.length >= MAX_BUNDLES ||
        totalLength >= MAX_TOTAL_LENGTH
      ) {
        truncated = true;
        continue;
      }
      const text = await bodyToText(item.response?.getBody());
      if (text === undefined) continue;
      if (text.length > MAX_BODY_LENGTH) {
        truncated = true;
        continue;
      }
      totalLength += text.length;
      extractions.push(extractJsRecon(text));
    }

    if (page.pageInfo.hasNextPage !== true || truncated) break;
    if (page.pageInfo.endCursor === cursor) {
      sdk.console.warn(
        "GraphX JS recon sweep stopped: pagination cursor did not advance; results are truncated.",
      );
      truncated = true;
      break;
    }
    cursor = page.pageInfo.endCursor;
  }

  return {
    host: normalized,
    generatedAt: new Date().toISOString(),
    bundlesScanned: extractions.length,
    truncated,
    ...mergeJsRecon(extractions),
  };
};

export type JsReconService = {
  scan: (host: string, scopeId?: string) => Promise<Result<JsReconFindings>>;
};

export const createJsReconService = (
  sdk: BackendSDK,
  repository: JsReconRepository,
): JsReconService => ({
  scan: async (host, scopeId) => {
    try {
      if (normalizeHostname(host) === undefined)
        return err(`Invalid host "${host}".`);
      const project = await sdk.projects.getCurrent();
      if (project === undefined)
        return err("No Caido project is currently selected.");
      const scope = await resolveScope(sdk, scopeId);
      const findings = await buildHostJsRecon(sdk, scope.id, host);
      await repository.save(project.getId(), findings);
      return ok(findings);
    } catch (error: unknown) {
      return err(error instanceof Error ? error.message : String(error));
    }
  },
});
