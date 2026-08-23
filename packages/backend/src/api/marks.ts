import type { Result } from "shared";

import type { DomainMarksService } from "../services";
import type { BackendSDK } from "../types";

type DomainMarksApi = {
  listDomainMarks: (sdk: BackendSDK) => Promise<Result<string[]>>;
  addDomainMarks: (
    sdk: BackendSDK,
    hostnames: string[],
  ) => Promise<Result<string[]>>;
  removeDomainMarks: (
    sdk: BackendSDK,
    hostnames: string[],
  ) => Promise<Result<string[]>>;
};

export const createDomainMarksApi = (
  service: DomainMarksService,
): DomainMarksApi => ({
  listDomainMarks: () => service.list(),
  addDomainMarks: async (sdk, hostnames) => {
    const result = await service.add(hostnames);
    if (result.kind === "Ok") sdk.api.send("domainMarks:changed", result.value);
    return result;
  },
  removeDomainMarks: async (sdk, hostnames) => {
    const result = await service.remove(hostnames);
    if (result.kind === "Ok") sdk.api.send("domainMarks:changed", result.value);
    return result;
  },
});
