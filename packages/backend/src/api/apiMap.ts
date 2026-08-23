import {
  type ApiMapResponse,
  err,
  normalizeHostname,
  ok,
  type Result,
} from "shared";

import { buildHostApiMap, resolveScope } from "../agentapi/query";
import type { BackendSDK } from "../types";

export const getApiMap = async (
  sdk: BackendSDK,
  host: string,
): Promise<Result<ApiMapResponse>> => {
  try {
    if (normalizeHostname(host) === undefined)
      return err(`Invalid host "${host}".`);
    const scope = await resolveScope(sdk, undefined);
    return ok(await buildHostApiMap(sdk, scope.id, host));
  } catch (error: unknown) {
    return err(error instanceof Error ? error.message : String(error));
  }
};
