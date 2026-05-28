import { Router, Request, Response } from 'express';
import { validateKey, generateKey } from './cardKey';
import { isKeyUsed, markKeyUsed, restoreKey, getSubmitLogs, logSubmit, getSubmitLogById, updateTelegramStatus, createOrder, getOrder, updateOrderStatus, generateOrderId, getAllOrders, OrderRecord } from './database';
import { createTask, getTaskStatus, getQueueLength, getActiveCount, isProcessorReady, isEmailActive } from './taskQueue';
import { config, updateTelegramSession, updateCardInfo } from './config';
import { reconnectTelegram, getTelegramStatus, pingTelegram } from './telegramWorker';
import { getBrowserStatus, startBindCard } from './browserWorker';
import { Task } from './taskQueue';
import { createNativeOrder, queryWechatOrderStatus, decryptAES256GCM, verifyWechatPayNotifySignature } from './payment/wechat';
import { createPrecreateOrder, verifyNotifySign, queryTradeStatus } from './payment/alipay';
import { markOrderPaid, getPaidOrderInfo, updateCachedOrderTask } from './payment/orderCache';
import { generateUniqueAmount, checkPaymentReceived } from './payment/usdt';

export const router = Router();

/**
 * POST /api/submit - 提交认证请求
 */
router.post('/api/submit', (req: Request, res: Response) => {
  const { email, password, totpKey, cardKey } = req.body;

  // 输入校验
  if (!email || !password || !totpKey || !cardKey) {
    res.status(400).json({ error: '所有字段都必须填写' });
    return;
  }

  // 邮箱格式
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: '邮箱格式不正确' });
    return;
  }

  // 密码长度
  if (password.length < 8) {
    res.status(400).json({ error: '密码至少需要8个字符' });
    return;
  }

  // TOTP key 格式: 32字符（可含空格分隔）
  const cleanTotp = totpKey.replace(/\s/g, '');
  if (cleanTotp.length !== 32) {
    res.status(400).json({ error: 'TOTP Secret Key 必须是32个字符' });
    return;
  }

  // 验证卡密合法性（HMAC签名）
  if (!validateKey(cardKey, config.cardSecret)) {
    res.status(400).json({ error: '卡密无效' });
    return;
  }

  // 检查该邮箱是否有正在执行中的任务（防重复提交）
  if (isEmailActive(email)) {
    res.status(400).json({ error: '该邮箱已有任务正在执行中，请勿重复提交' });
    return;
  }

  // 检查认证服务是否就绪（放在消耗卡密之前，避免浪费卡密）
  if (!isProcessorReady()) {
    res.status(503).json({ error: '认证服务暂不可用，请稍后再试' });
    return;
  }

  // 检查卡密是否已使用（不立即消耗，认证成功后才标记）
  if (isKeyUsed(cardKey)) {
    res.status(400).json({ error: '该卡密已被使用' });
    return;
  }

  // 创建任务加入队列（携带 cardKey，成功后再消耗）
  const task = createTask(email, password, totpKey, cardKey);

  // 记录提交日志（明文）
  const logId = logSubmit(email, password, totpKey, cardKey, undefined, task.id);
  (task as any).logId = logId;

  res.json({ taskId: task.id, message: '已提交，正在排队中' });
});

/**
 * GET /api/status/:taskId - 查询任务状态
 */
router.get('/api/status/:taskId', (req: Request<{ taskId: string }>, res: Response) => {
  const result = getTaskStatus(req.params.taskId);
  if (!result) {
    res.status(404).json({ error: '任务不存在或已过期' });
    return;
  }
  res.json(result);
});

/**
 * GET /api/queue - 获取当前排队数（含正在处理的）
 */
router.get('/api/queue', (req: Request, res: Response) => {
  res.json({ length: getActiveCount() });
});

/**
 * GET /api/health - 健康检查
 */
router.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    auth: isProcessorReady() ? 'connected' : 'disconnected',
    browser: getBrowserStatus().connected ? 'connected' : 'disconnected',
    queue: getQueueLength(),
  });
});

/**
 * GET /admin - 管理后台页面
 */
router.get('/admin', (req: Request, res: Response) => {
  res.sendFile('admin.html', { root: 'public' });
});

/**
 * POST /api/admin/revoke-key - 作废卡密（退货用）
 */
