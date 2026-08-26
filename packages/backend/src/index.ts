import type { SDK } from "caido:plugin";
import type { Spec } from "shared";

import { createAgentRoutes, startAgentApiServer } from "./agentapi";
import {
  createDomainMarksApi,
  createJsReconApi,
  getApiMap,
  getProjectContext,
} from "./api";
import {
  createDomainMarksRepository,
  createJsReconRepository,
} from "./repositories";
import {
  createDomainMarksService,
  createJsReconService,
  toProjectContext,
} from "./services";

export const init = (sdk: SDK<Spec>): void => {
  sdk.api.register("getProjectContext", getProjectContext);
  sdk.api.register("getApiMap", getApiMap);

  const marksService = createDomainMarksService(
    sdk,
    createDomainMarksRepository(sdk),
  );
  const marksApi = createDomainMarksApi(marksService);
  sdk.api.register("listDomainMarks", marksApi.listDomainMarks);
  sdk.api.register("addDomainMarks", marksApi.addDomainMarks);
  sdk.api.register("removeDomainMarks", marksApi.removeDomainMarks);

  const jsReconService = createJsReconService(
    sdk,
    createJsReconRepository(sdk),
  );
  sdk.api.register("getJsRecon", createJsReconApi(jsReconService).getJsRecon);

  startAgentApiServer(
    createAgentRoutes(sdk, marksService, jsReconService),
    (message) => sdk.console.warn(message),
  );

  sdk.events.onProjectChange((_eventSdk, project) => {
    sdk.api.send(
      "project:changed",
      project === null ? undefined : toProjectContext(project),
    );
  });
};
