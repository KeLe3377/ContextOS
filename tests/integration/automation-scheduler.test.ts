import { describe, expect, test } from "vitest";
import {
  AutomationDispatchError,
  AutomationScheduler,
  automationBackoffScheduleMs,
  describeAutomationFailure,
  type AutomationJobDispatcher,
  type AutomationSchedulerOptions,
  type AutomationSchedulerRepository,
  type AutomationSetTimer
} from "../../packages/application/src/core/automation-scheduler.js";
import type { AutomationJobStatus } from "../../packages/contracts/src/automation.js";
import { activeAutomationJobKinds, automationJobKindSchema, type AutomationJobKind } from "../../packages/contracts/src/automation.js";
import type { AutomationJobFailure, AutomationJobRecord } from "../../packages/infrastructure/src/sqlite/automation-repository.js";

const baseTime = 1_760_000_000_000;

function createJob(id: string, overrides: Partial<AutomationJobRecord> = {}): AutomationJobRecord {
  return {
    id,
    kind: "SYNC_SESSION_TRANSCRIPT",
    projectId: "proj_1",
    sessionId: "sess_1",
    resourceType: "SESSION",
    resourceId: "sess_1",
    idempotencyKey: `SYNC_SESSION_TRANSCRIPT:${id}`,
    status: "QUEUED",
    availableAt: new Date(baseTime).toISOString(),
    attempts: 0,
    maxAttempts: 4,
    failureCode: null,
    failureMessage: null,
    startedAt: null,
    endedAt: null,
    createdAt: new Date(baseTime).toISOString(),
    updatedAt: new Date(baseTime).toISOString(),
    revision: 1,
    payload: { transcriptPath: "rollout.jsonl" },
    ...overrides
  };
}

class FakeAutomationRepository implements AutomationSchedulerRepository {
  readonly calls: string[] = [];
  readonly retryDelays: number[] = [];
  readonly failedCodes: string[] = [];
  readonly statusCounts: Record<AutomationJobStatus, number> = { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, CANCELED: 0 };
  recoveredJobs = 0;
  failClaimWith: Error | null = null;
  failNextMarkSucceeded: Error | null = null;

  private readonly jobs = new Map<string, { record: AutomationJobRecord; dueAt: number }>();

  addJob(record: AutomationJobRecord, dueAt = baseTime): void {
    this.jobs.set(record.id, { record, dueAt });
  }

  job(id: string): AutomationJobRecord {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error(`Unknown fake job ${id}`);
    return entry.record;
  }

  recoverRunning(now: number): number {
    this.calls.push(`recoverRunning:${now}`);
    return this.recoveredJobs;
  }

  claimNext(now: number, kinds: readonly AutomationJobKind[]): AutomationJobRecord | null {
    if (this.failClaimWith) throw this.failClaimWith;
    const claimable = new Set(kinds);
    const due = [...this.jobs.values()]
      .filter((entry) => entry.record.status === "QUEUED" && entry.dueAt <= now && claimable.has(entry.record.kind))
      .sort((left, right) => left.dueAt - right.dueAt);
    const next = due[0];
    if (!next) return null;
    next.record = { ...next.record, status: "RUNNING", attempts: next.record.attempts + 1 };
    this.calls.push(`claimNext:${next.record.id}`);
    return next.record;
  }

  markSucceeded(jobId: string, now: number): void {
    if (this.failNextMarkSucceeded) {
      const error = this.failNextMarkSucceeded;
      this.failNextMarkSucceeded = null;
      throw error;
    }
    const entry = this.jobs.get(jobId)!;
    entry.record = { ...entry.record, status: "SUCCEEDED" };
    this.calls.push(`markSucceeded:${jobId}:${now}`);
  }

  markRetryable(jobId: string, failure: AutomationJobFailure, availableAt: number, now: number): void {
    const entry = this.jobs.get(jobId)!;
    entry.record = { ...entry.record, status: "QUEUED", failureCode: failure.code, failureMessage: failure.message };
    entry.dueAt = availableAt;
    this.retryDelays.push(availableAt - now);
    this.calls.push(`markRetryable:${jobId}:${failure.code}`);
  }

