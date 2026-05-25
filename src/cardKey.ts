import crypto from 'crypto';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * 生成一个卡密
 * 格式: {8位随机payload}-{8位HMAC签名}
 */
export function generateKey(secret: string): string {
  const payload = Array.from({ length: 8 }, () =>
    CHARSET[crypto.randomInt(CHARSET.length)]
  ).join('');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 8);
  return `${payload}-${sig}`;
}

/**
 * 验证卡密是否合法（不检查是否已使用）
 */
export function validateKey(key: string, secret: string): boolean {
  const parts = key.split('-');
  if (parts.length !== 2 || parts[0].length !== 8 || parts[1].length !== 8) {
    return false;
  }
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 8);
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}
