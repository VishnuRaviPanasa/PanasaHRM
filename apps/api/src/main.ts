import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.enableCors({ origin: ['http://localhost:3100', 'http://localhost:3000'], credentials: true });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`PanasaHRM API listening on http://localhost:${port}/api`);
}
void bootstrap();
