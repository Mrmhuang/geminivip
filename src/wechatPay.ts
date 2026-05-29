/**
 * 微信支付 V3 工具模块（精简版）
 *
 * 仅保留 Native 支付（PC扫码）和订单查询，不含 JSAPI / webhook 验签。
 * 基于 artisanResume 项目的 wechat.ts，使用原生 Node.js crypto，无需第三方 SDK。
 *
 * 环境变量：
 * - WECHAT_PAY_MCH_ID: 商户号
 * - WECHAT_PAY_API_V3_KEY: APIv3 密钥（32位）
 * - WECHAT_PAY_PRIVATE_KEY: 商户API私钥（PEM 格式内容，换行用 \n）
 * - WECHAT_PAY_SERIAL_NO: 商户证书序列号
 * - WECHAT_PAY_APPID: 服务号 AppID
 */

import crypto from 'crypto';
import { config } from './config';

// ============================================
// 配置读取
// ============================================

interface WechatPayConfig {
  mchId: string;
  apiV3Key: string;
  privateKey: string;
  serialNo: string;
  appId: string;
}

let _config: WechatPayConfig | null = null;

function getConfig(): WechatPayConfig {
  if (_config) return _config;

  const { mchId, apiV3Key, privateKey: privateKeyRaw, serialNo, appId } = config.wechatPay;

  if (!mchId || !apiV3Key || !privateKeyRaw || !serialNo || !appId) {
    throw new Error(
      '[WechatPay] 缺少必要配置: WECHAT_PAY_MCH_ID, WECHAT_PAY_API_V3_KEY, WECHAT_PAY_PRIVATE_KEY, WECHAT_PAY_SERIAL_NO, WECHAT_PAY_APPID'
    );
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

  _config = { mchId, apiV3Key, privateKey, serialNo, appId };
  return _config;
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
  const cfg = getConfig();
  const message = `${method}\n${url}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  return sign.sign(cfg.privateKey, 'base64');
}

function getAuthorizationHeader(
  method: string,
  url: string,
  body: string = ''
): string {
  const cfg = getConfig();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const signature = generateSignature(method, url, timestamp, nonceStr, body);

  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.serialNo}"`;
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
  timeExpire?: string;
}

interface NativeOrderResponse {
  code_url: string;
}

/**
 * 创建 Native 支付订单（返回二维码链接）
 */
export async function createNativeOrder(params: CreateNativeOrderParams): Promise<string> {
  const cfg = getConfig();

  const result = await wechatPayRequest<NativeOrderResponse>(
    'POST',
    '/v3/pay/transactions/native',
    {
      appid: cfg.appId,
      mchid: cfg.mchId,
      description: params.description,
      out_trade_no: params.outTradeNo,
      amount: {
        total: params.totalFen,
        currency: 'CNY',
      },
      ...(params.timeExpire ? { time_expire: params.timeExpire } : {}),
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

/**
 * 查询微信支付订单状态
 */
export async function queryWechatOrderStatus(outTradeNo: string): Promise<WechatTradeQueryResult | null> {
  const cfg = getConfig();

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

/**
 * 关闭微信支付订单（取消未付款订单）
 */
export async function closeWechatOrder(outTradeNo: string): Promise<boolean> {
  const cfg = getConfig();

  try {
    await wechatPayRequest('POST', `/v3/pay/transactions/out-trade-no/${outTradeNo}/close`, {
      mchid: cfg.mchId,
    });
    console.log('[WechatPay] 订单关闭成功:', outTradeNo);
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
