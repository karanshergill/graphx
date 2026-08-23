import { err, ok, type Result } from "shared";

import type { DomainMarksRepository } from "../repositories";
import type { BackendSDK } from "../types";

export type DomainMarksService = {
  list: () => Promise<Result<string[]>>;
  add: (hostnames: string[]) => Promise<Result<string[]>>;
  remove: (hostnames: string[]) => Promise<Result<string[]>>;
};

export const createDomainMarksService = (
  sdk: BackendSDK,
  repository: DomainMarksRepository,
): DomainMarksService => {
  const currentProjectId = async (): Promise<string | undefined> => {
    const project = await sdk.projects.getCurrent();
    return project?.getId();
  };

  const list = async (): Promise<Result<string[]>> => {
    try {
      const projectId = await currentProjectId();
      if (projectId === undefined)
        return err("No Caido project is currently selected.");
      return ok(await repository.list(projectId));
    } catch (error: unknown) {
      return err(error instanceof Error ? error.message : String(error));
    }
  };

  const mutate = async (
    hostnames: string[],
    apply: (projectId: string) => Promise<void>,
  ): Promise<Result<string[]>> => {
    try {
      const projectId = await currentProjectId();
      if (projectId === undefined)
        return err("No Caido project is currently selected.");
      await apply(projectId);
      return ok(await repository.list(projectId));
    } catch (error: unknown) {
      return err(error instanceof Error ? error.message : String(error));
    }
  };

  return {
    list,
    add: (hostnames) =>
      mutate(hostnames, (projectId) => repository.add(projectId, hostnames)),
    remove: (hostnames) =>
      mutate(hostnames, (projectId) => repository.remove(projectId, hostnames)),
  };
};
