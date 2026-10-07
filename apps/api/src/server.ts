import { buildApp } from './app.js';

const app = await buildApp();
const { PORT, HOST } = app.ctx.config;
await app.listen({ port: PORT, host: HOST });
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}
