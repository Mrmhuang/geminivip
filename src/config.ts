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
    headless: process.env.BROWSER_HEADLESS !== 'false',
    offerUrl: process.env.GOOGLE_OFFER_URL || 'https://one.google.com/offer/1R0ZLV3EJAKRN9XN2K2V',
  },
  // 绑卡信用卡信息
  card: {
    number: process.env.CARD_NUMBER || '',
    expiry: process.env.CARD_EXPIRY || '',
    cvv: process.env.CARD_CVV || '',
    name: process.env.CARD_NAME || '',
    zip: process.env.CARD_ZIP || '',
  },
  // 支付配置
  payment: {
    price: parseFloat(process.env.PAYMENT_PRICE || '29.9'),
    orderExpiryMinutes: parseInt(process.env.ORDER_EXPIRY_MINUTES || '15', 10),
    baseUrl: process.env.BASE_URL || '',
  },
  // 微信支付 V3
  wechatPay: {
    mchId: process.env.WECHAT_PAY_MCH_ID || '',
    apiV3Key: process.env.WECHAT_PAY_API_V3_KEY || '',
    privateKey: (process.env.WECHAT_PAY_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    serialNo: process.env.WECHAT_PAY_SERIAL_NO || '',
    appId: process.env.WECHAT_PAY_APPID || '',
    platformCert: process.env.WECHAT_PAY_PLATFORM_CERT || '',
  },
  // 支付宝
  alipay: {
    appId: process.env.ALIPAY_APP_ID || '',
    privateKey: process.env.ALIPAY_APP_PRIVATE_KEY || '',
    publicKey: process.env.ALIPAY_PUBLIC_KEY || '',
    keyType: process.env.ALIPAY_KEY_TYPE || 'PKCS8',
  },
  // USDT
  usdt: {
    walletAddress: process.env.USDT_WALLET_ADDRESS || '0x92DdD36340ffA8943378E8DDAd60D806cEc9487A',
    bscScanApiKey: process.env.BSCSCAN_API_KEY || '',
    ethScanApiKey: process.env.ETHERSCAN_API_KEY || '',
    priceUsdt: parseFloat(process.env.PAYMENT_PRICE_USDT || '4.2'),
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
  // cardSecret 不再强制要求（支付模式下不需要）
  const hasPayment = config.wechatPay.mchId || config.alipay.appId;
  const hasCardKey = config.cardSecret;
  if (!hasPayment && !hasCardKey) {
    throw new Error('至少需要配置支付渠道 (WECHAT_PAY_MCH_ID/ALIPAY_APP_ID) 或 CARD_SECRET');
  }
}
