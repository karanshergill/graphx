import type { ProjectContext } from "./project";

export type Events = {
  "project:changed": (project: ProjectContext | undefined) => void;
  "domainMarks:changed": (hostnames: string[]) => void;
};
