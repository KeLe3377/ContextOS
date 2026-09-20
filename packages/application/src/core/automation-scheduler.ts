import type {
  AutomationJobDto,
  AutomationJobKind,
  AutomationJobStatus,
  AutomationSchedulerStatus
} from "../../../contracts/src/automation.js";
import type { AutomationJobFailure, AutomationJobRecord } from "../../../infrastructure/src/sqlite/automation-repository.js";

/**
 * Daemon-owned lifecycle for persistent automation jobs.
 *
 * The scheduler deliberately knows nothing about domains: it claims due jobs, hands them
 * to an injected dispatcher, and translates the outcome into a job state transition.
 * Everything it depends on (repository, dispatcher, clock, timer) is injected so tests can
 * drive it deterministically with fakes.
 *
 * Design: docs/superpowers/specs/2026-09-20-contextos-zero-input-automation-design.md
 */

/** Deterministic, capped retry schedule: 5s, 30s, 2m, 10m. */
export const automationBackoffScheduleMs = [5_000, 30_000, 120_000, 600_000] as const;

export const automationSchedulerDefaultTickIntervalMs = 1_000;

/** Handler-side failure with a stable code, so retry decisions never depend on message text. */
export class AutomationDispatchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AutomationDispatchError";
    this.code = code;
  }
}

export interface AutomationJobDispatcher {
  dispatch(job: AutomationJobRecord): Promise<void>;
  /**
   * Job kinds this dispatcher can actually run. The scheduler only ever claims these, so a
   * kind whose handler has not been registered yet is left QUEUED instead of being claimed
   * and burning through its retry budget.
   */
  registeredKinds(): readonly AutomationJobKind[];
}

/**
 * Narrow view of the automation repository that the scheduler needs.
 * Declared as an interface so tests can supply a fake instead of SQLite.
 */
export interface AutomationSchedulerRepository {
  recoverRunning(now: number): number;
  claimNext(now: number, kinds: readonly AutomationJobKind[]): AutomationJobRecord | null;
  markSucceeded(jobId: string, now: number): unknown;
  markRetryable(jobId: string, failure: AutomationJobFailure, availableAt: number, now: number): unknown;
  markFailed(jobId: string, failure: AutomationJobFailure, now: number): unknown;
  countJobsByStatus(): Record<AutomationJobStatus, number>;
}

export type AutomationTimerCancel = () => void;
export type AutomationSetTimer = (handler: () => void, delayMs: number) => AutomationTimerCancel;

export type AutomationSchedulerOptions = {
  repository: AutomationSchedulerRepository;
  dispatcher: AutomationJobDispatcher;
  /** Injected clock so retry timing is deterministic in tests. */
  clock?: () => number;
  /** Injected timer so tests never wait on real wall-clock delays. */
  setTimer?: AutomationSetTimer;
  tickIntervalMs?: number;
  maxConcurrentJobs?: number;
  backoffScheduleMs?: readonly number[];
  /**
   * Sink for errors the loop cannot attribute to a single job (a failing claim, or a
   * bookkeeping write that failed after a dispatch settled). Never allowed to throw.
   */
  onError?: (error: unknown) => void;
};

export type AutomationJobCounts = {
  total: number;
  byStatus: Record<AutomationJobStatus, number>;
};

const defaultSetTimer: AutomationSetTimer = (handler, delayMs) => {
  const timer = setTimeout(handler, delayMs);
  // A pending tick must not keep the daemon process alive on its own.
  timer.unref?.();
  return () => clearTimeout(timer);
};

export class AutomationScheduler {
  private readonly repository: AutomationSchedulerRepository;
  private readonly dispatcher: AutomationJobDispatcher;
  private readonly clock: () => number;
  private readonly setTimer: AutomationSetTimer;
  private readonly tickIntervalMs: number;
  private readonly maxConcurrentJobs: number;
  private readonly backoffScheduleMs: readonly number[];
  private readonly onError: (error: unknown) => void;

  private readonly active = new Map<string, Promise<void>>();
  private cancelTimer: AutomationTimerCancel | null = null;
  private currentTick: Promise<void> | null = null;
  private running = false;
  private startedAt: number | null = null;
  private lastTickAt: number | null = null;
  private recoveredJobs = 0;

  constructor(options: AutomationSchedulerOptions) {
    this.repository = options.repository;
    this.dispatcher = options.dispatcher;
    this.clock = options.clock ?? Date.now;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.tickIntervalMs = options.tickIntervalMs ?? automationSchedulerDefaultTickIntervalMs;
    this.maxConcurrentJobs = Math.max(1, options.maxConcurrentJobs ?? 1);
    this.backoffScheduleMs = options.backoffScheduleMs ?? automationBackoffScheduleMs;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Starts polling. Idempotent: a second call while running is a no-op, so the Fastify
   * `onReady` hook can fire more than once without producing a second timer or a second
   * recovery pass.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.clock();
    this.recoveredJobs = this.repository.recoverRunning(this.clock());
    this.scheduleNextTick();
  }

