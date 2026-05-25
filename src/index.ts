import express from 'express';
import path from 'path';
import { config, validateConfig } from './config';
import { router } from './routes';
import { initTelegram } from './telegramWorker';
import { initBrowser } from './browserWorker';

async function main() {
  validateConfig();

  const app = express();

  // 中间件
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // 静态文件
  app.use(express.static(path.join(process.cwd(), 'public')));

  // API 路由
  app.use(router);

  // 先启动 HTTP 服务
  app.listen(config.port, () => {
    console.log(`[Server] Running at http://localhost:${config.port}`);
  });

  // 初始化 Telegram（内部已有重试机制，不会抛出异常）
  await initTelegram();

  // 初始化浏览器（用于绑卡流程）
  await initBrowser();
}

main().catch(err => {
  console.error('[Fatal]', err.message);
  process.exit(1);
});
