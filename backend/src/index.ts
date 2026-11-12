import { createWorker } from './worker';
import type { Env } from './env';

export type { Env } from './env';

// Only Worker handlers belong in this module. Test helpers and constants live in worker.ts.
const worker = createWorker();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => worker.fetch(request, env, ctx),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) =>
    worker.scheduled(controller, env, ctx),
} satisfies ExportedHandler<Env>;
