import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AgentAdapter } from "../../packages/application/src/ports/agent-adapter.js";
import { agentCapabilityValues, type AgentCapability } from "../../packages/contracts/src/runtime.js";
import { ProcessSupervisor, type ProcessExitInfo } from "../../packages/infrastructure/src/process-supervisor.js";

export type AgentAdapterContractFixture = {
  adapter: AgentAdapter;
  completedAdapter: AgentAdapter;
  unavailableAdapter: AgentAdapter;
  capabilities: AgentCapability[];
  expectedResumeArgs?: string[];
  cwd: string;
  externalSessionId: string;
  cleanup(): Promise<void>;
};

export function runAgentAdapterContract(
  name: string,
  setup: () => Promise<AgentAdapterContractFixture>
): void {
  describe(`${name} shared contract`, () => {
    let fixture: AgentAdapterContractFixture;

    beforeAll(async () => {
      fixture = await setup();
    });

    afterAll(async () => {
      await fixture?.cleanup();
    });

    test("returns normalized discovery metadata and known capabilities", () => {
      const status = fixture.adapter.discover();
      expect(status).toMatchObject({
        id: fixture.adapter.id,
        displayName: fixture.adapter.displayName,
        available: true,
        error: null
      });
      expect(status.command).not.toBe("");
      expect(status.version).not.toBeNull();
      expect(new Set(status.capabilities).size).toBe(status.capabilities.length);
      expect(status.capabilities.every((capability) => agentCapabilityValues.includes(capability))).toBe(true);
      expect(status.capabilities).toEqual(fixture.capabilities);
    });

    test("normalizes unavailable discovery without advertising a version", () => {
      const status = fixture.unavailableAdapter.discover();
      expect(status).toMatchObject({
        id: fixture.unavailableAdapter.id,
        displayName: fixture.unavailableAdapter.displayName,
        available: false,
        version: null,
        error: expect.any(String),
        capabilities: fixture.capabilities
      });
    });

    test("builds normalized launch metadata without changing the working directory", () => {
      expect(fixture.adapter.buildLaunchInfo({ cwd: fixture.cwd })).toMatchObject({
        adapterId: fixture.adapter.id,
        cwd: fixture.cwd,
        mode: "queued-job",
        operation: "launch",
        externalSessionId: null,
        args: expect.any(Array)
      });
      expect(fixture.adapter.buildResumeInfo({ cwd: fixture.cwd, externalSessionId: fixture.externalSessionId, prompt: "continue" })).toMatchObject({
        adapterId: fixture.adapter.id,
        cwd: fixture.cwd,
        mode: "queued-job",
        operation: "resume",
        externalSessionId: fixture.externalSessionId,
        args: expect.arrayContaining(fixture.expectedResumeArgs ?? ["resume", fixture.externalSessionId, "continue"])
      });
    });

    test("imports a deterministic normalized transcript by external session id", () => {
      const discovered = fixture.adapter.importTranscript({ cwd: fixture.cwd });
      const explicit = fixture.adapter.importTranscript({ cwd: fixture.cwd, externalSessionId: fixture.externalSessionId });
      expect(discovered).toEqual(explicit);
      expect(discovered).toMatchObject({
        externalSessionId: fixture.externalSessionId,
        contentText: expect.any(String),
        parserVersion: expect.any(String),
        messageCount: expect.any(Number),
        roleCounts: { user: expect.any(Number), assistant: expect.any(Number) },
        turnCount: expect.any(Number),
        messageOrdinalStart: expect.any(Number),
        messageOrdinalEnd: expect.any(Number),
        truncated: expect.any(Boolean)
      });
      expect(discovered.contentText.length).toBeGreaterThan(0);
      expect(discovered.messageCount).toBeGreaterThan(0);
      expect(discovered.messageCount).toBe(discovered.roleCounts.user + discovered.roleCounts.assistant);
      expect(discovered.turnCount).toBe(discovered.roleCounts.user);
      expect(discovered.messageOrdinalStart).toBeGreaterThan(0);
      expect(discovered.messageOrdinalEnd).toBeGreaterThanOrEqual(discovered.messageOrdinalStart);
      expect(Number.isNaN(Date.parse(discovered.sourceUpdatedAt))).toBe(false);
    });

    test("maps successful process output and exit information", async () => {
      const supervisor = new ProcessSupervisor();
      const exited = new Promise<ProcessExitInfo>((resolve) => {
        fixture.completedAdapter.launch({ cwd: fixture.cwd, supervisor, onExit: resolve });
      });
      const result = await withTimeout(exited, 2_000, `${name} successful process did not exit`);
      expect(result).toMatchObject({
        code: 0,
        signal: null,
        stdout: expect.stringContaining("contract-stdout"),
        stderr: expect.stringContaining("contract-stderr"),
        outputTruncated: false
      });
    });

    test("launches, inspects, and interrupts a process through the supervisor", async () => {
      const supervisor = new ProcessSupervisor();
      let pid: number | null = null;
      let resolveExit: ((exit: ProcessExitInfo) => void) | undefined;
      const exited = new Promise<ProcessExitInfo>((resolve) => {
        resolveExit = resolve;
      });
      try {
        const launched = fixture.adapter.launch({ cwd: fixture.cwd, supervisor, onExit: (exit) => resolveExit?.(exit) });
        pid = launched.pid;
        expect(launched.launch).toEqual(fixture.adapter.buildLaunchInfo({ cwd: fixture.cwd }));
        expect(fixture.adapter.inspectStatus({ pid, supervisor })).toEqual({ pid, managed: true, running: true });
        expect(fixture.adapter.interrupt({ pid, supervisor })).toBe(true);
        await withTimeout(exited, 2_000, `${name} process did not exit after interrupt`);
        expect(fixture.adapter.inspectStatus({ pid, supervisor })).toEqual({ pid, managed: false, running: false });
      } finally {
        if (pid !== null && supervisor.inspect(pid).running) fixture.adapter.interrupt({ pid, supervisor });
      }
    });

    test("resumes an explicit external session through the supervisor", async () => {
      const supervisor = new ProcessSupervisor();
      let pid: number | null = null;
      let resolveExit: ((exit: ProcessExitInfo) => void) | undefined;
      const exited = new Promise<ProcessExitInfo>((resolve) => {
        resolveExit = resolve;
      });
      try {
        const resumed = fixture.adapter.resume({
          cwd: fixture.cwd,
          externalSessionId: fixture.externalSessionId,
          prompt: "continue",
          supervisor,
          onExit: (exit) => resolveExit?.(exit)
        });
        pid = resumed.pid;
        expect(resumed.launch).toMatchObject({ operation: "resume", externalSessionId: fixture.externalSessionId });
        expect(fixture.adapter.inspectStatus({ pid, supervisor })).toEqual({ pid, managed: true, running: true });
        expect(fixture.adapter.interrupt({ pid, supervisor })).toBe(true);
        await withTimeout(exited, 2_000, `${name} resumed process did not exit after interrupt`);
      } finally {
        if (pid !== null && supervisor.inspect(pid).running) fixture.adapter.interrupt({ pid, supervisor });
      }
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