  markFailed(jobId: string, failure: AutomationJobFailure, now: number): void {
    const entry = this.jobs.get(jobId)!;
    entry.record = { ...entry.record, status: "FAILED", failureCode: failure.code, failureMessage: failure.message };
    this.failedCodes.push(failure.code);
    this.calls.push(`markFailed:${jobId}:${failure.code}`);
  }

  countJobsByStatus(): Record<AutomationJobStatus, number> {
    const counts = { ...this.statusCounts };
    for (const entry of this.jobs.values()) counts[entry.record.status] += 1;
    return counts;
  }
}

class FakeDispatcher implements AutomationJobDispatcher {
  readonly dispatched: string[] = [];
  mode: "resolve" | "reject" | "manual" = "resolve";
  error: unknown = new Error("dispatch failed");
  kinds: AutomationJobKind[] = [...automationJobKindSchema.options];

  private readonly gates = new Map<string, () => void>();

  registeredKinds(): readonly AutomationJobKind[] {
    return this.kinds;
  }

  dispatch(job: AutomationJobRecord): Promise<void> {
    this.dispatched.push(job.id);
    if (this.mode === "resolve") return Promise.resolve();
    if (this.mode === "reject") return Promise.reject(this.error);
    return new Promise<void>((resolve) => {
      this.gates.set(job.id, resolve);
    });
  }

  settle(jobId: string): void {
    this.gates.get(jobId)?.();
    this.gates.delete(jobId);
  }
}

class FakeClock {
  private current = baseTime;

  readonly now = (): number => this.current;

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }

  value(): number {
    return this.current;
  }
}

class FakeTimer {
  handler: (() => void) | null = null;
  delayMs: number | null = null;
  cancels = 0;

  readonly setTimer: AutomationSetTimer = (handler, delayMs) => {
    this.handler = handler;
    this.delayMs = delayMs;
    return () => {
      this.cancels += 1;
      this.handler = null;
      this.delayMs = null;
    };
  };

  async fire(): Promise<void> {
    const handler = this.handler;
    this.handler = null;
    this.delayMs = null;
    handler?.();
    await flushAsyncWork();
  }
}

/** Drains the microtask queue (and one macrotask turn) so fire-and-forget dispatches settle. */
async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function createScheduler(overrides: Partial<AutomationSchedulerOptions> = {}) {
  const repository = new FakeAutomationRepository();
  const dispatcher = new FakeDispatcher();
  const clock = new FakeClock();
  const timer = new FakeTimer();
  const scheduler = new AutomationScheduler({
    repository,
    dispatcher,
    clock: clock.now,
    setTimer: timer.setTimer,
    ...overrides
  });
  return { scheduler, repository, dispatcher, clock, timer };
}

