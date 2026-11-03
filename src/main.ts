import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import { AppModule } from './app.module';
import { adminOrigins, config } from './config';
import { printTarget } from './print/print.service';

/** Shared by main() and the tests so both run the same middleware. */
export function configure(app: INestApplication) {
  const express = app as NestExpressApplication;
  express.set('trust proxy', 1);
  // Sync pages are JSON and compress well; Render bills egress.
  express.use(compression());
  // Gzipped request bodies from the terminal are inflated by the body parser. 12 MB: the
  // udhaar bhav sheet sends up to six page photos (~250 KB each as base64) in one request.
  express.useBodyParser('json', { limit: '12mb' });
  // Only the admin portal calls from a browser; the terminals don't need CORS at all.
  app.enableCors({ origin: adminOrigins(), methods: ['GET', 'POST'], allowedHeaders: ['Authorization', 'Content-Type', 'X-Print-Device'], maxAge: 86400 });
  // The website's picked print machine rides along with every request (see printTarget).
  express.use((req: { headers: Record<string, string | string[] | undefined> }, _res: unknown, next: () => void) => {
    const h = req.headers['x-print-device'];
    printTarget.run(typeof h === 'string' ? h : undefined, next);
  });
  app.enableShutdownHooks();
}

async function main() {
  const { PORT } = config();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configure(app);
  await app.listen(PORT, '0.0.0.0');
}

if (require.main === module) void main();
