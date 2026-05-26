import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import { config } from './config';
import { Task, setProcessor, findProcessingTask } from './taskQueue';
import { updateTelegramStatus, findSubmitLogByEmail } from './database';
import { startBindCard } from './browserWorker';

const BOT_USERNAME = 'sheeridvn_bot';

let client: TelegramClient | null = null;
let botId: bigInt.BigInteger | null = null;

/**
 * 初始化 Telegram 客户端（带重试）
 */
export async function initTelegram(): Promise<void> {
  if (!config.telegram.session) {
    console.warn('[Telegram] No session configured. Run `npm run setup-session` first.');
    console.warn('[Telegram] Queue processor disabled - tasks will stay in queued state.');
    return;
  }

  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await connectTelegram();
      return; // 成功则退出
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error(`[Telegram] Connection attempt ${attempt}/${maxRetries} failed: ${msg}`);

      if (msg.includes('AUTH_KEY_DUPLICATED')) {
        // 等待较长时间让 Telegram 服务端释放旧连接
        const delay = attempt * 15000; // 15s, 30s, 45s, 60s, 75s
        console.log(`[Telegram] AUTH_KEY_DUPLICATED - waiting ${delay / 1000}s before retry...`);
        await sleep(delay);
      } else if (attempt < maxRetries) {
        await sleep(5000);
      } else {
        // 最终失败也不崩溃进程，只是禁用 Telegram 功能
        console.error('[Telegram] All connection attempts failed. Queue processor disabled.');
        console.error('[Telegram] Service will run without Telegram. Restart container to retry.');
        return;
      }
    }
  }
}

/**
 * 断开当前连接，用新 session 重连（热更新）
 * @returns 成功/失败消息
 */
export async function reconnectTelegram(): Promise<string> {
  // 断开旧连接
  if (client) {
    try {
      await client.disconnect();
    } catch (e) {
      // 忽略断开错误
    }
    client = null;
    botId = null;
  }

  if (!config.telegram.session) {
    return 'No session configured';
  }

  // 尝试用新 session 连接
  try {
    await connectTelegram();
    return 'Telegram reconnected successfully';
  } catch (err: any) {
    return `Reconnect failed: ${err?.message || String(err)}`;
  }
}

/**
 * 获取 Telegram 连接状态
 */
export function getTelegramStatus(): { connected: boolean; lastError?: string } {
  return {
    connected: client !== null && client.connected === true,
  };
}

/**
 * Telegram 拨测：验证 session 是否有效，能否正常和 bot 通信
 * 返回详细诊断信息
 */
export async function pingTelegram(): Promise<{
  ok: boolean;
  clientConnected: boolean;
  me?: string;
  botReachable?: boolean;
  botUsername?: string;
  latencyMs?: number;
  error?: string;
}> {
  const start = Date.now();
  
  if (!client) {
    return { ok: false, clientConnected: false, error: 'Telegram 客户端未初始化' };
  }
  
  if (!client.connected) {
    return { ok: false, clientConnected: false, error: 'Telegram 客户端未连接' };
  }

  try {
    // 1. 调用 getMe() 验证 session 有效性
    const me = await client.getMe() as any;
    const meInfo = me?.username ? `@${me.username}` : (me?.firstName || 'unknown');

    // 2. 尝试获取 bot 实体，验证能否和 bot 通信
    let botReachable = false;
    let botUsername = '';
    try {
      const botEntity = await client.getEntity(BOT_USERNAME) as any;
      botReachable = true;
      botUsername = botEntity?.username || BOT_USERNAME;
    } catch (e: any) {
      botReachable = false;
    }

    const latencyMs = Date.now() - start;
    return {
      ok: botReachable,
      clientConnected: true,
      me: meInfo,
      botReachable,
      botUsername,
      latencyMs,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      clientConnected: true,
      error: err?.message || String(err),
      latencyMs,
    };
  }
}

async function connectTelegram(): Promise<void> {
  const session = new StringSession(config.telegram.session);
  client = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 3,
  });

  await client.connect();
  console.log('[Telegram] Connected successfully');

  // 缓存 bot ID
  const botEntity = await client.getEntity(BOT_USERNAME);
  botId = (botEntity as any).id;

  // 注册后台监听器：捕获 bot 的异步结果（成功/失败）
  client.addEventHandler(handleBotResult, new NewMessage({ fromUsers: [BOT_USERNAME] }));

  // 注册队列处理器
  setProcessor(processTask);
}

/**
 * 处理单个认证任务（只做 Steps 1-4，不等最终结果）
 */
