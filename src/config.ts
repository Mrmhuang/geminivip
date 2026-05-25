import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  cardSecret: process.env.CARD_SECRET || '',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  telegram: {
    apiId: parseInt(process.env.TELEGRAM_API_ID || '0', 10),
    apiHash: process.env.TELEGRAM_API_HASH || '',
    session: process.env.TELEGRAM_SESSION || '',
  },
  // 浏览器相关配置
  browser: {
    headless: process.env.BROWSER_HEADLESS !== 'false', // 默认 headless
    offerUrl: process.env.GOOGLE_OFFER_URL || 'https://one.google.com/offer/1R0ZLV3EJAKRN9XN2K2V',
  },
  // 绑卡信用卡信息
  card: {
    number: process.env.CARD_NUMBER || '',
    expiry: process.env.CARD_EXPIRY || '',   // MM/YY 格式，如 01/30
    cvv: process.env.CARD_CVV || '',
    name: process.env.CARD_NAME || '',
    zip: process.env.CARD_ZIP || '',
  },
};

/**
 * 运行时更新 Telegram session（热更新，不需要重启）
 */
export function updateTelegramSession(newSession: string): void {
  config.telegram.session = newSession;
}

/**
 * 运行时更新信用卡信息（热更新，不需要重启）
 */
export function updateCardInfo(card: { number?: string; expiry?: string; cvv?: string; name?: string; zip?: string }): void {
  if (card.number) config.card.number = card.number;
  if (card.expiry) config.card.expiry = card.expiry;
  if (card.cvv) config.card.cvv = card.cvv;
  if (card.name) config.card.name = card.name;
  if (card.zip) config.card.zip = card.zip;
}

// 启动时校验必需配置
export function validateConfig(): void {
  if (!config.cardSecret) throw new Error('CARD_SECRET is required in .env');
}
