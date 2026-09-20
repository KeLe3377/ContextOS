import type { AutomationJobKind } from "../../../contracts/src/automation.js";
import type { AutomationJobRecord } from "../../../infrastructure/src/sqlite/automation-repository.js";
import { AutomationDispatchError, type AutomationJobDispatcher } from "./automation-scheduler.js";

/**
 * Routes a claimed job to the handler registered for its kind.
 *
 * Routing lives here rather than inside AutomationScheduler so the scheduler stays a pure
 * lifecycle component (claim, dispatch, retry, recover) and every domain decision stays in
 * AutomationService. A kind without a handler fails loudly instead of being marked done.
 */

export type AutomationJobHandler = (job: AutomationJobRecord) => Promise<void>;

export class AutomationJobRouter implements AutomationJobDispatcher {
  private readonly handlers = new Map<AutomationJobKind, AutomationJobHandler>();

  register(kind: AutomationJobKind, handler: AutomationJobHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  registeredKinds(): AutomationJobKind[] {
    return [...this.handlers.keys()];
  }

  async dispatch(job: AutomationJobRecord): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      throw new AutomationDispatchError("AUTOMATION_HANDLER_MISSING", `No handler registered for ${job.kind}`);
    }
    await handler(job);
  }
}
