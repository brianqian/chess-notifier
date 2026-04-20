import { Hono } from 'hono';
import { processNewGames } from './processor';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('chess-notifier ok'));

app.get('/run', async (c) => {
  const key = c.req.query('key');
  if (!c.env.TRIGGER_SECRET || key !== c.env.TRIGGER_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const summary = await processNewGames(c.env);
  return c.json(summary);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      processNewGames(env).then(
        (summary) => console.log('cron summary', summary),
        (err) => console.error('cron error', err)
      )
    );
  },
} satisfies ExportedHandler<Env>;