router.post('/api/admin/revoke-key', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }
  const { cardKey } = req.body;
  if (!cardKey) {
    res.status(400).json({ error: '请提供 cardKey' });
    return;
  }
  // markKeyUsed 会标记为已使用，之后该卡密无法再用
  const result = markKeyUsed(cardKey);
  if (result) {
    res.json({ success: true, message: `卡密 ${cardKey} 已作废` });
  } else {
    res.json({ success: true, message: `卡密 ${cardKey} 已经是失效状态` });
  }
});

/**
 * POST /api/admin/restore-key - 恢复卡密（误消耗时用）
 */
router.post('/api/admin/restore-key', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }
  const { cardKey } = req.body;
  if (!cardKey) {
    res.status(400).json({ error: '请提供 cardKey' });
    return;
  }
  const result = restoreKey(cardKey);
  if (result) {
    res.json({ success: true, message: `卡密 ${cardKey} 已恢复，可再次使用` });
  } else {
    res.json({ success: false, message: `卡密 ${cardKey} 本来就未被使用` });
  }
});

/**
 * GET /api/admin/logs - 获取所有提交记录（需要密码，包含全部信息）
 */
router.get('/api/admin/logs', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }
  res.json(getSubmitLogs());
});

/**
 * POST /api/admin/update-session - 热更新 Telegram Session（不需要重启容器）
 *
 * 使用方式：
 * curl -X POST http://43.162.118.171:3000/api/admin/update-session \
 *   -H "Content-Type: application/json" \
 *   -H "X-Admin-Password: your_password" \
 *   -d '{"session": "新的session字符串"}'
 */
router.post('/api/admin/update-session', async (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  const { session } = req.body;
  if (!session || typeof session !== 'string' || session.trim().length < 10) {
    res.status(400).json({ error: '请提供有效的 session 字符串' });
    return;
  }

  // 更新内存中的 session
  updateTelegramSession(session.trim());

  // 断开旧连接，用新 session 重连
  const result = await reconnectTelegram();

  console.log(`[Admin] Session updated. Result: ${result}`);
  res.json({
    success: result.includes('successfully'),
    message: result,
    telegram: getTelegramStatus(),
  });
});

/**
 * POST /api/admin/reconnect - 用当前 session 重新连接 Telegram
 */
router.post('/api/admin/reconnect', async (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  const result = await reconnectTelegram();
  res.json({
    success: result.includes('successfully'),
    message: result,
    telegram: getTelegramStatus(),
  });
});

/**
 * GET /api/admin/telegram-status - 查看 Telegram 连接状态
 */
router.get('/api/admin/telegram-status', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  res.json({
    ...getTelegramStatus(),
    processorReady: isProcessorReady(),
    queue: getQueueLength(),
  });
});

/**
 * POST /api/admin/telegram-ping - Telegram 拨测（验证 session 有效性和 bot 可达性）
 */
