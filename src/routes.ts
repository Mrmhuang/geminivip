import { Router, Request, Response } from 'express';
import { validateKey, generateKey } from './cardKey';
import { isKeyUsed, markKeyUsed, restoreKey, getSubmitLogs, logSubmit, getSubmitLogById } from './database';
import { createTask, getTaskStatus, getQueueLength, getActiveCount, isProcessorReady, isEmailActive } from './taskQueue';
import { config, updateTelegramSession, updateCardInfo } from './config';
import { reconnectTelegram, getTelegramStatus } from './telegramWorker';
import { getBrowserStatus, startBindCard } from './browserWorker';
import { Task } from './taskQueue';

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
  const logId = logSubmit(email, password, totpKey, cardKey);
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
