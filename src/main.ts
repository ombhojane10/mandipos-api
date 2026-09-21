import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import { AppModule } from './app.module';
import { config } from './config';

/** Shared by main() and the tests so both run the same middleware. */
export function configure(app: INestApplication) {
  const express = app as NestExpressApplication;
  express.set('trust proxy', 1);
  // Sync pages are JSON and compress well; Render bills egress.
  express.use(compression());
  // Gzipped request bodies from the terminal are inflated by the body parser.
  express.useBodyParser('json', { limit: '1mb' });
  app.enableShutdownHooks();
}

async function main() {
  const { PORT } = config();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configure(app);
  await app.listen(PORT, '0.0.0.0');
}

if (require.main === module) void main();