describe("AutomationScheduler lifecycle", () => {
  test("recovers RUNNING jobs exactly once, even when start() is repeated", () => {
    const { scheduler, repository, timer } = createScheduler();
    repository.recoveredJobs = 3;

    scheduler.start();
    scheduler.start();
    scheduler.start();

    expect(repository.calls.filter((call) => call.startsWith("recoverRunning"))).toHaveLength(1);
    expect(scheduler.getRecoveredJobCount()).toBe(3);
    expect(scheduler.getStatus().running).toBe(true);
    expect(scheduler.getStatus().startedAt).toBe(new Date(baseTime).toISOString());
    // Only one timer is owned, and it polls at the configured interval.
    expect(timer.delayMs).toBe(1_000);
    expect(timer.cancels).toBe(0);
  });

  test("does nothing before start()", async () => {
    const { scheduler, repository, dispatcher } = createScheduler();
    repository.addJob(createJob("job_a"));

    await scheduler.tick();

    expect(dispatcher.dispatched).toEqual([]);
    expect(repository.calls).toEqual([]);
    expect(scheduler.getStatus()).toMatchObject({ running: false, lastTickAt: null, activeJobs: 0 });
  });

  test("honours the configured tick interval", () => {
    const { scheduler, timer } = createScheduler({ tickIntervalMs: 15_000 });
    scheduler.start();
    expect(timer.delayMs).toBe(15_000);
  });

  test("drives a tick from the injected timer and reschedules itself", async () => {
    const { scheduler, repository, dispatcher, clock, timer } = createScheduler();
    repository.addJob(createJob("job_a"));

    scheduler.start();
    await timer.fire();

    expect(dispatcher.dispatched).toEqual(["job_a"]);
    expect(scheduler.getStatus().lastTickAt).toBe(new Date(clock.value()).toISOString());
    // A completed tick must queue the next one rather than stopping.
    expect(timer.delayMs).toBe(1_000);
  });

  test("stop() cancels the timer and prevents new claims", async () => {
    const { scheduler, repository, dispatcher, timer } = createScheduler();
    dispatcher.mode = "manual";
    repository.addJob(createJob("job_a"), baseTime);
    repository.addJob(createJob("job_b"), baseTime);

    scheduler.start();
    await scheduler.tick();
    expect(dispatcher.dispatched).toEqual(["job_a"]);

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await flushAsyncWork();
    // stop() must wait for the in-flight dispatch instead of resolving immediately.
    expect(stopped).toBe(false);
    expect(timer.cancels).toBe(1);

    await scheduler.tick();
    expect(dispatcher.dispatched).toEqual(["job_a"]);

    dispatcher.settle("job_a");
    await stopping;

    expect(stopped).toBe(true);
    expect(scheduler.getStatus()).toMatchObject({ running: false, activeJobs: 0 });
    expect(repository.job("job_a").status).toBe("SUCCEEDED");
    // The second job was never claimed.
    expect(repository.job("job_b").status).toBe("QUEUED");
  });

  test("stop() is safe to call twice", async () => {
    const { scheduler } = createScheduler();
    scheduler.start();
    await scheduler.stop();
    await scheduler.stop();
    expect(scheduler.getStatus().running).toBe(false);
  });
});

