import type { JsReconFindings, Result } from "shared";

import type { JsReconService } from "../services";
import type { BackendSDK } from "../types";

type JsReconApi = {
  getJsRecon: (
    sdk: BackendSDK,
    host: string,
    scopeId?: string,
  ) => Promise<Result<JsReconFindings>>;
};

export const createJsReconApi = (service: JsReconService): JsReconApi => ({
  getJsRecon: (_sdk, host, scopeId) => service.scan(host, scopeId),
});