router.post('/api/admin/telegram-ping', async (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  try {
    const result = await pingTelegram();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/**
 * POST /api/admin/trigger-bindcard - 手动触发绑卡（认证成功但绑卡失败时使用）
 */
router.post('/api/admin/trigger-bindcard', async (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  const { logId } = req.body;
  if (!logId) {
    res.status(400).json({ error: '请提供 logId' });
    return;
  }

  const log = getSubmitLogById(logId);
  if (!log) {
    res.status(404).json({ error: '记录不存在' });
    return;
  }

  if (log.telegram_status !== 'success') {
    res.status(400).json({ error: 'Telegram 认证未成功，无法绑卡' });
    return;
  }

  if (!log.offer_link) {
    res.status(400).json({ error: '没有 offer 链接，无法绑卡' });
    return;
  }

  // 创建一个临时 Task 用于绑卡
  const task: Task = {
    id: `manual-${logId}-${Date.now().toString(36)}`,
    email: log.email,
    password: log.password,
    totpKey: log.totp_key,
    cardKey: log.card_key,
    offerLink: log.offer_link,
    status: 'auth_success',
    message: '管理员手动触发绑卡...',
    createdAt: Date.now(),
  };

  // 异步触发绑卡
  startBindCard(task).catch(err => {
    console.error(`[Admin] 手动绑卡失败 logId=${logId}: ${err.message}`);
  });

  res.json({ success: true, message: '绑卡已触发，请稍后刷新查看结果' });
});

/**
 * POST /api/admin/manual-bindcard - 手动绑卡（输入用户信息 + offer link，无需现有记录）
 *
 * 用途：Bot 认证成功返回了 link offer，但系统未正确识别为成功时，
 *       管理员手动输入用户信息和 offer link 执行绑卡。
 *
 * Body: { email, password, totpKey, offerLink, cardKey? }
 */
router.post('/api/admin/manual-bindcard', async (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  const { email, password: userPassword, totpKey, offerLink, cardKey } = req.body;

  if (!email || !userPassword || !totpKey || !offerLink) {
    res.status(400).json({ error: '必填字段：email, password, totpKey, offerLink' });
    return;
  }

  // TOTP key 格式验证: 必须是32个 Base32 字符（A-Z, 2-7），允许中间有空格
  const cleanTotp = totpKey.replace(/\s/g, '');
  if (cleanTotp.length !== 32) {
    res.status(400).json({ error: `TOTP Key 必须是32个字符（去除空格后），当前: ${cleanTotp.length} 个字符` });
    return;
  }
  if (!/^[A-Z2-7]+$/i.test(cleanTotp)) {
    const invalidChar = cleanTotp.split('').find((c: string) => !/[A-Z2-7]/i.test(c));
    res.status(400).json({ error: `TOTP Key 包含非法字符: "${invalidChar}"，只允许 A-Z 和 2-7` });
    return;
  }

  // 验证 offer link 格式
  if (!offerLink.includes('one.google.com/offer/')) {
    res.status(400).json({ error: 'offer link 格式不正确，应包含 one.google.com/offer/' });
    return;
  }

  // 记录到数据库（如果是全新的手动操作，创建日志）
  const logId = logSubmit(email, userPassword, totpKey, cardKey || 'admin-manual', offerLink);
  updateTelegramStatus(logId, 'success', offerLink);

  // 创建临时 Task
  const task: Task = {
    id: `admin-manual-${Date.now().toString(36)}`,
    email,
    password: userPassword,
    totpKey,
    cardKey: cardKey || 'admin-manual',
    offerLink,
    status: 'auth_success',
    message: '管理员手动绑卡（直接提供 offer link）...',
    createdAt: Date.now(),
  };

  // 异步触发绑卡
  startBindCard(task).catch(err => {
    console.error(`[Admin] 手动绑卡(manual-bindcard)失败 email=${email}: ${err.message}`);
  });

  res.json({ success: true, message: '绑卡已触发，请稍后刷新查看结果', logId });
});

/**
 * POST /api/admin/generate-keys - 生成卡密
 */
router.post('/api/admin/generate-keys', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  const count = Math.min(parseInt(req.body.count || '5', 10), 100);
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    keys.push(generateKey(config.cardSecret));
  }

  res.json({ keys });
});

/**
 * GET /api/admin/card-info - 查看当前信用卡信息（脱敏）
 */
router.get('/api/admin/card-info', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  const c = config.card;
  res.json({
    number: c.number ? `****${c.number.slice(-4)}` : '',
    expiry: c.expiry,
    cvv: c.cvv ? '***' : '',
    name: c.name,
    zip: c.zip,
  });
});

/**
 * POST /api/admin/update-card - 热更新信用卡信息（不需重启）
 */
router.post('/api/admin/update-card', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  const { number, expiry, cvv, name, zip } = req.body;
  if (!number && !expiry && !cvv && !name && !zip) {
    res.status(400).json({ error: '至少提供一个字段' });
    return;
  }

  updateCardInfo({ number, expiry, cvv, name, zip });
  console.log(`[Admin] 信用卡信息已更新: number=****${(number || config.card.number).slice(-4)}, expiry=${expiry || config.card.expiry}, name=${name || config.card.name}`);

  res.json({ success: true, message: '信用卡信息已更新（运行时生效，重启后需重新设置或更新 .env.production）' });
});

// ============================================
// 支付相关路由
// ============================================

/**
 * POST /api/create-order - 创建支付订单（替代卡密验证）
 *
 * 流程: 验证表单 → 创建订单 → 调用支付渠道 → 返回二维码
 */
