import type { ProjectDto, ProjectInput, ProjectStatus } from "../../../contracts/src/projects.js";
import {
  activateProject,
  archiveProject,
  pauseProject,
  restoreProject
} from "../../../domain/src/project/project.js";
import type { SqliteProjectRepository } from "../../../infrastructure/src/sqlite/project-repository.js";
import { nowMs } from "../../../shared/src/clock.js";

export class ProjectService {
  constructor(private readonly projects: SqliteProjectRepository) {}

  create(input: ProjectInput): ProjectDto {
    return this.projects.create(input, nowMs());
  }

  list(input: { status?: string; q?: string; limit: number }): ProjectDto[] {
    return this.projects.list(input);
  }

  get(id: string): ProjectDto {
    return this.projects.getByIdOrThrow(id);
  }

  transition(
    id: string,
    action: "activate" | "pause" | "archive" | "restore",
    expectedRevision: number
  ): ProjectDto {
    const current = this.projects.getByIdOrThrow(id);
    const now = nowMs();
    const state = {
      id: current.id,
      status: current.status,
      revision: current.revision,
      archivedAt: current.archivedAt ? Date.parse(current.archivedAt) : null
    };
    const next =
      action === "activate"
        ? activateProject(state)
        : action === "pause"
          ? pauseProject(state)
          : action === "archive"
            ? archiveProject(state, now)
            : restoreProject(state);

    return this.projects.updateStatus(id, next.status as ProjectStatus, expectedRevision, now, next.archivedAt);
  }
}

