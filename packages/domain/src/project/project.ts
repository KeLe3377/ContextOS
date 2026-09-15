import type { ProjectStatus } from "../../../contracts/src/projects.js";
import { ContextOsError } from "../../../shared/src/errors.js";

export type ProjectState = {
  id: string;
  status: ProjectStatus;
  revision: number;
  archivedAt: number | null;
};

export function activateProject(project: ProjectState): ProjectState {
  if (project.status === "ARCHIVED") {
    throw new ContextOsError("INVALID_ARGUMENT", "Archived projects must be restored before activation");
  }
  return { ...project, status: "ACTIVE", revision: project.revision + 1, archivedAt: null };
}

export function pauseProject(project: ProjectState): ProjectState {
  if (project.status === "ARCHIVED") {
    throw new ContextOsError("INVALID_ARGUMENT", "Archived projects cannot be paused");
  }
  return { ...project, status: "PAUSED", revision: project.revision + 1 };
}

export function archiveProject(project: ProjectState, now: number): ProjectState {
  if (project.status === "ARCHIVED") {
    return project;
  }
  return { ...project, status: "ARCHIVED", revision: project.revision + 1, archivedAt: now };
}

export function restoreProject(project: ProjectState): ProjectState {
  if (project.status !== "ARCHIVED") {
    return project;
  }
  return { ...project, status: "PAUSED", revision: project.revision + 1, archivedAt: null };
}

