// Node-pool test stub for the workerd-only `cloudflare:workers` module.
//
// The DO lives in src/conversation.ts and is re-exported from src/index.ts so
// wrangler can bind it. The node-pool router tests import src/index.ts, which
// transitively pulls in `cloudflare:workers` — a module that only exists inside
// workerd. The DO's real behavior is exercised in the workers pool
// (conversation.workers.test.ts); here we only need the import graph to resolve.
//
// `DurableObject` is used solely as a base class at module-load time, so a
// minimal class that stashes ctx/env is enough for the node tests to load.
export class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
