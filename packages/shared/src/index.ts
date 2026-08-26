import type { DefinePluginPackageSpec } from "@caido/sdk-shared";

import type { API } from "./api";
import type { Events } from "./events";

export * from "./domainGraph";
export type { API, ApiMapResponse } from "./api";
export type { Events } from "./events";
export {
  extractJsRecon,
  mergeJsRecon,
  type JsReconExtraction,
  type JsReconFindings,
} from "./jsRecon";
export type { ProjectContext } from "./project";
export { err, ok, type Result } from "./result";

export type Spec = DefinePluginPackageSpec<{
  manifestId: "graphx";
  api: API;
  events: Events;
}>;
