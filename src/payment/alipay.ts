/**
 * 支付宝支付工具模块
 *
 * 使用 alipay-sdk，支持当面付预创建（扫码支付）。
 *
 * 环境变量通过 config.ts 统一管理。
 */

// Polyfill: Node.js 18 没有全局 File，alipay-sdk 内部需要
if (typeof globalThis.File === 'undefined') {
  (globalThis as any).File = class File extends Blob {
    name: string;
    lastModified: number;
    constructor(bits: any[], name: string, options?: any) {
      super(bits, options);
      this.name = name;
      this.lastModified = options?.lastModified ?? Date.now();
    }
  };
}

import { AlipaySdk } from 'alipay-sdk';
import { config } from '../config';

// ============================================
// 单例：支付宝 SDK 实例
// ============================================

let _alipaySdk: AlipaySdk | null = null;

function getAlipaySdk(): AlipaySdk {
  if (_alipaySdk) return _alipaySdk;

  const { alipay } = config;
  if (!alipay.appId || !alipay.privateKey || !alipay.publicKey) {
    throw new Error('[Alipay] 缺少必要配置: alipay.appId/privateKey/publicKey');
  }

  _alipaySdk = new AlipaySdk({
    appId: alipay.appId,
    privateKey: alipay.privateKey,
    alipayPublicKey: alipay.publicKey,
    keyType: alipay.keyType as 'PKCS1' | 'PKCS8',
    signType: 'RSA2',
  });

  return _alipaySdk;
}

// ============================================
// 当面付预创建（扫码支付）
// ============================================

export interface PrecreateParams {
  outTradeNo: string;
  subject: string;
  totalAmount: string;
  notifyUrl: string;
  body?: string;
  timeoutExpress?: string;
}

/**
 * 支付宝当面付预创建 — 生成二维码链接
 */
export async function createPrecreateOrder(params: PrecreateParams): Promise<string> {
  const sdk = getAlipaySdk();

  const result = await sdk.curl<{
    qr_code: string;
    out_trade_no: string;
  }>('POST', '/v3/alipay/trade/precreate', {
    body: {
      out_trade_no: params.outTradeNo,
      total_amount: params.totalAmount,
      subject: params.subject,
      body: params.body || params.subject,
      timeout_express: params.timeoutExpress || '15m',
      notify_url: params.notifyUrl,
    },
  });

  if (!result.data?.qr_code) {
    throw new Error('支付宝预创建失败：未返回二维码链接');
  }

  return result.data.qr_code;
}

// ============================================
// 支付宝异步通知验签
// ============================================

export function verifyNotifySign(params: Record<string, string>): boolean {
  const sdk = getAlipaySdk();
  try {
    return sdk.checkNotifySignV2(params);
  } catch (err) {
    console.error('[Alipay] 验签异常:', err);
    return false;
  }
}

// ============================================
// 查询订单状态
// ============================================

export interface AlipayTradeQueryResult {
  tradeStatus: string;
  tradeNo: string;
  outTradeNo: string;
  totalAmount: string;
}

export async function queryTradeStatus(outTradeNo: string): Promise<AlipayTradeQueryResult | null> {
  const sdk = getAlipaySdk();

  try {
    const result = await sdk.curl<{
      trade_status: string;
      trade_no: string;
      out_trade_no: string;
      total_amount: string;
    }>('POST', '/v3/alipay/trade/query', {
      body: {
        out_trade_no: outTradeNo,
      },
    });

    return {
      tradeStatus: result.data.trade_status,
      tradeNo: result.data.trade_no,
      outTradeNo: result.data.out_trade_no,
      totalAmount: result.data.total_amount,
    };
  } catch (err) {
    const allText = `${String(err)}|${String((err as Record<string, unknown>)?.code || '')}`;
    if (allText.includes('TRADE_NOT_EXIST')) {
      return {
        tradeStatus: 'TRADE_CLOSED',
        tradeNo: '',
        outTradeNo,
        totalAmount: '0',
      };
    }
    console.error('[Alipay] 查询订单失败:', err);
    return null;
  }
}

// ============================================
// 关闭支付宝交易
// ============================================

export async function closeAlipayTrade(outTradeNo: string): Promise<boolean> {
  const sdk = getAlipaySdk();

  try {
    await sdk.curl('POST', '/v3/alipay/trade/close', {
      body: { out_trade_no: outTradeNo },
    });
    return true;
  } catch (err: unknown) {
    const errMsg = String(err);
    const errCode = String((err as Record<string, unknown>)?.code || '');
    const allText = `${errCode}|${errMsg}`;
    if (allText.includes('TRADE_NOT_EXIST') || allText.includes('TRADE_HAS_CLOSE')) {
      return true;
    }
    console.error('[Alipay] 关闭交易失败:', err);
    return false;
  }
}
