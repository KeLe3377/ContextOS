export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type ProjectRepository = unknown;
export type SessionRepository = unknown;
export type DecisionRepository = unknown;
export type WorkItemRepository = unknown;
export type ReviewItemRepository = unknown;
export type ContextSourceRepository = unknown;
export type EvidenceSnapshotRepository = unknown;
export type ContextItemRepository = unknown;
