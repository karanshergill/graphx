import { err, ok, type ProjectContext, type Result } from "shared";

import { toProjectContext } from "../services";
import type { BackendSDK } from "../types";

export const getProjectContext = async (
  sdk: BackendSDK,
): Promise<Result<ProjectContext>> => {
  try {
    const project = await sdk.projects.getCurrent();
    if (project === undefined)
      return err("No Caido project is currently selected.");
    return ok(toProjectContext(project));
  } catch (error: unknown) {
    return err(error instanceof Error ? error.message : String(error));
  }
};
