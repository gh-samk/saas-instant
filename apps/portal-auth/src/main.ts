import 'reflect-metadata';
import { createApp } from './app-factory';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp();
  await app.init();
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
