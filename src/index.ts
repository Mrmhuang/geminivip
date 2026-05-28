import express from 'express';
import path from 'path';
import { config, validateConfig } from './config';
import { router } from './routes';
import { initTelegram } from './telegramWorker';
import { initBrowser } from './browserWorker';
import { expireStaleOrders } from './database';

async function main() {
  validateConfig();

  const app = express();

  // 微信支付 webhook 需要原始 body（用于验签）
  app.use('/api/webhook/wechat', express.raw({ type: '*/*' }));

  // 其他路由的中间件
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

  // 定期清理过期订单（每分钟）
  setInterval(() => {
    const expired = expireStaleOrders();
    if (expired > 0) {
      console.log(`[Orders] 清理了 ${expired} 个过期订单`);
    }
  }, 60 * 1000);

  // 初始化 Telegram（内部已有重试机制，不会抛出异常）
  await initTelegram();

  // 初始化浏览器（用于绑卡流程）
  await initBrowser();
}

main().catch(err => {
  console.error('[Fatal]', err.message);
  process.exit(1);
});