router.post('/api/create-order', async (req: Request, res: Response) => {
  const { email, password, totpKey, channel } = req.body;

  // 输入校验
  if (!email || !password || !totpKey || !channel) {
    res.status(400).json({ error: '所有字段都必须填写' });
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: '邮箱格式不正确' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: '密码至少需要8个字符' });
    return;
  }

  const cleanTotp = totpKey.replace(/\s/g, '');
  if (cleanTotp.length !== 32) {
    res.status(400).json({ error: 'TOTP Secret Key 必须是32个字符' });
    return;
  }

  if (channel !== 'wechat' && channel !== 'alipay' && channel !== 'usdt_bsc' && channel !== 'usdt_eth') {
    res.status(400).json({ error: '不支持的支付渠道' });
    return;
  }

  // 检查邮箱是否有正在执行中的任务
  if (isEmailActive(email)) {
    res.status(400).json({ error: '该邮箱已有任务正在执行中，请勿重复提交' });
    return;
  }

  // 检查认证服务是否就绪
  if (!isProcessorReady()) {
    res.status(503).json({ error: '认证服务暂不可用，请稍后再试' });
    return;
  }

  const baseUrl = config.payment.baseUrl;
  const isUsdtChannel = channel === 'usdt_bsc' || channel === 'usdt_eth';
  if (!isUsdtChannel && (!baseUrl || !baseUrl.startsWith('http'))) {
    res.status(500).json({ error: '服务配置错误：未设置 BASE_URL' });
    return;
  }

  const orderId = generateOrderId();
  const isUsdt = channel === 'usdt_bsc' || channel === 'usdt_eth';
  const price = isUsdt ? config.usdt.priceUsdt : config.payment.price;
  const amount = isUsdt ? Math.round(price * 10000) : Math.round(price * 100); // USDT用万分位，CNY用分
  const expiryMs = config.payment.orderExpiryMinutes * 60 * 1000;
  const expiresAt = new Date(Date.now() + expiryMs).toISOString();

  try {
    let qrCodeUrl: string;
    let usdtAmount: number | undefined;

    if (channel === 'wechat') {
      const timeExpire = new Date(Date.now() + expiryMs + 8 * 60 * 60 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, '+08:00');

      qrCodeUrl = await createNativeOrder({
        outTradeNo: orderId,
        description: 'Gemini VIP 认证服务',
        totalFen: amount,
        notifyUrl: `${baseUrl}/api/webhook/wechat`,
        timeExpire,
      });
    } else if (channel === 'alipay') {
      qrCodeUrl = await createPrecreateOrder({
        outTradeNo: orderId,
        subject: 'Gemini VIP 认证服务',
        totalAmount: price.toFixed(2),
        notifyUrl: `${baseUrl}/api/webhook/alipay`,
        timeoutExpress: `${config.payment.orderExpiryMinutes}m`,
      });
    } else {
      // USDT: 生成唯一金额，用钱包地址作为二维码内容
      usdtAmount = generateUniqueAmount(config.usdt.priceUsdt);
      const network = channel === 'usdt_bsc' ? 'BSC (BEP-20)' : 'Ethereum (ERC-20)';
      qrCodeUrl = config.usdt.walletAddress; // 前端用地址生成二维码
    }

    // 写入数据库
    createOrder({
      orderId,
      email,
      password,
      totpKey: cleanTotp,
      amount: isUsdt ? Math.round((usdtAmount || price) * 10000) : amount,
      channel,
      expiresAt,
    });

    console.log(`[Payment] 订单创建成功: ${orderId}, channel=${channel}, amount=${isUsdt ? usdtAmount + ' USDT' : amount + '分'}`);
    res.json({
      orderId,
      qrCodeUrl,
      amount: isUsdt ? undefined : amount,
      expiresAt,
      // USDT 额外字段
      ...(isUsdt && {
        usdtAmount,
        walletAddress: config.usdt.walletAddress,
        network: channel === 'usdt_bsc' ? 'BSC (BEP-20)' : 'Ethereum (ERC-20)',
      }),
    });
  } catch (err: any) {
    console.error('[Payment] 创建订单失败:', err);
    res.status(502).json({ error: '支付渠道暂时不可用，请稍后重试' });
  }
});

/**
 * GET /api/order/:orderId - 轮询订单状态
 */
