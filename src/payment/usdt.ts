/**
 * USDT 支付监听模块
 *
 * 通过轮询区块链浏览器 API 监听 USDT 转入。
 * 支持 BSC (BEP-20) 和 Ethereum (ERC-20)。
 *
 * 原理：
 * 1. 每个订单生成唯一金额（基础价格 + 随机小数）
 * 2. 后端定期轮询 BSCScan/Etherscan API 查询最近的 USDT 转入
 * 3. 匹配到对应金额 → 确认支付
 */

import { config } from '../config';

// USDT 合约地址
const USDT_CONTRACTS: Record<string, string> = {
  bsc: '0x55d398326f99059fF775485246999027B3197955',
  eth: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
};

// 区块链浏览器 API 地址
const SCAN_APIS: Record<string, string> = {
  bsc: 'https://api.bscscan.com/api',
  eth: 'https://api.etherscan.io/api',
};

// USDT 精度
const USDT_DECIMALS: Record<string, number> = {
  bsc: 18, // BSC 上的 USDT 是 18 位
  eth: 6,  // ETH 上的 USDT 是 6 位
};

export interface UsdtTransfer {
  hash: string;
  from: string;
  to: string;
  value: string; // 原始 wei/最小单位
  amount: number; // 换算后的 USDT 金额
  timestamp: number;
  network: string;
}

/**
 * 生成唯一支付金额（基础金额 + 随机尾数）
 * 确保同一时间不会有两个订单金额完全相同
 */
export function generateUniqueAmount(baseAmount: number): number {
  // 随机 2 位小数后缀 (0.0001 ~ 0.0099)
  const suffix = Math.floor(Math.random() * 99 + 1) / 10000;
  return parseFloat((baseAmount + suffix).toFixed(4));
}

/**
 * 查询最近的 USDT 转入记录
 */
export async function getRecentUsdtTransfers(network: 'bsc' | 'eth'): Promise<UsdtTransfer[]> {
  const walletAddress = config.usdt.walletAddress;
  const apiKey = network === 'bsc' ? config.usdt.bscScanApiKey : config.usdt.ethScanApiKey;
  const contractAddress = USDT_CONTRACTS[network];
  const baseUrl = SCAN_APIS[network];
  const decimals = USDT_DECIMALS[network];

  if (!walletAddress || !apiKey) {
    return [];
  }

  const url = `${baseUrl}?module=account&action=tokentx&contractaddress=${contractAddress}&address=${walletAddress}&page=1&offset=20&sort=desc&apikey=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json() as { status: string; result: any[] };

    if (data.status !== '1' || !Array.isArray(data.result)) {
      return [];
    }

    // 只保留转入（to 为我们的地址）
    const lowerWallet = walletAddress.toLowerCase();
    return data.result
      .filter((tx: any) => tx.to.toLowerCase() === lowerWallet)
      .map((tx: any) => ({
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        amount: parseFloat(tx.value) / Math.pow(10, decimals),
        timestamp: parseInt(tx.timeStamp),
        network,
      }));
  } catch (err) {
    console.error(`[USDT] 查询 ${network} 转账记录失败:`, err);
    return [];
  }
}

/**
 * 检查是否收到指定金额的 USDT 转入
 * @param expectedAmount 期望金额（USDT，4位小数精度匹配）
 * @param sinceTimestamp 只查看此时间之后的转账（Unix 秒）
 * @param network 指定网络，不传则两个网络都查
 */
export async function checkPaymentReceived(
  expectedAmount: number,
  sinceTimestamp: number,
  network?: 'bsc' | 'eth'
): Promise<UsdtTransfer | null> {
  const networks = network ? [network] : ['bsc', 'eth'] as const;

  for (const net of networks) {
    const transfers = await getRecentUsdtTransfers(net as 'bsc' | 'eth');

    for (const tx of transfers) {
      // 时间过滤：只看订单创建之后的转账
      if (tx.timestamp < sinceTimestamp) continue;

      // 金额匹配：精确到 4 位小数
      if (Math.abs(tx.amount - expectedAmount) < 0.00005) {
        return tx;
      }
    }
  }

  return null;
}