describe("AutomationScheduler dispatch and retry", () => {
  test("claims at most the configured concurrency per tick", async () => {
    const { scheduler, repository, dispatcher } = createScheduler({ maxConcurrentJobs: 2 });
    dispatcher.mode = "manual";
    repository.addJob(createJob("job_a"), baseTime);
    repository.addJob(createJob("job_b"), baseTime);
    repository.addJob(createJob("job_c"), baseTime);

    scheduler.start();
    await scheduler.tick();

    expect(dispatcher.dispatched).toEqual(["job_a", "job_b"]);
    expect(scheduler.getStatus().activeJobs).toBe(2);
    expect(repository.job("job_c").status).toBe("QUEUED");
  });

  test("claims due jobs in due order and skips jobs that are not due yet", async () => {
    const { scheduler, repository, dispatcher, clock } = createScheduler();
    dispatcher.mode = "manual";
    repository.addJob(createJob("job_late"), baseTime + 5_000);
    repository.addJob(createJob("job_early"), baseTime - 1_000);

    scheduler.start();
    await scheduler.tick();
    // The late job is not due yet, so only the early one is claimed.
    expect(dispatcher.dispatched).toEqual(["job_early"]);

    dispatcher.settle("job_early");
    await flushAsyncWork();
    await scheduler.tick();
    expect(dispatcher.dispatched).toEqual(["job_early"]);

    clock.advance(5_000);
    await scheduler.tick();
    expect(dispatcher.dispatched).toEqual(["job_early", "job_late"]);
  });

  test("never claims a job kind that has no registered handler", async () => {
    const { scheduler, repository, dispatcher } = createScheduler();
    dispatcher.kinds = ["DISCOVER_CODEX_THREADS"];
    repository.addJob(createJob("job_sync"));

    scheduler.start();
    await scheduler.tick();
    await flushAsyncWork();

    // An unregistered kind keeps its retry budget and stays QUEUED instead of failing out.
    expect(dispatcher.dispatched).toEqual([]);
    expect(repository.job("job_sync")).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(repository.calls).not.toContain("claimNext:job_sync");

    dispatcher.kinds = ["SYNC_SESSION_TRANSCRIPT"];
    await scheduler.tick();
    await flushAsyncWork();
    expect(dispatcher.dispatched).toEqual(["job_sync"]);
  });

  test("leaves queued compaction and extraction jobs untouched when only the active kinds run", async () => {
    const { scheduler, repository, dispatcher } = createScheduler();
    dispatcher.kinds = [...activeAutomationJobKinds];
    repository.addJob(createJob("job_queued_before_pruning", { kind: "COMPACT_EVIDENCE", resourceType: "EVIDENCE_SNAPSHOT", resourceId: "ev_1" }));
    repository.addJob(createJob("job_queued_extraction", { kind: "EXTRACT_EVIDENCE_CONTEXT", resourceType: "COMPACTION_ARTIFACT", resourceId: "cmp_1" }));
    repository.addJob(createJob("job_sync", { kind: "SYNC_SESSION_TRANSCRIPT" }));

    scheduler.start();
    await scheduler.tick();
    await flushAsyncWork();

    // Historical rows stay QUEUED with their retry budget intact: they are never claimed and
    // therefore can never be marked SUCCEEDED to hide the fact that nothing ran.
    expect(dispatcher.dispatched).toEqual(["job_sync"]);
    expect(repository.job("job_queued_before_pruning")).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(repository.job("job_queued_extraction")).toMatchObject({ status: "QUEUED", attempts: 0 });
  });

  test("claims nothing when no handler is registered at all", async () => {
    const { scheduler, repository, dispatcher } = createScheduler();
    dispatcher.kinds = [];
    repository.addJob(createJob("job_a"));

    scheduler.start();
    await scheduler.tick();
    await flushAsyncWork();

    expect(dispatcher.dispatched).toEqual([]);
    expect(repository.job("job_a").status).toBe("QUEUED");
  });

  test("marks a successful dispatch SUCCEEDED", async () => {
    const { scheduler, repository, dispatcher } = createScheduler();
    repository.addJob(createJob("job_a"));

    scheduler.start();
    await scheduler.tick();
    await flushAsyncWork();

    expect(repository.job("job_a").status).toBe("SUCCEEDED");
    expect(repository.calls).toContain(`markSucceeded:job_a:${baseTime}`);
    expect(scheduler.getStatus().activeJobs).toBe(0);
  });

  test("schedules the documented 5s, 30s, 2m and 10m retry delays", async () => {
    const { scheduler, repository, dispatcher, clock } = createScheduler();
    dispatcher.mode = "reject";
    dispatcher.error = new AutomationDispatchError("EXTRACTOR_TIMEOUT", "Codex CLI timed out");
    repository.addJob(createJob("job_a", { maxAttempts: 5 }));

    scheduler.start();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      clock.advance(700_000);
      await scheduler.tick();
      await flushAsyncWork();
    }

    expect(repository.retryDelays).toEqual([5_000, 30_000, 120_000, 600_000]);
    expect(repository.job("job_a")).toMatchObject({ status: "QUEUED", attempts: 4, failureCode: "EXTRACTOR_TIMEOUT" });
    expect(repository.failedCodes).toEqual([]);
  });

  test("turns the fourth failed attempt into FAILED under the default budget", async () => {
    const { scheduler, repository, dispatcher, clock } = createScheduler();
    dispatcher.mode = "reject";
    dispatcher.error = new AutomationDispatchError("TRANSCRIPT_UNREADABLE", "Rollout file disappeared");
    repository.addJob(createJob("job_a"));

    scheduler.start();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      clock.advance(700_000);
      await scheduler.tick();
      await flushAsyncWork();
    }

    expect(repository.retryDelays).toEqual([5_000, 30_000, 120_000]);
    expect(repository.job("job_a")).toMatchObject({ status: "FAILED", attempts: 4, failureCode: "TRANSCRIPT_UNREADABLE" });
    expect(repository.failedCodes).toEqual(["TRANSCRIPT_UNREADABLE"]);

    // A FAILED job is terminal: further ticks never touch it again.
    clock.advance(700_000);
    await scheduler.tick();
    await flushAsyncWork();
    expect(repository.job("job_a").status).toBe("FAILED");
    expect(dispatcher.dispatched).toHaveLength(4);
  });

  test("keeps dispatching other jobs while one is retrying", async () => {
    const { scheduler, repository, dispatcher, clock } = createScheduler();
    dispatcher.mode = "reject";
    repository.addJob(createJob("job_a"));
    repository.addJob(createJob("job_b"), baseTime + 1);

    scheduler.start();
    await scheduler.tick();
    await flushAsyncWork();

    // With concurrency 1 only the first job is attempted this tick.
    expect(dispatcher.dispatched).toEqual(["job_a"]);

    clock.advance(1_000);
    await scheduler.tick();
    await flushAsyncWork();
    expect(dispatcher.dispatched).toEqual(["job_a", "job_b"]);
  });

  test("reports job counts for the status endpoint", () => {
    const { scheduler, repository } = createScheduler();
    repository.addJob(createJob("job_a"));
    repository.addJob(createJob("job_b", { status: "SUCCEEDED" }));

    expect(scheduler.getJobCounts()).toEqual({
      total: 2,
      byStatus: { QUEUED: 1, RUNNING: 0, SUCCEEDED: 1, FAILED: 0, CANCELED: 0 }
    });
  });

  test("exposes the documented backoff schedule", () => {
    expect([...automationBackoffScheduleMs]).toEqual([5_000, 30_000, 120_000, 600_000]);
  });

  test("reports a failing tick through onError and keeps polling", async () => {
    const errors: unknown[] = [];
    const { scheduler, repository, timer } = createScheduler({ onError: (error) => errors.push(error) });
    repository.failClaimWith = new Error("database is closed");
    scheduler.start();

    await timer.fire();
    await flushAsyncWork();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "database is closed" });
    // The loop survives the failure and schedules the next poll.
    expect(timer.delayMs).toBe(1_000);
    expect(scheduler.getStatus().running).toBe(true);
  });

  test("reports a failed bookkeeping write instead of leaking a rejection", async () => {
    const errors: unknown[] = [];
    const { scheduler, repository, dispatcher } = createScheduler({ onError: (error) => errors.push(error) });
    repository.addJob(createJob("job_a"));
    repository.failNextMarkSucceeded = new Error("database is closed");

    scheduler.start();
    await scheduler.tick();
    await flushAsyncWork();

    expect(dispatcher.dispatched).toEqual(["job_a"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "database is closed" });
    // The dispatch still cleared its slot, so the next tick can claim again.
    expect(scheduler.getStatus().activeJobs).toBe(0);
  });
});