router.get('/api/order/:orderId', async (req: Request<{ orderId: string }>, res: Response) => {
  const { orderId } = req.params;

  const order = getOrder(orderId);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  // 已是终态，直接返回
  if (order.status === 'paid' || order.status === 'expired' || order.status === 'refunded') {
    res.json({
      status: order.status,
      taskId: order.task_id,
      taskStatus: order.task_status,
    });
    return;
  }

  // 检查是否过期
  if (new Date(order.expires_at) < new Date()) {
    updateOrderStatus(orderId, 'expired');
    res.json({ status: 'expired' });
    return;
  }

  // 检查内存缓存
  const cachedInfo = getPaidOrderInfo(orderId);
  if (cachedInfo) {
    res.json({
      status: 'paid',
      taskId: cachedInfo.taskId,
    });
    return;
  }

  // 主动查询支付渠道
  try {
    if (order.channel === 'wechat') {
      const result = await queryWechatOrderStatus(orderId);
      if (result && result.tradeState === 'SUCCESS') {
        if (result.totalAmount === order.amount) {
          await confirmAndStartTask(order, result.transactionId);
          const updatedOrder = getOrder(orderId);
          res.json({
            status: 'paid',
            taskId: updatedOrder?.task_id,
          });
          return;
        }
      }
      if (result && (result.tradeState === 'CLOSED' || result.tradeState === 'PAYERROR')) {
        updateOrderStatus(orderId, 'expired');
        res.json({ status: 'expired' });
        return;
      }
    } else if (order.channel === 'alipay') {
      const result = await queryTradeStatus(orderId);
      if (result && (result.tradeStatus === 'TRADE_SUCCESS' || result.tradeStatus === 'TRADE_FINISHED')) {
        const paidFen = Math.round(parseFloat(result.totalAmount) * 100);
        if (paidFen === order.amount) {
          await confirmAndStartTask(order, result.tradeNo);
          const updatedOrder = getOrder(orderId);
          res.json({
            status: 'paid',
            taskId: updatedOrder?.task_id,
          });
          return;
        }
      }
      if (result && result.tradeStatus === 'TRADE_CLOSED') {
        updateOrderStatus(orderId, 'expired');
        res.json({ status: 'expired' });
        return;
      }
    } else if (order.channel === 'usdt_bsc' || order.channel === 'usdt_eth') {
      // USDT: 查询链上转账
      const expectedUsdt = order.amount / 10000; // 万分位还原
      const orderCreatedAt = Math.floor(new Date(order.created_at).getTime() / 1000) - 60; // 提前1分钟容差
      const network = order.channel === 'usdt_bsc' ? 'bsc' : 'eth';
      const tx = await checkPaymentReceived(expectedUsdt, orderCreatedAt, network as 'bsc' | 'eth');
      if (tx) {
        await confirmAndStartTask(order, tx.hash);
        const updatedOrder = getOrder(orderId);
        res.json({ status: 'paid', taskId: updatedOrder?.task_id });
        return;
      }
    }
  } catch (err) {
    console.error('[Payment] 查询订单状态失败:', err);
  }

  // 仍是 pending
  res.json({ status: 'pending' });
});

/**
 * POST /api/webhook/wechat - 微信支付回调
 */
router.post('/api/webhook/wechat', async (req: Request, res: Response) => {
  try {
    const body = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
    const timestamp = req.headers['wechatpay-timestamp'] as string || '';
    const nonce = req.headers['wechatpay-nonce'] as string || '';
    const signature = req.headers['wechatpay-signature'] as string || '';

    // 验签
    const isValid = verifyWechatPayNotifySignature({ timestamp, nonce, body, signature });
    if (!isValid) {
      console.warn('[Webhook/Wechat] 签名验证失败');
      res.status(401).json({ code: 'FAIL', message: '签名验证失败' });
      return;
    }

    // 解密
    const notification = JSON.parse(body);
    const { ciphertext, nonce: encNonce, associated_data } = notification.resource;
    const decrypted = decryptAES256GCM(config.wechatPay.apiV3Key, encNonce, ciphertext, associated_data);
    const payResult = JSON.parse(decrypted);

    const { out_trade_no, trade_state, transaction_id, amount } = payResult;
    console.log(`[Webhook/Wechat] 收到通知: orderId=${out_trade_no}, state=${trade_state}`);

    if (trade_state === 'SUCCESS') {
      const order = getOrder(out_trade_no);
      if (!order) {
        res.json({ code: 'SUCCESS', message: '成功' });
        return;
      }

      // 幂等
      if (order.status === 'paid' || order.status === 'refunded') {
        res.json({ code: 'SUCCESS', message: '成功' });
        return;
      }

      // 金额校验
      const paidFen = amount?.total;
      if (typeof paidFen !== 'number' || paidFen !== order.amount) {
        console.error(`[Webhook/Wechat] 金额不匹配: expected=${order.amount}, got=${paidFen}`);
        res.json({ code: 'SUCCESS', message: '成功' });
        return;
      }

      await confirmAndStartTask(order, transaction_id);
    }

    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('[Webhook/Wechat] 处理失败:', err);
    res.status(500).json({ code: 'FAIL', message: '处理失败' });
  }
});

/**
 * POST /api/webhook/alipay - 支付宝回调
 */
