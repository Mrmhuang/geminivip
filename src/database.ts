import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'keys.db'));
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS used_keys (key TEXT PRIMARY KEY, used_at TEXT NOT NULL)');
db.exec(`CREATE TABLE IF NOT EXISTS success_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  link TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS submit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  password TEXT NOT NULL,
  totp_key TEXT NOT NULL,
  card_key TEXT NOT NULL,
  offer_link TEXT,
  telegram_status TEXT NOT NULL DEFAULT 'pending',
  bindcard_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'submitted',
  message TEXT,
  created_at TEXT NOT NULL
)`);

// 微信支付订单表
db.exec(`CREATE TABLE IF NOT EXISTS payment_orders (
  out_trade_no TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  code_url TEXT NOT NULL,
  amount_fen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  transaction_id TEXT,
  created_at TEXT NOT NULL
)`);

// 兼容已有数据库：如果表已存在但缺少新字段则 ALTER TABLE 添加
try {
  db.exec(`ALTER TABLE submit_logs ADD COLUMN offer_link TEXT`);
} catch (e) { /* 字段已存在则忽略 */ }
try {
  db.exec(`ALTER TABLE submit_logs ADD COLUMN telegram_status TEXT NOT NULL DEFAULT 'pending'`);
} catch (e) { /* 字段已存在则忽略 */ }
try {
  db.exec(`ALTER TABLE submit_logs ADD COLUMN bindcard_status TEXT NOT NULL DEFAULT 'pending'`);
} catch (e) { /* 字段已存在则忽略 */ }
try {
  db.exec(`ALTER TABLE submit_logs ADD COLUMN task_id TEXT`);
} catch (e) { /* 字段已存在则忽略 */ }
try {
  db.exec(`ALTER TABLE submit_logs ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending'`);
} catch (e) { /* 字段已存在则忽略 */ }

/**
 * 尝试标记卡密为已使用
 * @returns true=成功标记, false=已被使用过
 */
export function markKeyUsed(key: string): boolean {
  try {
    db.prepare('INSERT INTO used_keys (key, used_at) VALUES (?, ?)').run(key, new Date().toISOString());
    return true;
  } catch (e: any) {
    if (e.message?.includes('UNIQUE constraint failed')) {
      return false;
    }
    throw e;
  }
}

/**
 * 检查卡密是否已被使用
 */
export function isKeyUsed(key: string): boolean {
  const row = db.prepare('SELECT 1 FROM used_keys WHERE key = ?').get(key);
  return !!row;
}

/**
 * 恢复卡密（删除已使用记录，使其可以再次使用）
 * @returns true=成功恢复, false=卡密本来就没被使用
 */
export function restoreKey(key: string): boolean {
  const result = db.prepare('DELETE FROM used_keys WHERE key = ?').run(key);
  return result.changes > 0;
}

/**
 * 记录成功认证
 */
export function logSuccess(email: string, link: string): void {
  db.prepare('INSERT INTO success_logs (email, link, created_at) VALUES (?, ?, ?)').run(email, link, new Date().toISOString());
}

/**
 * 记录用户提交日志（明文，用于排查问题）
 */
export function logSubmit(email: string, password: string, totpKey: string, cardKey: string, offerLink?: string, taskId?: string): number {
  const result = db.prepare(
    'INSERT INTO submit_logs (email, password, totp_key, card_key, offer_link, task_id, telegram_status, bindcard_status, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(email, password, totpKey, cardKey, offerLink || null, taskId || null, 'pending', 'pending', 'submitted', new Date().toISOString());
  return result.lastInsertRowid as number;
}

/**
 * 更新提交日志状态
 */
export function updateSubmitLog(id: number, status: string, message?: string): void {
  db.prepare('UPDATE submit_logs SET status = ?, message = ? WHERE id = ?').run(status, message || null, id);
}

/**
 * 更新 Telegram 认证状态和 offer_link
 */
export function updateTelegramStatus(id: number, telegramStatus: string, offerLink?: string): void {
  if (offerLink) {
    db.prepare('UPDATE submit_logs SET telegram_status = ?, offer_link = ? WHERE id = ?').run(telegramStatus, offerLink, id);
  } else {
    db.prepare('UPDATE submit_logs SET telegram_status = ? WHERE id = ?').run(telegramStatus, id);
  }
}

/**
 * 更新绑卡状态
 */
export function updateBindStatus(id: number, bindcardStatus: string, message?: string): void {
  db.prepare('UPDATE submit_logs SET bindcard_status = ?, message = ? WHERE id = ?').run(bindcardStatus, message || null, id);
}

/**
 * 更新支付状态（pending / user_claimed / confirmed / rejected / timeout）
 */
export function updatePaymentStatus(id: number, paymentStatus: string): void {
  db.prepare('UPDATE submit_logs SET payment_status = ? WHERE id = ?').run(paymentStatus, id);
}

/**
 * 获取所有提交记录（Admin 用，包含全部信息）
 */
export function getSubmitLogs(): any[] {
  return db.prepare(
    'SELECT id, email, password, totp_key, card_key, offer_link, task_id, telegram_status, bindcard_status, payment_status, status, message, created_at FROM submit_logs ORDER BY id DESC'
  ).all();
}

/**
 * 通过邮箱查找提交记录 ID
 */
export function findSubmitLogByEmail(email: string): number | null {
  const row = db.prepare('SELECT id FROM submit_logs WHERE email = ? ORDER BY id DESC LIMIT 1').get(email) as any;
  return row ? row.id : null;
}

/**
 * 通过 ID 获取完整的提交记录（Admin 手动绑卡用）
 */
export function getSubmitLogById(id: number): any | null {
  return db.prepare(
    'SELECT id, email, password, totp_key, card_key, offer_link, telegram_status, bindcard_status, status, message, created_at FROM submit_logs WHERE id = ?'
  ).get(id) || null;
}

/**
 * 获取所有成功记录
 */
export function getSuccessLogs(): { id: number; email: string; link: string; created_at: string }[] {
  return db.prepare('SELECT id, email, link, created_at FROM success_logs ORDER BY id DESC').all() as any;
}

// ============ 微信支付订单 ============

/**
 * 保存微信支付订单
 */
export function savePaymentOrder(outTradeNo: string, taskId: string, codeUrl: string, amountFen: number): void {
  db.prepare(
    'INSERT INTO payment_orders (out_trade_no, task_id, code_url, amount_fen, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(outTradeNo, taskId, codeUrl, amountFen, 'pending', new Date().toISOString());
}

/**
 * 查询支付订单
 */
export function getPaymentOrder(outTradeNo: string): { out_trade_no: string; task_id: string; code_url: string; amount_fen: number; status: string; transaction_id: string | null; created_at: string } | null {
  return db.prepare('SELECT * FROM payment_orders WHERE out_trade_no = ?').get(outTradeNo) as any || null;
}

/**
 * 通过 taskId 查询支付订单
 */
export function getPaymentOrderByTaskId(taskId: string): { out_trade_no: string; task_id: string; code_url: string; amount_fen: number; status: string; transaction_id: string | null; created_at: string } | null {
  return db.prepare('SELECT * FROM payment_orders WHERE task_id = ?').get(taskId) as any || null;
}

/**
 * 标记订单已支付
 */
export function markPaymentOrderPaid(outTradeNo: string, transactionId: string): void {
  db.prepare('UPDATE payment_orders SET status = ?, transaction_id = ? WHERE out_trade_no = ?').run('paid', transactionId, outTradeNo);
}
