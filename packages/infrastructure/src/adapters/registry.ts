import type { AgentAdapter } from "../../../application/src/ports/agent-adapter.js";
import { ContextOsError } from "../../../shared/src/errors.js";

export class AgentAdapterRegistry {
  private readonly adapters: Map<string, AgentAdapter>;

  constructor(adapters: AgentAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  list(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  get(id: string): AgentAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  getOrThrow(id: string): AgentAdapter {
    const adapter = this.get(id);
    if (!adapter) throw new ContextOsError("INVALID_ARGUMENT", "Unsupported agent adapter", { id });
    return adapter;
  }
}
