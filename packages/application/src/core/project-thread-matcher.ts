import { resolve, win32 } from "node:path";
import type { ProjectStatus } from "../../../contracts/src/projects.js";

/**
 * Pure cwd-to-Project attribution for automatically discovered agent threads.
 *
 * This module deliberately never touches SQLite: it takes the already-loaded Project rows and
 * returns a decision, so the ownership rules stay unit-testable and the caller keeps control
 * over persistence.
 *
 * Rules (design §7.2):
 * 1. An exact Project root match wins.
 * 2. A thread whose cwd is the *parent* of a Project root is only a to-confirm suggestion.
 * 3. Several Projects matching at the same level is never resolved automatically.
 * 4. Archived Projects are out of scope for automatic binding.
 * 5. Already-bound threads are the caller's concern and never reach this decision.
 */

export type ThreadMatchProject = {
  id: string;
  rootPath: string;
  status: ProjectStatus;
};

export type ThreadMatchResult =
  | { kind: "EXACT"; projectId: string }
  | { kind: "REVIEW"; projectIds: string[]; reason: string }
  | { kind: "IGNORE"; reason: string };

export const threadMatchReasons = {
  missingCwd: "MISSING_CWD",
  noProjectMatch: "NO_PROJECT_MATCH",
  projectArchived: "PROJECT_ARCHIVED",
  multipleProjects: "MULTIPLE_PROJECTS_MATCH",
  parentDirectory: "PARENT_DIRECTORY_MATCH",
  runtimeWorkspace: "RUNTIME_WORKSPACE"
} as const;

/**
 * Canonical form used for every path comparison: forward slashes, no trailing separator and a
 * lower-cased Windows drive prefix, because Windows paths are case-insensitive while POSIX
 * paths are not.
 */
export function normalizeProjectPath(input: string | null | undefined): string {
  const trimmed = input?.trim();
  if (!trimmed) return "";

  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
  // win32.resolve is used for Windows-shaped input so the result does not depend on the host
  // platform running the tests.
  const base = isWindowsPath ? win32.resolve(trimmed) : resolve(trimmed);
  const slashed = base.replace(/\\/g, "/");
  const withoutTrailingSeparator = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
  return /^[a-zA-Z]:\//.test(withoutTrailingSeparator) || withoutTrailingSeparator.startsWith("//")
    ? withoutTrailingSeparator.toLowerCase()
    : withoutTrailingSeparator;
}

export function matchThreadToProject(input: {
  cwd: string | null | undefined;
  projects: readonly ThreadMatchProject[];
  /**
   * Roots the automation runtime owns — the extraction run workspace, for instance. A thread
   * recorded under one of them is runtime plumbing, never business work, so it is ignored
   * before any Project matching happens.
   */
  ignoredRoots?: readonly string[];
}): ThreadMatchResult {
  const threadPath = normalizeProjectPath(input.cwd);
  if (!threadPath) return { kind: "IGNORE", reason: threadMatchReasons.missingCwd };

  if (isUnderAnyRoot(threadPath, input.ignoredRoots ?? [])) {
    return { kind: "IGNORE", reason: threadMatchReasons.runtimeWorkspace };
  }

  const candidates = input.projects
    .map((project) => ({ project, path: normalizeProjectPath(project.rootPath) }))
    .filter((entry) => entry.path.length > 0);

  const exact = candidates.filter((entry) => entry.path === threadPath);
  if (exact.length > 0) {
    const eligible = exact.filter((entry) => entry.project.status !== "ARCHIVED");
    if (eligible.length === 0) return { kind: "IGNORE", reason: threadMatchReasons.projectArchived };
    if (eligible.length > 1) {
      return {
        kind: "REVIEW",
        projectIds: eligible.map((entry) => entry.project.id),
        reason: threadMatchReasons.multipleProjects
      };
    }
    return { kind: "EXACT", projectId: eligible[0]!.project.id };
  }

  // A thread recorded against the parent directory is a plausible but unconfirmed owner:
  // Codex Desktop threads opened for a repository are often recorded one level up.
  const parents = candidates.filter((entry) => win32.dirname(entry.path) === threadPath);
  if (parents.length > 0) {
    const eligible = parents.filter((entry) => entry.project.status !== "ARCHIVED");
    if (eligible.length === 0) return { kind: "IGNORE", reason: threadMatchReasons.projectArchived };
    return {
      kind: "REVIEW",
      projectIds: eligible.map((entry) => entry.project.id),
      reason: threadMatchReasons.parentDirectory
    };
  }

  return { kind: "IGNORE", reason: threadMatchReasons.noProjectMatch };
}

/**
 * Title for an automatically created Session: the sidebar name, then the first message, then
 * the external id prefix so a Session never ends up unnamed.
 */
export function threadTitle(input: { externalSessionId: string; name?: string | null; preview?: string | null }): string {
  const name = clipLabel(input.name);
  if (name) return name;
  const preview = clipLabel(input.preview);
  if (preview) return preview;
  return input.externalSessionId.slice(0, 8);
}

const maxTitleLength = 120;

function clipLabel(value: string | null | undefined): string | null {
  const collapsed = value?.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length <= maxTitleLength ? collapsed : collapsed.slice(0, maxTitleLength);
}

function isUnderAnyRoot(path: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    const normalized = normalizeProjectPath(root);
    if (!normalized) continue;
    if (path === normalized || path.startsWith(`${normalized}/`)) return true;
  }
  return false;
}