  /**
   * Stops claiming new work and waits for the in-flight tick and every active dispatch.
   * Without this, a tick could still be inside a SQLite call when the caller closes the
   * database connection.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const pending = [this.currentTick, ...this.active.values()].filter((entry): entry is Promise<void> => entry !== null);
    await Promise.allSettled(pending);
    this.currentTick = null;
    this.active.clear();
  }

  /**
   * Claims and dispatches as much due work as the concurrency budget allows.
   * Exposed so tests and manual triggers can advance the loop without real timers.
   */
  async tick(): Promise<void> {
    if (!this.running) return;
    this.lastTickAt = this.clock();

    // Only claim work this daemon can actually run. An unregistered kind stays QUEUED rather
    // than being claimed and failing its way through the retry budget.
    const claimableKinds = this.dispatcher.registeredKinds();
    if (claimableKinds.length === 0) return;

    // Re-checking `running` inside the loop means a stop() that lands mid-tick still
    // cannot produce a new claim.
    while (this.running && this.active.size < this.maxConcurrentJobs) {
      const job = this.repository.claimNext(this.clock(), claimableKinds);
      if (!job) return;
      this.startDispatch(job);
    }
  }

  getStatus(): AutomationSchedulerStatus {
    return {
      running: this.running,
      startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      lastTickAt: this.lastTickAt === null ? null : new Date(this.lastTickAt).toISOString(),
      activeJobs: this.active.size
    };
  }

  /** How many RUNNING jobs the last start() had to recover after a restart. */
  getRecoveredJobCount(): number {
    return this.recoveredJobs;
  }

  getJobCounts(): AutomationJobCounts {
    const byStatus = this.repository.countJobsByStatus();
    return {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus
    };
  }

  private scheduleNextTick(): void {
    if (!this.running) return;
    this.cancelTimer = this.setTimer(() => {
      this.cancelTimer = null;
      this.currentTick = this.runScheduledTick();
    }, this.tickIntervalMs);
  }

  private async runScheduledTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      // A failed tick must never surface as an unhandled rejection: the timer keeps
      // polling, and a transient database or handler error is retried next interval.
      this.onError(error);
    } finally {
      this.currentTick = null;
      // Rescheduling after the tick returns keeps ticks from overlapping.
      this.scheduleNextTick();
    }
  }

  private startDispatch(job: AutomationJobRecord): void {
    // The rejection handler is attached synchronously so a failing bookkeeping write can
    // never become an unhandled rejection while the promise sits in `active`.
    const run = this.runJob(job)
      .catch((error) => {
        this.onError(error);
      })
      .finally(() => {
        this.active.delete(job.id);
      });
    this.active.set(job.id, run);
  }

  private async runJob(job: AutomationJobRecord): Promise<void> {
    let dispatchError: unknown;
    let dispatched = false;
    try {
      await this.dispatcher.dispatch(job);
      dispatched = true;
    } catch (error) {
      dispatchError = error;
    }

    // Bookkeeping is deliberately outside the try above: if the status write fails after
    // the work succeeded, the job must not be reclassified as a failure and re-run.
    if (dispatched) {
      this.repository.markSucceeded(job.id, this.clock());
      return;
    }

    const failure = describeAutomationFailure(dispatchError);
    const now = this.clock();
    // claimNext() already counted this attempt, so `attempts` is the number that just failed.
    if (job.attempts >= job.maxAttempts) {
      this.repository.markFailed(job.id, failure, now);
      return;
    }
    this.repository.markRetryable(job.id, failure, now + this.backoffDelayMs(job.attempts), now);
  }

  private backoffDelayMs(attempts: number): number {
    if (this.backoffScheduleMs.length === 0) return 0;
    const index = Math.min(Math.max(attempts, 1), this.backoffScheduleMs.length) - 1;
    return this.backoffScheduleMs[index] ?? 0;
  }
}

/**
 * Normalises anything a dispatcher throws into a job failure.
 * The message is collapsed and clipped so a handler cannot dump a transcript into a job row.
 */
export function describeAutomationFailure(error: unknown): AutomationJobFailure {
  const code = readErrorCode(error) ?? "AUTOMATION_JOB_FAILED";
  const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return { code, message: clipFailureMessage(rawMessage) };
}

function readErrorCode(error: unknown): string | null {
  if (error instanceof AutomationDispatchError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim().length > 0) return code;
  }
  return null;
}

const maxFailureMessageLength = 300;

function clipFailureMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "Automation job failed";
  return collapsed.length <= maxFailureMessageLength ? collapsed : `${collapsed.slice(0, maxFailureMessageLength)}…`;
}

export type { AutomationJobDto, AutomationJobKind, AutomationJobStatus };
