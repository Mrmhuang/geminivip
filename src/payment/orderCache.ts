/**
 * 订单状态内存缓存
 *
 * 桥接 webhook 回调与前端轮询：
 * 1. Webhook 收到支付成功 → markOrderPaid() 写入内存
 * 2. 前端轮询 /api/order/:orderId → 检查内存缓存
 * 3. 如果内存没有 → 主动查询支付渠道确认
 *
 * 单实例部署适用，进程重启后缓存丢失（但数据库有记录）。
 */

export interface PaidOrderInfo {
  tradeNo: string;
  totalAmount: string;
  paidAt: string;
  taskId?: string;
}

const paidOrders = new Map<string, PaidOrderInfo>();

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function markOrderPaid(orderId: string, info: PaidOrderInfo): void {
  paidOrders.set(orderId, info);
  setTimeout(() => {
    paidOrders.delete(orderId);
  }, CACHE_TTL_MS);
}

export function getPaidOrderInfo(orderId: string): PaidOrderInfo | null {
  return paidOrders.get(orderId) || null;
}

export function isOrderPaid(orderId: string): boolean {
  return paidOrders.has(orderId);
}

export function updateCachedOrderTask(orderId: string, taskId: string): void {
  const info = paidOrders.get(orderId);
  if (info) {
    info.taskId = taskId;
  }
}
