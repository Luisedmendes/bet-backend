import { createApp } from './app.js';
import { loadEnv } from './infrastructure/config/env.js';

const env = loadEnv();
const app = await createApp({ env });
await app.listen(env.port);
