import crypto from 'crypto';

export interface Task {
  id: string;
  email: string;
  password: string;
  totpKey: string;
  cardKey: string; // 卡密，认证成功后才消耗
  offerLink?: string; // 认证成功后获取的 Google One Pro 链接
  status: 'queued' | 'running' | 'processing' | 'auth_success' | 'bindcard_running' | 'success' | 'failed';
  message: string;
  createdAt: number;
  position?: number;
  jobId?: string; // Bot 返回的 Job ID，用于匹配异步结果
}

// 内存任务存储
const tasks = new Map<string, Task>();

// FIFO 队列
const queue: Task[] = [];

// 队列处理器回调
let processor: ((task: Task) => Promise<void>) | null = null;
let processing = false;

/**
 * 检查队列处理器是否就绪（Telegram 已连接）
 */
export function isProcessorReady(): boolean {
  return processor !== null;
}

/**
 * 创建新任务并加入队列
 */
export function createTask(email: string, password: string, totpKey: string, cardKey: string): Task {
  const task: Task = {
    id: crypto.randomBytes(6).toString('hex'),
    email,
    password,
    totpKey,
    cardKey,
    status: 'queued',
    message: '排队中...',
    createdAt: Date.now(),
  };
  tasks.set(task.id, task);
  queue.push(task);
  task.position = queue.length;
  processNext();
  return task;
}

/**
 * 获取任务状态（对外安全版本，不暴露敏感信息）
 */
export function getTaskStatus(taskId: string): { status: string; message: string; position?: number } | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  const position = task.status === 'queued' ? queue.indexOf(task) + 1 : undefined;
  return { status: task.status, message: task.message, position };
}

/**
 * 通过 taskId 获取原始 Task 对象（内部使用）
 */
export function getTask(taskId: string): Task | undefined {
  return tasks.get(taskId);
}

/**
 * 检查某邮箱是否有活跃（未完成）的任务
 */
export function isEmailActive(email: string): boolean {
  for (const task of tasks.values()) {
    if (task.email === email && !['success', 'failed'].includes(task.status)) {
      return true;
    }
  }
  return false;
}

/**
 * 通过邮箱或 jobId 查找正在处理中的任务
 */
export function findProcessingTask(email?: string, jobId?: string): Task | undefined {
  for (const task of tasks.values()) {
    if (task.status !== 'processing') continue;
    if (jobId && task.jobId === jobId) return task;
    if (email && task.email === email) return task;
  }
  return undefined;
}

/**
 * 获取当前排队数量（仅等待中的）
 */
export function getQueueLength(): number {
  return queue.length;
}

/**
 * 获取当前活跃任务数量（排队 + 正在处理）
 */
export function getActiveCount(): number {
  let count = queue.length;
  for (const task of tasks.values()) {
    if (task.status === 'running' || task.status === 'processing' || task.status === 'auth_success' || task.status === 'bindcard_running') {
      count++;
    }
  }
  return count;
}

/**
 * 注册队列处理器
 */
export function setProcessor(fn: (task: Task) => Promise<void>): void {
  processor = fn;
}

/**
 * 处理队列中的下一个任务
 */
async function processNext(): Promise<void> {
  if (processing || queue.length === 0) return;

  // 处理器未就绪时，将所有排队任务标记失败
  if (!processor) {
    while (queue.length > 0) {
      const task = queue.shift()!;
      task.status = 'failed';
      task.message = '认证服务暂不可用，请稍后重试。';
      task.password = '';
      task.totpKey = '';
    }
    return;
  }

  processing = true;

  const task = queue.shift()!;
  task.status = 'running';
  task.message = '正在执行认证...';

  try {
    // 90秒超时保护，防止单个任务阻塞队列
    await withTimeout(processor(task), 90000, '任务执行超时，请重试');
    // processor 将 task 标记为 processing，不在这里改状态
  } catch (err: any) {
    task.status = 'failed';
    task.message = err.message || '认证失败，请重试';
    task.password = '';
    task.totpKey = '';
  }

  processing = false;
  // 立即处理下一个
  processNext();
}

/**
 * Promise 超时包装
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise
      .then(value => { clearTimeout(timer); resolve(value); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

/**
 * 定期清理过期任务（1小时）
 */
setInterval(() => {
  const expiry = Date.now() - 60 * 60 * 1000;
  for (const [id, task] of tasks) {
    if (task.createdAt < expiry) tasks.delete(id);
  }
}, 10 * 60 * 1000);