async function processTask(task: Task): Promise<void> {
  if (!client) throw new Error('Telegram 客户端未初始化');

  const entity = await client.getEntity(BOT_USERNAME);

  // 获取当前最新消息ID
  const lastMsgs = await client.getMessages(entity, { limit: 1 });
  let lastMsgId = lastMsgs.length > 0 ? lastMsgs[0].id : 0;

  // Step 1: /pixel — 发送后等 bot 回复即可
  await client.sendMessage(entity, { message: '/pixel' });
  let result = await waitForResponse(entity, lastMsgId, 15000);
  lastMsgId = result.newLastId;
  checkForError(result.text, 'Step 1');
  console.log(`[Task ${task.id}] Step 1 OK`);

  // Step 2: 邮箱
  await client.sendMessage(entity, { message: task.email });
  result = await waitForResponse(entity, lastMsgId, 15000);
  lastMsgId = result.newLastId;
  checkForError(result.text, 'Step 2');
  console.log(`[Task ${task.id}] Step 2 OK`);

  // Step 3: 密码
  await client.sendMessage(entity, { message: task.password });
  result = await waitForResponse(entity, lastMsgId, 15000);
  lastMsgId = result.newLastId;
  checkForError(result.text, 'Step 3');
  console.log(`[Task ${task.id}] Step 3 OK`);

  // Step 4: TOTP key — bot 收到后开始执行任务
  await client.sendMessage(entity, { message: task.totpKey });
  result = await waitForResponse(entity, lastMsgId, 30000);
  lastMsgId = result.newLastId;
  console.log(`[Task ${task.id}] Step 4 OK - ${result.text.slice(0, 80)}`);

  // 注意：不在此处清除 password/totpKey，绑卡阶段仍需使用
  // 敏感信息将在 browserWorker 完成后的 finally 块中清除

  // 如果 bot 立即返回失败结果
  if (result.text.includes('失败')) {
    const reasonMatch = result.text.match(/原因[:：]\s*(.+)/);
    const reason = reasonMatch ? reasonMatch[1].trim() : '请检查您发送的信息，或稍后再试。';
    task.status = 'failed';
    task.message = `认证失败: ${reason}`;
    console.log(`[Task ${task.id}] Failed immediately: ${reason}`);
    return;
  }

  // 提取 Job ID — bot 回复"正在运行中"即表示已接收，可以开始下一个任务
  const jobMatch = result.text.match(/Job:\s*`?([a-f0-9]+)`?/);
  if (jobMatch) {
    task.jobId = jobMatch[1];
  }

  // 立即释放队列！bot 已接管此任务，结果由 handleBotResult 异步处理
  task.status = 'processing';
  task.message = '已提交认证，无需在此等待。请通过提交时获得的链接（/?taskId=...）随时查看进度，整个流程约需10~20分钟。';
  console.log(`[Task ${task.id}] Job submitted (${task.jobId || 'unknown'}), queue released - ready for next task`);
}

/**
 * 检查 bot 回复中是否包含错误/失败信息，有则提前抛出
 */
function checkForError(text: string, step: string): void {
  if (text.includes('失败') || text.includes('错误') || text.includes('无效') || text.includes('Error')) {
    const reasonMatch = text.match(/原因[:：]\s*(.+)/);
    const reason = reasonMatch ? reasonMatch[1].trim() : text.slice(0, 100);
    throw new Error(`${step} 失败: ${reason}`);
  }
}

/**
 * 后台监听器：处理 bot 发来的异步结果
 */
async function handleBotResult(event: Api.UpdateNewMessage): Promise<void> {
  const message = event.message as Api.Message;
  if (!message?.message) return;

  const text = message.message;

  // 只处理最终结果消息（成功或失败）
  if (!text.includes('成功') && !text.includes('失败')) return;

  // 提取邮箱和 Job ID 来匹配任务
  const emailMatch = text.match(/Mail:\s*(\S+@\S+)/);
  const jobMatch = text.match(/Job:\s*`?([a-f0-9]+)`?/);
  const email = emailMatch ? emailMatch[1] : undefined;
  const jobId = jobMatch ? jobMatch[1] : undefined;

  const task = findProcessingTask(email, jobId);
  if (!task) {
    console.log(`[Telegram] Received result but no matching task: job=${jobId} email=${email}`);
    return;
  }

  if (text.includes('成功')) {
    const linkMatch = text.match(/https:\/\/one\.google\.com\/offer\/[A-Z0-9]+/);
    const link = linkMatch ? linkMatch[0] : '';

    // 第一阶段完成：Telegram 认证成功
    task.status = 'auth_success';
    task.offerLink = link;
    task.message = link
      ? `认证成功！正在自动绑卡...`
      : '认证成功！但未获取到链接，绑卡无法执行。';

    // 更新数据库中的 Telegram 状态
    const logId = findSubmitLogByEmail(task.email);
    if (logId) updateTelegramStatus(logId, 'success', link);

    console.log(`[Task ${task.id}] Telegram认证成功，offer链接: ${link}`);

    // 如果有链接，异步触发绑卡（不阻塞 Telegram 队列）
    if (link) {
      console.log(`[Task ${task.id}] 异步触发绑卡流程...`);
      startBindCard(task).catch(err => {
        console.error(`[Task ${task.id}] 绑卡异步执行出错: ${err.message}`);
      });
    } else {
      // 没有链接，直接标记失败
      task.status = 'failed';
      task.message = '认证成功但未获取到Google One Pro链接，无法绑卡。';
      if (logId) updateTelegramStatus(logId, 'success_no_link');
    }
  } else {
    const reasonMatch = text.match(/原因[:：]\s*(.+)/);
    const reason = reasonMatch ? reasonMatch[1].trim() : '请检查您发送的信息，或稍后再试。';
    task.status = 'failed';
    task.message = `认证失败: ${reason}`;

    // 更新数据库
    const logId = findSubmitLogByEmail(task.email);
    if (logId) updateTelegramStatus(logId, 'failed');
  }

  console.log(`[Task ${task.id}] Final result: ${task.status} - ${task.message}`);
}

/**
 * 等待 bot 的下一条回复
 */
async function waitForResponse(entity: Api.TypeEntityLike, afterMsgId: number, timeout = 15000): Promise<{ text: string; newLastId: number }> {
  if (!client) throw new Error('Telegram 客户端未初始化');
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    await sleep(1000);
    const messages = await client.getMessages(entity, { limit: 5, minId: afterMsgId });
    for (const msg of messages) {
      if (msg.senderId && botId && msg.senderId.equals(botId) && msg.id > afterMsgId) {
        return { text: msg.text || '', newLastId: msg.id };
      }
    }
  }
  throw new Error('等待机器人回复超时');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
