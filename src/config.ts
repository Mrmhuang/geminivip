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
  // 微信收款（人工确认模式）
  payment: {
    // 收款码图片 URL（建议放 /wechat-qr.png 到 public/）
    qrUrl: process.env.PAYMENT_QR_URL || '/wechat-qr.png',
    // 展示给用户的金额（仅展示用，不参与校验）
    amount: process.env.PAYMENT_AMOUNT || '29.9',
    // 弹窗倒计时（秒）
    countdownSec: parseInt(process.env.PAYMENT_COUNTDOWN_SEC || '180', 10),
    // "我已支付"按钮亮起的最小延迟（秒）
    claimDelaySec: parseInt(process.env.PAYMENT_CLAIM_DELAY_SEC || '60', 10),
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
  // 微信人工确认模式不强制要求 CARD_SECRET（卡密功能可选保留）
  if (!config.cardSecret) {
    console.warn('[Config] CARD_SECRET 未配置，卡密生成/校验功能将不可用（微信支付模式下不影响主流程）');
  }
}
