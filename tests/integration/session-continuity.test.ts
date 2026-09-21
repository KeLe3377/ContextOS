import { describe, expect, test } from "vitest";
import {
  buildSessionContinuity,
  sessionContinuityMaxChars,
  sessionContinuityNextActionMaxChars,
  type SessionContinuityEvidence
} from "../../packages/application/src/core/session-continuity.js";
import { encodeTranscriptEvents, type TranscriptEventIdentity } from "../../packages/application/src/core/transcript-event-codec.js";
import type { AgentTranscriptEvent } from "../../packages/application/src/ports/agent-adapter.js";

const identity: TranscriptEventIdentity = {
  projectId: "proj_1",
  sessionId: "sess_1",
  externalSessionId: "01a0ffff-0000-7000-8000-000000000001",
  parserVersion: "codex-jsonl.v5",
  stream: "desktop-sync"
};

/**
 * Every fixture goes through the canonical codec, because the builder must never grow its own
 * transcript parser: it only ever reads what `decodeTranscriptEvents` can read back.
 */
function evidence(id: string, events: AgentTranscriptEvent[]): SessionContinuityEvidence {
  return { id, canonicalText: encodeTranscriptEvents(events, identity) };
}

function message(ordinal: number, role: "user" | "assistant", text: string): AgentTranscriptEvent {
  return { ordinal, kind: "message", role, text };
}

function toolCall(ordinal: number, name: string, callId: string, text: string): AgentTranscriptEvent {
  return { ordinal, kind: "tool_call", name, callId, text };
}

function toolResult(ordinal: number, callId: string, text: string, isError?: boolean): AgentTranscriptEvent {
  return isError === undefined
    ? { ordinal, kind: "tool_result", callId, text }
    : { ordinal, kind: "tool_result", callId, text, isError };
}

describe("buildSessionContinuity", () => {
  test("keeps captured messages in their original chronological order", () => {
    const result = buildSessionContinuity({
      evidence: [
        evidence("ev_1", [message(1, "user", "first question"), message(2, "assistant", "first answer")]),
        evidence("ev_2", [message(3, "user", "second question"), message(4, "assistant", "second answer")])
      ]
    });

    const positions = ["first question", "first answer", "second question", "second answer"].map((needle) =>
      result.contextText.indexOf(needle)
    );
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  test("keeps failed and unknown tool results but drops successful ones when the budget is tight", () => {
    const result = buildSessionContinuity({
      evidence: [
        evidence("ev_1", [
          message(1, "user", "run the checks"),
          toolCall(2, "shell", "call_a", '{"command":"npm test"}'),
          toolResult(3, "call_a", "all green", false),
          toolResult(4, "call_b", "command not found", true),
          toolResult(5, "call_c", "outcome never reported")
        ])
      ],
      maxChars: 110
    });

    expect(result.contextText).toContain("run the checks");
    expect(result.contextText).toContain("command not found");
    expect(result.contextText).toContain("outcome never reported");
    expect(result.contextText).not.toContain("all green");
  });

  test("drops successful tool output before dropping conversation messages", () => {
    const result = buildSessionContinuity({
      evidence: [
        evidence("ev_1", [
          message(1, "user", "summarise the run"),
          toolResult(2, "call_a", `${"x".repeat(400)}`, false),
          message(3, "assistant", "the run finished")
        ])
      ],
      maxChars: 120
    });

    expect(result.contextText).toContain("summarise the run");
    expect(result.contextText).toContain("the run finished");
    expect(result.contextText).not.toContain("xxxx");
  });

  test("removes ContextOS handoff prefixes through the existing sanitizer", () => {
    const result = buildSessionContinuity({
      evidence: [
        evidence("ev_1", [
          { ordinal: 1, kind: "message", role: "user", text: "# AGENTS.md instructions\nreal user question" },
          { ordinal: 2, kind: "message", role: "user", text: "<environment_context>\ninjected" },
          message(3, "user", "real user question")
        ])
      ]
    });

    expect(result.contextText).not.toContain("# AGENTS.md instructions");
    expect(result.contextText).not.toContain("<environment_context>");
    expect(result.contextText).not.toContain("injected");
    expect(result.contextText).toContain("real user question");
  });

  test("caps the excerpt at the session continuity budget", () => {
    const events: AgentTranscriptEvent[] = [];
    for (let index = 0; index < 40; index += 1) {
      events.push(message(index + 1, index % 2 === 0 ? "user" : "assistant", `m${index}-${"y".repeat(900)}`));
    }

    const result = buildSessionContinuity({ evidence: [evidence("ev_1", events)] });

    expect(result.contextText.length).toBeLessThanOrEqual(sessionContinuityMaxChars);
    // The most recent captured message survives; the oldest ones are the ones that go.
    expect(result.contextText).toContain("m39-");
    expect(result.contextText).not.toContain("m0-");
  });

  test("takes nextAction from the last non-empty user message and bounds it", () => {
    const longQuestion = `q${"z".repeat(900)}`;
    const result = buildSessionContinuity({
      evidence: [
        evidence("ev_1", [
          message(1, "user", "first question"),
          message(2, "assistant", "an answer"),
          message(3, "user", "   "),
          message(4, "user", longQuestion)
        ])
      ]
    });

    expect(result.nextAction).toBe(longQuestion.slice(0, sessionContinuityNextActionMaxChars));
    expect(result.nextAction!.length).toBe(sessionContinuityNextActionMaxChars);
  });

  test("leaves nextAction null when no user message was captured", () => {
    const result = buildSessionContinuity({ evidence: [evidence("ev_1", [message(1, "assistant", "only an answer")])] });
    expect(result.nextAction).toBeNull();
  });

  test("records source evidence ids in the order they were given", () => {
    const first = evidence("ev_1", [message(1, "user", "one")]);
    const second = evidence("ev_2", [message(2, "user", "two")]);

    expect(buildSessionContinuity({ evidence: [first, second] }).evidenceSnapshotIds).toEqual(["ev_1", "ev_2"]);
    expect(buildSessionContinuity({ evidence: [second, first] }).evidenceSnapshotIds).toEqual(["ev_2", "ev_1"]);
    expect(buildSessionContinuity({ evidence: [first, first, second] }).evidenceSnapshotIds).toEqual(["ev_1", "ev_2"]);
  });

  test("is deterministic for identical input", () => {
    const input = {
      evidence: [
        evidence("ev_1", [
          message(1, "user", "what changed"),
          toolResult(2, "call_a", "boom", true),
          message(3, "assistant", "here is what changed")
        ]),
        evidence("ev_2", [message(4, "user", "and then")])
      ]
    };

    expect(buildSessionContinuity(input)).toEqual(buildSessionContinuity(input));
  });

  test("summarises from the last assistant message and degrades safely with no evidence", () => {
    const withAssistant = buildSessionContinuity({
      evidence: [evidence("ev_1", [message(1, "user", "question"), message(2, "assistant", "the answer")])]
    });
    expect(withAssistant.summary).toBe("the answer");

    const empty = buildSessionContinuity({ evidence: [] });
    expect(empty.contextText).toBe("");
    expect(empty.evidenceSnapshotIds).toEqual([]);
    expect(empty.nextAction).toBeNull();
    expect(empty.summary.length).toBeGreaterThan(0);
  });
});