router.post('/api/webhook/alipay', async (req: Request, res: Response) => {
  try {
    const params: Record<string, string> = {};
    if (typeof req.body === 'object') {
      for (const [key, value] of Object.entries(req.body)) {
        params[key] = String(value);
      }
    }

    const { out_trade_no, trade_no, trade_status, total_amount, app_id } = params;
    console.log(`[Webhook/Alipay] 收到通知: orderId=${out_trade_no}, status=${trade_status}`);

    // 验签
    const isValid = verifyNotifySign(params);
    if (!isValid) {
      console.warn('[Webhook/Alipay] 验签失败');
      res.status(401).send('fail');
      return;
    }

    // app_id 校验
    if (config.alipay.appId && app_id !== config.alipay.appId) {
      console.warn(`[Webhook/Alipay] appId不匹配: expected=${config.alipay.appId}, got=${app_id}`);
      res.status(400).send('fail');
      return;
    }

    if (trade_status === 'TRADE_SUCCESS' || trade_status === 'TRADE_FINISHED') {
      const order = getOrder(out_trade_no);
      if (!order) {
        res.send('success');
        return;
      }

      // 幂等
      if (order.status === 'paid' || order.status === 'refunded') {
        res.send('success');
        return;
      }

      // 金额校验
      const expectedYuan = (order.amount / 100).toFixed(2);
      const receivedYuan = parseFloat(total_amount || '0').toFixed(2);
      if (expectedYuan !== receivedYuan) {
        console.error(`[Webhook/Alipay] 金额不匹配: expected=${expectedYuan}, got=${receivedYuan}`);
        res.send('success');
        return;
      }

      await confirmAndStartTask(order, trade_no);
    }

    res.send('success');
  } catch (err) {
    console.error('[Webhook/Alipay] 处理失败:', err);
    res.status(500).send('fail');
  }
});

/**
 * 确认支付并启动任务
 */
async function confirmAndStartTask(order: OrderRecord, tradeNo: string): Promise<void> {
  const paidAt = new Date().toISOString();

  // 更新订单状态
  updateOrderStatus(order.order_id, 'paid', { paymentTradeNo: tradeNo, paidAt });

  // 创建任务
  const task = createTask(order.email, order.password, order.totp_key, undefined, order.order_id);

  // 更新订单关联任务
  updateOrderStatus(order.order_id, 'paid', { taskId: task.id, taskStatus: 'queued' });

  // 写入缓存
  markOrderPaid(order.order_id, {
    tradeNo,
    totalAmount: String(order.amount),
    paidAt,
    taskId: task.id,
  });

  // 记录提交日志（兼容旧系统）
  logSubmit(order.email, order.password, order.totp_key, `order:${order.order_id}`, undefined, task.id);

  console.log(`[Payment] 支付确认，任务已创建: orderId=${order.order_id}, taskId=${task.id}`);
}

// ============================================
// Admin 订单管理
// ============================================

/**
 * GET /api/admin/orders - 获取所有订单
 */
router.get('/api/admin/orders', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  const orders = getAllOrders();
  res.json(orders);
});

/**
 * POST /api/admin/refund-order - 标记订单为已退款
 */
router.post('/api/admin/refund-order', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  const { orderId } = req.body;
  if (!orderId) {
    res.status(400).json({ error: '请提供 orderId' });
    return;
  }

  const order = getOrder(orderId);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  updateOrderStatus(orderId, 'refunded');
  res.json({ success: true, message: `订单 ${orderId} 已标记为退款` });
});

/**
 * POST /api/admin/retry-order - 重新执行已付款但任务失败的订单
 */
router.post('/api/admin/retry-order', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }

  const { orderId } = req.body;
  if (!orderId) {
    res.status(400).json({ error: '请提供 orderId' });
    return;
  }

  const order = getOrder(orderId);
  if (!order) {
    res.status(404).json({ error: '订单不存在' });
    return;
  }

  if (order.status !== 'paid') {
    res.status(400).json({ error: '只有已付款的订单才能重试' });
    return;
  }

  // 检查处理器
  if (!isProcessorReady()) {
    res.status(503).json({ error: '认证服务暂不可用' });
    return;
  }

  // 创建新任务
  const task = createTask(order.email, order.password, order.totp_key, undefined, order.order_id);
  updateOrderStatus(orderId, 'paid', { taskId: task.id, taskStatus: 'queued' });

  res.json({ success: true, taskId: task.id, message: '任务已重新加入队列' });
});
