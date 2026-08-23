import type { Project } from "caido:utils";
import type { ProjectContext } from "shared";

export const toProjectContext = (project: Project): ProjectContext => ({
  id: project.getId(),
  name: project.getName(),
  version: project.getVersion(),
});
