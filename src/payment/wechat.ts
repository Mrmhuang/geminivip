/**
 * 微信支付 V3 工具模块
 *
 * 使用微信支付 APIv3 接口，原生 Node.js crypto 实现。
 * 支持 Native 支付（PC扫码）。
 *
 * 环境变量通过 config.ts 统一管理。
 */

import crypto from 'crypto';
import { config } from '../config';

// ============================================
// 配置读取
// ============================================

function getWechatConfig() {
  const { wechatPay } = config;
  if (!wechatPay.mchId || !wechatPay.apiV3Key || !wechatPay.privateKey || !wechatPay.serialNo || !wechatPay.appId) {
    throw new Error('[WechatPay] 缺少必要配置: wechatPay.mchId/apiV3Key/privateKey/serialNo/appId');
  }
  return wechatPay;
}

// ============================================
// APIv3 签名
// ============================================

function generateSignature(
  method: string,
  url: string,
  timestamp: string,
  nonceStr: string,
  body: string
): string {
  const cfg = getWechatConfig();
  const message = `${method}\n${url}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  return sign.sign(cfg.privateKey, 'base64');
}

function getAuthorizationHeader(method: string, url: string, body: string = ''): string {
  const cfg = getWechatConfig();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const signature = generateSignature(method, url, timestamp, nonceStr, body);

  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.serialNo}"`;
}

// ============================================
// AES-256-GCM 解密（回调通知解密）
// ============================================

export function decryptAES256GCM(
  apiV3Key: string,
  nonce: string,
  ciphertext: string,
  associatedData: string
): string {
  const key = Buffer.from(apiV3Key, 'utf8');
  const iv = Buffer.from(nonce, 'utf8');
  const encryptedBuffer = Buffer.from(ciphertext, 'base64');

  const authTag = encryptedBuffer.subarray(encryptedBuffer.length - 16);
  const data = encryptedBuffer.subarray(0, encryptedBuffer.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

// ============================================
// 发起 API 请求
// ============================================

async function wechatPayRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const url = `https://api.mch.weixin.qq.com${path}`;
  const bodyStr = body ? JSON.stringify(body) : '';
  const authorization = getAuthorizationHeader(method, path, bodyStr);

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': authorization,
    },
    body: method === 'POST' ? bodyStr : undefined,
  });

  const text = await res.text();

  if (!res.ok) {
    console.error('[WechatPay] API 请求失败:', res.status, text);
    throw new Error(`[WechatPay] API 请求失败 (${res.status}): ${text}`);
  }

  return text ? JSON.parse(text) : ({} as T);
}

// ============================================
// Native 支付（PC 扫码）
// ============================================

export interface CreateNativeOrderParams {
  outTradeNo: string;
  description: string;
  totalFen: number;
  notifyUrl: string;
  timeExpire?: string;
}

export async function createNativeOrder(params: CreateNativeOrderParams): Promise<string> {
  const cfg = getWechatConfig();

  const result = await wechatPayRequest<{ code_url: string }>(
    'POST',
    '/v3/pay/transactions/native',
    {
      appid: cfg.appId,
      mchid: cfg.mchId,
      description: params.description,
      out_trade_no: params.outTradeNo,
      notify_url: params.notifyUrl,
      time_expire: params.timeExpire,
      amount: {
        total: params.totalFen,
        currency: 'CNY',
      },
    }
  );

  return result.code_url;
}

// ============================================
// 查询订单状态
// ============================================

export interface WechatTradeQueryResult {
  tradeState: string;
  transactionId: string;
  outTradeNo: string;
  totalAmount: number;
}

export async function queryWechatOrderStatus(outTradeNo: string): Promise<WechatTradeQueryResult | null> {
  const cfg = getWechatConfig();

  try {
    const result = await wechatPayRequest<{
      trade_state: string;
      transaction_id: string;
      out_trade_no: string;
      amount: { total: number };
    }>('GET', `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${cfg.mchId}`);

    return {
      tradeState: result.trade_state,
      transactionId: result.transaction_id,
      outTradeNo: result.out_trade_no,
      totalAmount: result.amount.total,
    };
  } catch (err) {
    console.error('[WechatPay] 查询订单失败:', err);
    return null;
  }
}

// ============================================
// 关闭订单
// ============================================

export async function closeWechatOrder(outTradeNo: string): Promise<boolean> {
  const cfg = getWechatConfig();

  try {
    await wechatPayRequest('POST', `/v3/pay/transactions/out-trade-no/${outTradeNo}/close`, {
      mchid: cfg.mchId,
    });
    return true;
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes('ORDER_CLOSED') || errMsg.includes('ORDER_NOT_EXIST')) {
      return true;
    }
    console.error('[WechatPay] 关闭订单失败:', err);
    return false;
  }
}

// ============================================
// 验证回调签名
// ============================================

export function verifyWechatPayNotifySignature(params: {
  timestamp: string;
  nonce: string;
  body: string;
  signature: string;
}): boolean {
  const { platformCert } = config.wechatPay;

  if (!platformCert || platformCert.trim().length === 0) {
    console.error('[WechatPay] 未配置 WECHAT_PAY_PLATFORM_CERT，验签拒绝');
    return false;
  }

  try {
    let cert = platformCert.replace(/\\n/g, '\n').trim();

    if (!cert.includes('-----BEGIN') || !cert.includes('-----END')) {
      console.error('[WechatPay] WECHAT_PAY_PLATFORM_CERT 格式不完整');
      return false;
    }

    if (!cert.startsWith('-----')) {
      cert = `-----BEGIN PUBLIC KEY-----\n${cert}\n-----END PUBLIC KEY-----`;
    }

    const message = `${params.timestamp}\n${params.nonce}\n${params.body}\n`;
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(message);
    return verify.verify(cert, params.signature, 'base64');
  } catch (err) {
    console.error('[WechatPay] 签名验证异常:', err);
    return false;
  }
}
