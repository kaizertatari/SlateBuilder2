// Per-request context propagated through the orchestrator's async cascade.
// Lets upstream helpers prefix log lines with a stable [reqId] without
// threading the id through every function signature.

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function runWithRequestContext(ctx, fn) {
  return storage.run(ctx, fn);
}

export function logPrefix() {
  const ctx = storage.getStore();
  return ctx?.reqId ? `[${ctx.reqId}] ` : "";
}
