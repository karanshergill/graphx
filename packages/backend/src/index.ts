import type { SDK } from "caido:plugin";
import type { Spec } from "shared";

import { createAgentRoutes, startAgentApiServer } from "./agentapi";
import { createDomainMarksApi, getApiMap, getProjectContext } from "./api";
import { createDomainMarksRepository } from "./repositories";
import { createDomainMarksService, toProjectContext } from "./services";

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

  startAgentApiServer(createAgentRoutes(sdk, marksService), (message) =>
    sdk.console.warn(message),
  );

  sdk.events.onProjectChange((_eventSdk, project) => {
    sdk.api.send(
      "project:changed",
      project === null ? undefined : toProjectContext(project),
    );
  });
};