describe("automation failure normalisation", () => {
  test("keeps an explicit dispatch failure code", () => {
    expect(describeAutomationFailure(new AutomationDispatchError("EXTRACTOR_UNAVAILABLE", "Codex CLI missing")))
      .toEqual({ code: "EXTRACTOR_UNAVAILABLE", message: "Codex CLI missing" });
  });

  test("keeps the code of a coded application error", () => {
    const error = Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });
    expect(describeAutomationFailure(error)).toEqual({ code: "NOT_FOUND", message: "Session not found" });
  });

  test("falls back to a generic code for uncoded failures", () => {
    expect(describeAutomationFailure(new Error("boom")).code).toBe("AUTOMATION_JOB_FAILED");
    expect(describeAutomationFailure("plain string").code).toBe("AUTOMATION_JOB_FAILED");
    expect(describeAutomationFailure(undefined)).toEqual({ code: "AUTOMATION_JOB_FAILED", message: "Automation job failed" });
  });

  test("collapses and clips long messages so a handler cannot dump a transcript into a job row", () => {
    const failure = describeAutomationFailure(new Error(`line one\n\nline two   ${"x".repeat(500)}`));
    expect(failure.message.startsWith("line one line two ")).toBe(true);
    expect(failure.message.endsWith("…")).toBe(true);
    expect(failure.message.length).toBe(301);
  });
});
