import type { DefinePluginPackageSpec } from "@caido/sdk-shared";

import type { API } from "./api";
import type { Events } from "./events";

export * from "./domainGraph";
export type { API, ApiMapResponse } from "./api";
export type { Events } from "./events";
export {
  DEFAULT_ACTIVE_FETCH_DELAY_MS,
  DEFAULT_CAPPED_REQUEST_BUDGET,
  MAX_ACTIVE_FETCH_DELAY_MS,
  MAX_ACTIVE_REQUEST_BUDGET,
  MIN_ACTIVE_FETCH_DELAY_MS,
  extractJsRecon,
  extractSourceMapRecon,
  findSourceMapRef,
  mergeJsRecon,
  validateActiveReconOptions,
  type JsReconActiveOptions,
  type JsReconActiveSummary,
  type JsReconExtraction,
  type JsReconEvidence,
  type JsReconFindings,
  type JsReconOrigin,
  type JsReconScanOptions,
  type SourceMapRecon,
} from "./jsRecon";
export type { ProjectContext } from "./project";
export { err, ok, type Result } from "./result";

export type Spec = DefinePluginPackageSpec<{
  manifestId: "graphx";
  api: API;
  events: Events;
}>;
