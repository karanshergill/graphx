import type { JsReconFindings, JsReconScanOptions, Result } from "shared";

import type { JsReconService } from "../services";
import type { BackendSDK } from "../types";

type JsReconApi = {
  getJsRecon: (
    sdk: BackendSDK,
    host: string,
    scopeId?: string,
    options?: JsReconScanOptions,
  ) => Promise<Result<JsReconFindings>>;
};

export const createJsReconApi = (service: JsReconService): JsReconApi => ({
  // Caido can serialize omitted optional RPC arguments as null.
  getJsRecon: (_sdk, host, scopeId, options) =>
    service.scan(host, scopeId ?? undefined, options ?? undefined),
});
