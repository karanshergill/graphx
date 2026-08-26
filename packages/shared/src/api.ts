import type { ApiRoute } from "./domainGraph/apiMap";
import type { ProjectContext } from "./project";
import type { Result } from "./result";

export type ApiMapResponse = {
  sitemapEndpoints: number;
  requestsScanned: number;
  truncated: boolean;
  routeCount: number;
  routes: readonly ApiRoute[];
};

export type API = {
  getProjectContext: () => Promise<Result<ProjectContext>>;
  listDomainMarks: () => Promise<Result<string[]>>;
  addDomainMarks: (hostnames: string[]) => Promise<Result<string[]>>;
  removeDomainMarks: (hostnames: string[]) => Promise<Result<string[]>>;
  getApiMap: (
    host: string,
    scopeId?: string,
  ) => Promise<Result<ApiMapResponse>>;
};
