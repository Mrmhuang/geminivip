import { chromium, Browser, Page } from 'playwright';
import { TOTP } from 'otpauth';
import { Task } from './taskQueue';
import { config } from './config';
import { logSuccess, markKeyUsed, updateBindStatus, findSubmitLogByEmail } from './database';
import path from 'path';
import fs from 'fs';

let browser: Browser | null = null;

// ====== 绑卡串行队列 ======
// 防止多个任务同时绑卡导致服务器资源不足或 Chrome 崩溃
type BindCardJob = () => Promise<any>;
interface QueueItem {
  job: BindCardJob;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  label: string;
}
const bindCardQueue: QueueItem[] = [];
let bindCardRunning = false;

function enqueueBindCard<T>(job: () => Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    bindCardQueue.push({ job, resolve, reject, label });
    console.log(`[BindQueue] 任务 "${label}" 入队，当前队列长度: ${bindCardQueue.length}，正在执行: ${bindCardRunning}`);
    processBindCardQueue();
  });
}

async function processBindCardQueue(): Promise<void> {
  if (bindCardRunning) return;
  const item = bindCardQueue.shift();
  if (!item) return;
  bindCardRunning = true;
  console.log(`[BindQueue] 开始执行: "${item.label}"，剩余队列: ${bindCardQueue.length}`);
  try {
    const result = await item.job();
    item.resolve(result);
  } catch (e) {
    item.reject(e);
  } finally {
    bindCardRunning = false;
    // 处理下一个
    processBindCardQueue();
  }
}
// ============================

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 持久化 user data 目录 — 让 Chrome 保留 cookie / local storage 等数据
// 这是绕过 Google "此浏览器不安全" 检测的关键：全新空 profile 是最大的红旗
const USER_DATA_DIR = path.join(DATA_DIR, 'chrome-profile');
if (!fs.existsSync(USER_DATA_DIR)) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

// 统一的 PC 桌面端浏览器画布配置（有头/无头共用）
// 避免移动端 viewport 导致 Google 页面走移动版布局，DOM 结构与选择器都会不同
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/**
 * 获取 Chrome 启动参数 — 尽可能伪装为真人用户操作的正版 Chrome
 */
function getChromeArgs(): string[] {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    // 禁用自动化提示条 "Chrome is being controlled by automated test software"
    '--disable-automation',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // 禁用 "save password" 弹框
    '--disable-save-password-bubble',
    // 禁用翻译
    '--disable-translate',
    // 禁用扩展安装提示
    '--disable-extensions-except=',
    '--disable-default-apps',
    // 有头模式下，让浏览器窗口尺寸与 viewport 对齐
    `--window-size=${DESKTOP_VIEWPORT.width},${DESKTOP_VIEWPORT.height}`,
  ];
}

/**
 * 初始化浏览器实例
 * 使用系统安装的 Google Chrome（channel: 'chrome'），而非 Playwright 自带的 Chromium
 * Playwright 自带 Chromium 缺少 Google 签名，容易被 Google 检测为不安全浏览器
 */
export async function initBrowser(): Promise<void> {
  try {
    browser = await chromium.launch({
      headless: config.browser.headless,
      channel: 'chrome',  // 使用系统安装的正版 Google Chrome
      args: getChromeArgs(),
    });
    console.log(
      `[Browser] Google Chrome launched successfully (headless: ${config.browser.headless}, viewport: ${DESKTOP_VIEWPORT.width}x${DESKTOP_VIEWPORT.height}, channel: chrome)`
    );
  } catch (err: any) {
    // 如果系统没有 Chrome，回退到 Playwright 自带 Chromium
    console.warn(`[Browser] Google Chrome not found, falling back to Chromium: ${err.message}`);
    try {
      browser = await chromium.launch({
        headless: config.browser.headless,
        args: getChromeArgs(),
      });
      console.log(
        `[Browser] Chromium launched successfully (headless: ${config.browser.headless}, viewport: ${DESKTOP_VIEWPORT.width}x${DESKTOP_VIEWPORT.height}, fallback)`
      );
    } catch (err2: any) {
      console.error(`[Browser] Failed to launch: ${err2.message}`);
      console.error('[Browser] Bind card feature will be unavailable.');
    }
  }
}

/**
 * 全面的反检测注入脚本（以字符串形式，通过 addInitScript 注入浏览器环境）
 * 修补 Google 用来检测自动化浏览器的所有已知特征
 */
const STEALTH_SCRIPT = `
  // 1. 删除 navigator.webdriver 标志
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // 2. 伪造完整的 navigator.plugins（正常 Chrome 至少有这些插件）
  (function() {
    const makePlugin = (name, desc, filename) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name: { get: () => name },
        description: { get: () => desc },
        filename: { get: () => filename },
        length: { get: () => 1 },
      });
      return plugin;
    };

    const fakePlugins = [
      makePlugin('Chrome PDF Plugin', 'Portable Document Format', 'internal-pdf-viewer'),
      makePlugin('Chrome PDF Viewer', '', 'mhjfbmdgcfjbbpaeojofohoefgiehjai'),
      makePlugin('Chromium PDF Plugin', 'Portable Document Format', 'internal-pdf-viewer'),
      makePlugin('Chromium PDF Viewer', '', 'mhjfbmdgcfjbbpaeojofohoefgiehjai'),
      makePlugin('Native Client', '', 'internal-nacl-plugin'),
    ];

    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [...fakePlugins];
        arr.item = (i) => arr[i] || null;
        arr.namedItem = (name) => arr.find((p) => p.name === name) || null;
        arr.refresh = () => {};
        return arr;
      },
    });

    // 3. 伪造 navigator.mimeTypes
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const arr = [{
          type: 'application/pdf',
          suffixes: 'pdf',
          description: 'Portable Document Format',
          enabledPlugin: fakePlugins[0],
        }];
        arr.item = (i) => arr[i] || null;
        arr.namedItem = (name) => arr.find((m) => m.type === name) || null;
        return arr;
      },
    });
  })();

  // 4. 伪造 languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['zh-CN', 'zh', 'en-US', 'en'],
  });

  // 5. 确保 window.chrome 完整
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = {
    connect: function() {},
    sendMessage: function() {},
    id: undefined,
    PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
  };
  window.chrome.loadTimes = function() {
    return {
      commitLoadTime: Date.now() / 1000,
      connectionInfo: 'h2',
      finishDocumentLoadTime: Date.now() / 1000,
      finishLoadTime: Date.now() / 1000,
      firstPaintAfterLoadTime: 0,
      firstPaintTime: Date.now() / 1000,
      navigationType: 'Other',
      npnNegotiatedProtocol: 'h2',
      requestTime: Date.now() / 1000 - 0.3,
      startLoadTime: Date.now() / 1000 - 0.3,
      wasAlternateProtocolAvailable: false,
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true,
    };
  };
  window.chrome.csi = function() {
    return { onloadT: Date.now(), startE: Date.now() - 300, pageT: 300, tran: 15 };
  };

  // 6. 修复 Permissions API
  const originalQuery = navigator.permissions.query;
  navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery.call(navigator.permissions, parameters)
  );

  // 7. 伪造硬件信息
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  // 8. WebGL vendor/renderer 伪造
  (function() {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Google Inc. (Apple)';
      if (parameter === 37446) return 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)';
      return getParameter.call(this, parameter);
    };
  })();

  // 9. 修补 Function.prototype.toString 检测
  (function() {
    const nativeToString = Function.prototype.toString;
    const hook = new WeakMap();
    const handler = {
      apply(target, thisArg, args) {
        const result = hook.get(thisArg);
        if (result) return result;
        return nativeToString.apply(thisArg, args);
      },
    };
    Function.prototype.toString = new Proxy(nativeToString, handler);
    hook.set(Function.prototype.toString, 'function toString() { [native code] }');
  })();
`;

/**
 * 获取浏览器状态
 */
export function getBrowserStatus(): { connected: boolean } {
  return { connected: browser !== null && browser.isConnected() };
}

/**
 * 关闭浏览器
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * 在 Google 登录/订阅页面上，按"可见文本"稳健点击一个按钮。
 *
 * 背景：Google 经常把文案放在 `<span jsname="V67aGc">` 里，外层是真正接收 click 的
 * `<button>`/`<div role="button">`。直接点 span 有时候不会触发 button 的事件
 * （尤其是在桌面端 PC 布局下，span 上不一定有事件监听），导致看上去"点了但没反应"。
 *
 * 解决方案（按优先级降级）：
 *   1) 优先用 getByRole('button', { name })，匹配 accessibility name；
 *   2) 退化到 [role="button"]，按 has-text 找；
 *   3) 退化到 span 文本 → 向上找最近的 button / [role="button"] 祖先；
 *   4) 实在不行就直接点 span 自身。
 *
 * @param page Playwright Page
 * @param textPatterns 可识别该按钮的中英文文案数组（按 OR 关系匹配）
 * @param label 用于日志的步骤名称
 */
async function clickButtonByText(
  page: Page,
  textPatterns: (string | RegExp)[],
  label: string,
  timeout = 15000
): Promise<void> {
  // 合成一个 OR 正则，例如 /^(下一步|Next)$/
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sourceList = textPatterns.map((p) => (p instanceof RegExp ? p.source : escape(p)));
  const combinedRegex = new RegExp(`(${sourceList.join('|')})`, 'i');

  // 候选定位器，按可靠性排序
  const candidates = [
    page.getByRole('button', { name: combinedRegex }),
    page.locator('[role="button"]').filter({ hasText: combinedRegex }),
    // span 文本 → 向上找最近的 button / [role=button] 祖先
    page
      .locator('span[jsname="V67aGc"]')
      .filter({ hasText: combinedRegex })
      .locator('xpath=ancestor-or-self::*[self::button or @role="button"][1]'),
    // 最终兜底：直接 span 自身
    page.locator('span[jsname="V67aGc"]').filter({ hasText: combinedRegex }),
  ];

  const deadline = Date.now() + timeout;
  let lastErr: any = null;

  for (const loc of candidates) {
    if (Date.now() > deadline) break;
    try {
      const target = loc.first();
      const remain = Math.max(1000, deadline - Date.now());
      await target.waitFor({ state: 'visible', timeout: remain });
      try {
        await target.scrollIntoViewIfNeeded({ timeout: 2000 });
      } catch (_) {}
      await target.click({ timeout: 5000 });
      console.log(`[Click] "${label}" ✅`);
      return;
    } catch (err: any) {
      lastErr = err;
      // 当前候选不行，换下一个
    }
  }

  throw new Error(`无法点击按钮「${label}」(${combinedRegex.source}): ${lastErr?.message || 'unknown'}`);
}

/**
 * 确保当前 Google 页面的 URL 上带有 `hl=zh`，否则补全并 reload。
 *
 * 背景：Google 的 accounts.google.com、one.google.com 等域名会根据
 *  - URL 上的 `hl` 参数
 *  - 浏览器 Accept-Language
 *  - 用户 Google 账号的语言偏好
 * 综合决定页面渲染语言。即使我们在 context 里设了 `locale: 'zh-CN'`，
 * 跳转到 `one.google.com` 后页面也可能是英文（尤其是账号本身偏好英文时），
 * 这会导致后续以"开始试用 / 添加卡 / 保存卡 / 订阅"等中文文案选择 DOM 时全部失配。
 *
 * 这里的做法是：只要当前 host 是 Google 域，就检查 `hl` 是否为 `zh`，
 * 不是就追加 `hl=zh` 并 `page.goto` 重新加载。是幂等的：已经是 zh 就不动。
 *
 * 注意：必须在 Step 之间调用（页面已经加载完毕、URL 稳定时），不要在
 * 任何点击动作刚发出、还没等到导航完成时调用，避免读到过渡 URL。
 */
async function ensureChineseLocale(page: Page, label: string): Promise<void> {
  try {
    const currentUrl = page.url();
    // 只对 Google 系域名生效，避免误改其他第三方跳转
    if (!/(^|\.)google\.com\//.test(currentUrl) && !currentUrl.includes('google.com')) {
      return;
    }
    const url = new URL(currentUrl);
    if (url.searchParams.get('hl') === 'zh') {
      return;
    }
    url.searchParams.set('hl', 'zh');
    console.log(`[Locale] ${label} 当前 URL 缺少 hl=zh，补全后刷新: ${url.toString()}`);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch (err: any) {
    // 不让语言修正本身阻断主流程，只打 warn
    console.warn(`[Locale] ${label} 检查 hl=zh 失败，跳过: ${err?.message || err}`);
  }
}

/**
 * 根据 TOTP secret key 生成当前验证码
 */
function generateTOTP(secretKey: string): string {
  const totp = new TOTP({
    secret: secretKey.replace(/\s/g, ''),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  });
  return totp.generate();
}

/**
 * 绑卡入口：Telegram 认证成功后调用
 * 通过串行队列执行，同一时间只有一个绑卡任务在运行
 */
export async function startBindCard(task: Task): Promise<void> {
  return enqueueBindCard(() => _startBindCardImpl(task), `bindCard-${task.id}`);
}

/** 绑卡全流程超时（10分钟） */
const BINDCARD_TIMEOUT_MS = 10 * 60 * 1000;

async function _startBindCardImpl(task: Task): Promise<void> {
  // 全局超时包装，防止浏览器操作无限卡住
  return Promise.race([
    _startBindCardCore(task),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('绑卡流程超时（超过10分钟），已强制中断')), BINDCARD_TIMEOUT_MS)
    ),
  ]).catch((err: any) => {
    if (task.status !== 'success' && task.status !== 'failed') {
      task.status = 'failed';
      task.message = err.message || '绑卡超时';
      task.password = '';
      task.totpKey = '';
      const logId = findSubmitLogByEmail(task.email);
      if (logId) updateBindStatus(logId, 'failed', err.message);
      console.error(`[Task ${task.id}] ❌ 绑卡全局超时: ${err.message}`);
    }
  });
}

async function _startBindCardCore(task: Task): Promise<void> {
  if (!browser || !browser.isConnected()) {
    console.error(`[Task ${task.id}] Browser not available, attempting to relaunch...`);
    await initBrowser();
    if (!browser) {
      task.status = 'failed';
      task.message = '浏览器启动失败，绑卡无法执行';
      const logId = findSubmitLogByEmail(task.email);
      if (logId) updateBindStatus(logId, 'failed', '浏览器启动失败');
      return;
    }
  }

  task.status = 'bindcard_running';
  task.message = '正在自动绑卡...';

  const logId = findSubmitLogByEmail(task.email);
  if (logId) updateBindStatus(logId, 'running');

  // 每个任务用独立 context（隔离 cookie/session）
  // 统一使用 PC 桌面端 UA + viewport，避免 Google 走移动版布局
  const context = await browser.newContext({
    userAgent: DESKTOP_USER_AGENT,
    viewport: DESKTOP_VIEWPORT,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  });

  const page = await context.newPage();

  // 注入全面的反检测脚本（在页面加载前执行）
  await page.addInitScript(STEALTH_SCRIPT);

  try {
    const offerLink = task.offerLink || config.browser.offerUrl;
    console.log(`[Task ${task.id}] === 开始绑卡流程 ===`);
    console.log(`[Task ${task.id}] Offer Link: ${offerLink}`);

    // ============ Step 1: 打开 Google One Pro 链接 ============
    console.log(`[Task ${task.id}] Step 1: 打开 offer 链接...`);
    await page.goto(offerLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // 检查登录页 URL 是否包含 hl=zh，确保后续中文 DOM 选择器可用
    let currentUrl = page.url();
    console.log(`[Task ${task.id}] 重定向到: ${currentUrl}`);
    await ensureChineseLocale(page, `Task ${task.id} 登录页`);

    // ============ Step 2: 输入邮箱 ============
    console.log(`[Task ${task.id}] Step 2: 输入邮箱...`);
    const emailInput = page.locator('input#identifierId, input[name="identifier"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(task.email);
    await page.waitForTimeout(500);

    // ============ Step 3: 点击下一步 ============
    console.log(`[Task ${task.id}] Step 3: 点击下一步（邮箱）...`);
    await clickButtonByText(page, ['下一步', /^Next$/], '下一步（邮箱）');
    await page.waitForTimeout(3000);

    // ============ Step 4: 输入密码 ============
    console.log(`[Task ${task.id}] Step 4: 输入密码...`);
    const passwordInput = page.locator('input[name="Passwd"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
    await passwordInput.fill(task.password);
    await page.waitForTimeout(500);

    // ============ Step 5: 点击下一步 ============
    console.log(`[Task ${task.id}] Step 5: 点击下一步（密码）...`);
    await clickButtonByText(page, ['下一步', /^Next$/], '下一步（密码）');
    await page.waitForTimeout(3000);

    // ============ Step 6: 点击"试试其他方式" ============
    // 这里之前直接点 span 经常无反应（事件挂在外层 button 上），改用稳健点击
    console.log(`[Task ${task.id}] Step 6: 点击"试试其他方式"...`);
    await clickButtonByText(
      page,
      ['试试其他方式', '尝试其他方式', /Try another way/i],
      '试试其他方式'
    );
    await page.waitForTimeout(2000);

    // ============ Step 7: 选择"Google 身份验证器" ============
    // 验证方式列表项不是 button，单独处理
    console.log(`[Task ${task.id}] Step 7: 选择 Google 身份验证器...`);
    const authOption = page
      .locator('div[jsname="fmcmS"], li, [role="link"], [role="button"]')
      .filter({ hasText: /(Google 身份验证器|Google Authenticator)/i })
      .first();
    await authOption.waitFor({ state: 'visible', timeout: 15000 });
    await authOption.scrollIntoViewIfNeeded().catch(() => {});
    await authOption.click();
    await page.waitForTimeout(2000);

    // ============ Step 8: 输入 TOTP 验证码 ============
    console.log(`[Task ${task.id}] Step 8: 输入 TOTP 验证码...`);
    const totpCode = generateTOTP(task.totpKey);
    console.log(`[Task ${task.id}] 生成验证码: ${totpCode}`);
    const totpInput = page.locator('input#totpPin, input[name="totpPin"]').first();
    await totpInput.waitFor({ state: 'visible', timeout: 15000 });
    await totpInput.fill(totpCode);
    await page.waitForTimeout(500);

    // ============ Step 9: 点击下一步 ============
    console.log(`[Task ${task.id}] Step 9: 点击下一步（TOTP）...`);
    await clickButtonByText(page, ['下一步', /^Next$/], '下一步（TOTP）');
    await page.waitForTimeout(5000);

    // 验证已跳转到 Google One 页面
    currentUrl = page.url();
    console.log(`[Task ${task.id}] 登录后 URL: ${currentUrl}`);
    if (!currentUrl.includes('one.google.com')) {
      // 可能需要等待重定向
      await page.waitForURL(/one\.google\.com/, { timeout: 20000 });
    }
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    // Google One 页面也可能跟随账号偏好语言走英文，再次确保 hl=zh
    // 否则 Step 10/11/12/13 的中文文案选择器（"开始试用"/"添加卡"/"保存卡"/"订阅"）会全部失配
    await ensureChineseLocale(page, `Task ${task.id} Google One`);
    console.log(`[Task ${task.id}] 已进入 Google One 页面: ${page.url()}`);

    // ============ Step 10: 点击"开始试用" ============
    console.log(`[Task ${task.id}] Step 10: 点击"开始试用"...`);
    const startTrialBtn = page.locator('span[jsname="V67aGc"].UywwFc-vQzf8d:has-text("开始试用")').first();
    await startTrialBtn.waitFor({ state: 'visible', timeout: 20000 });
    await startTrialBtn.click();
    console.log(`[Task ${task.id}] 已点击开始试用，等待弹窗...`);
    await page.waitForTimeout(5000);

    // ============ Step 11: 点击"添加卡"（如果需要） ============
    console.log(`[Task ${task.id}] Step 11: 检查是否需要添加卡...`);
    
    // 先检查是否已经在订阅确认页（账号之前已绑卡的情况）
    // 如果"订阅"按钮已经可见，说明卡已绑定，跳过 Step 11-12
    let alreadyHasCard = false;
    for (const frame of page.frames()) {
      try {
        // 必须精确匹配按钮，避免匹配到"通过 Play 订阅"等非按钮文本
        const subBtn = frame.locator('button.UywwFc-LgbsSe:has(span.UywwFc-vQzf8d:has-text("订阅")), button:has(span[jsname="V67aGc"]:has-text("订阅"))').first();
        if (await subBtn.isVisible().catch(() => false)) {
          alreadyHasCard = true;
          console.log(`[Task ${task.id}] ✅ 检测到"订阅"按钮已可见，账号已有绑定卡，跳过添加卡步骤`);
          break;
        }
      } catch (e) {}
    }
    
    if (!alreadyHasCard) {
    // Google Play 付款弹窗可能在 iframe 中，也可能直接在主框架
    // 需要先检查是否存在 iframe，如果有则切换到 iframe 上下文
    let paymentFrame: any = page;
    
    // 尝试在所有 frame 中查找"添加卡"文本
    const frames = page.frames();
    console.log(`[Task ${task.id}] 页面共有 ${frames.length} 个 frame`);
    
    let foundInFrame = false;
    for (const frame of frames) {
      try {
        const addCardInFrame = frame.locator('span.PjwE0:has-text("添加卡"), span:has-text("添加卡")').first();
        const isVisible = await addCardInFrame.isVisible().catch(() => false);
        if (isVisible) {
          console.log(`[Task ${task.id}] 在 frame "${frame.url()}" 中找到"添加卡"`);
          paymentFrame = frame;
          foundInFrame = true;
          break;
        }
      } catch (e) {
        // 忽略跨域 frame 访问错误
      }
    }
    
    if (!foundInFrame) {
      console.log(`[Task ${task.id}] 未在子 frame 中找到"添加卡"，尝试主框架...`);
      // 可能弹窗还没完全加载，等待更长时间
      await page.waitForTimeout(3000);
      // 再次尝试
      for (const frame of page.frames()) {
        try {
          const addCardInFrame = frame.locator('span.PjwE0:has-text("添加卡"), span:has-text("添加卡")').first();
          const isVisible = await addCardInFrame.isVisible().catch(() => false);
          if (isVisible) {
            console.log(`[Task ${task.id}] 第二次尝试：在 frame "${frame.url()}" 中找到"添加卡"`);
            paymentFrame = frame;
            foundInFrame = true;
            break;
          }
        } catch (e) {}
      }
    }
    
    // 在找到的 frame 中点击"添加卡"
    const addCardBtn = paymentFrame.locator('div.k6TPnc span.PjwE0:has-text("添加卡"), span.PjwE0:has-text("添加卡"), button:has(span.PjwE0:has-text("添加卡")), button.trm7ce:has-text("添加卡")').first();
    // 先等待元素出现在 DOM 中（即使不可见）
    await addCardBtn.waitFor({ state: 'attached', timeout: 15000 });
    // 尝试滚动到可见位置
    await addCardBtn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    // 使用 force click 绕过可见性检查（Google 弹窗有时 overlay 会干扰判定）
    await addCardBtn.click({ force: true });
    console.log(`[Task ${task.id}] 已点击添加卡，等待卡信息表单...`);
    await page.waitForTimeout(4000);

    // ============ Step 12: 填写卡信息 ============
    console.log(`[Task ${task.id}] Step 12: 填写卡信息...`);

    // 重新检测 frame 环境（点击"添加卡"后可能打开了新的 iframe 表单）
    let cardFormFrame: any = paymentFrame;
    await page.waitForTimeout(2000);
    for (const frame of page.frames()) {
      try {
        const cardInput = frame.locator('input.VfPpkd-fmcmS-wGMbrd[inputmode="numeric"][autocomplete="off"]').first();
        if (await cardInput.isVisible().catch(() => false)) {
          cardFormFrame = frame;
          console.log(`[Task ${task.id}] 卡表单在 frame: "${frame.url()}"`);
          break;
        }
      } catch (e) {}
    }

    // (1) 输入卡号 — 第一个 inputmode="numeric" 的 autocomplete="off" 输入框
    const cardNumberInput = cardFormFrame.locator('input.VfPpkd-fmcmS-wGMbrd[inputmode="numeric"][autocomplete="off"]').first();
    await cardNumberInput.waitFor({ state: 'visible', timeout: 15000 });
    await cardNumberInput.click();
    await page.waitForTimeout(500);
    await cardNumberInput.pressSequentially(config.card.number, { delay: 80 });
    console.log(`[Task ${task.id}] 卡号已填入`);
    await page.waitForTimeout(500);

    // (2) 输入有效期（MM/YY）— aria-label 含"失效日期"或"expir"
    const expiryInput = cardFormFrame.locator('input[aria-label*="失效日期"], input[aria-label*="expir"], input[aria-label*="Expir"]').first();
    await expiryInput.waitFor({ state: 'visible', timeout: 10000 });
    await expiryInput.click();
    await page.waitForTimeout(300);
    await expiryInput.pressSequentially(config.card.expiry, { delay: 80 });
    console.log(`[Task ${task.id}] 有效期已填入`);
    await page.waitForTimeout(500);

    // (3) 输入安全码 CVV
    // 安全码 input 没有 aria-label，Name 通过 <label for="iXX"> 关联
    // 策略：用 CSS 选择 label 含"安全码"文本的 input，或者按表单中 input 的顺序取第3个
    let cvvInput = cardFormFrame.locator('label:has-text("安全码") + div input.VfPpkd-fmcmS-wGMbrd, label:has-text("安全码") input.VfPpkd-fmcmS-wGMbrd').first();
    if (!(await cvvInput.isVisible().catch(() => false))) {
      // 尝试 getByLabel（Playwright 会通过 label[for] 关联找到 input）
      cvvInput = cardFormFrame.getByLabel('安全码');
    }
    if (!(await cvvInput.isVisible().catch(() => false))) {
      cvvInput = cardFormFrame.getByLabel(/CVC|CVV|security code/i);
    }
    if (!(await cvvInput.isVisible().catch(() => false))) {
      // 最终兜底：表单中所有 input.VfPpkd-fmcmS-wGMbrd 按顺序，卡号是第1个，有效期第2个，安全码第3个
      cvvInput = cardFormFrame.locator('input.VfPpkd-fmcmS-wGMbrd').nth(2);
    }
    await cvvInput.waitFor({ state: 'visible', timeout: 10000 });
    await cvvInput.click();
    await page.waitForTimeout(300);
    await cvvInput.pressSequentially(config.card.cvv, { delay: 80 });
    console.log(`[Task ${task.id}] CVV已填入`);
    await page.waitForTimeout(500);

    // (4) 输入邮编
    let zipInput = cardFormFrame.locator('input[autocomplete="postal-code"]').first();
    if (!(await zipInput.isVisible().catch(() => false))) {
      zipInput = cardFormFrame.getByLabel(/邮政编码|邮编|postal|zip/i);
    }
    if (!(await zipInput.isVisible().catch(() => false))) {
      zipInput = cardFormFrame.locator('input[inputmode="tel"]').first();
    }
    await zipInput.waitFor({ state: 'visible', timeout: 10000 });
    await zipInput.click();
    await page.waitForTimeout(300);
    await zipInput.fill('');
    await zipInput.pressSequentially(config.card.zip, { delay: 80 });
    console.log(`[Task ${task.id}] 邮编已填入`);
    await page.waitForTimeout(500);

    // (5) 点击"保存卡"
    console.log(`[Task ${task.id}] 点击"保存卡"...`);
    const saveCardBtn = cardFormFrame.locator('span[jsname="V67aGc"]:has-text("保存卡"), span.VfPpkd-vQzf8d:has-text("保存卡")').first();
    await saveCardBtn.waitFor({ state: 'visible', timeout: 10000 });
    await saveCardBtn.click();
    console.log(`[Task ${task.id}] 已点击保存卡`);
    await page.waitForTimeout(5000);
    } // end if (!alreadyHasCard)

    // ============ Step 13: 点击"订阅" ============
    console.log(`[Task ${task.id}] Step 13: 点击"订阅"...`);
    // "订阅"按钮在 Google Play 弹窗中，可能在 iframe 也可能在主框架
    // 关键：必须用精确选择器定位 *按钮*，避免匹配到页面中"通过 Play 订阅"等非按钮文本
    const subscribeBtnSelector = 'button.UywwFc-LgbsSe:has(span.UywwFc-vQzf8d:has-text("订阅"))';
    const subscribeFallbackSelector = 'button:has(span[jsname="V67aGc"]:has-text("订阅"))';
    
    let subscribeBtn: any = null;
    let subscribeFrame: any = null;
    
    // 在所有 frame 中查找订阅按钮
    for (const frame of page.frames()) {
      try {
        // 先试精确选择器
        let btn = frame.locator(subscribeBtnSelector).first();
        if (await btn.count() > 0) {
          subscribeBtn = btn;
          subscribeFrame = frame;
          console.log(`[Task ${task.id}] 在 frame "${frame.url()}" 中找到订阅按钮（精确匹配）`);
          break;
        }
        // 备选选择器
        btn = frame.locator(subscribeFallbackSelector).first();
        if (await btn.count() > 0) {
          subscribeBtn = btn;
          subscribeFrame = frame;
          console.log(`[Task ${task.id}] 在 frame "${frame.url()}" 中找到订阅按钮（备选匹配）`);
          break;
        }
      } catch (e) {}
    }
    
    if (!subscribeBtn) {
      // 最终兜底：在所有 frame 中找任何包含"订阅"文字的 button
      for (const frame of page.frames()) {
        try {
          const btn = frame.locator('button:has-text("订阅")').first();
          if (await btn.count() > 0) {
            subscribeBtn = btn;
            subscribeFrame = frame;
            console.log(`[Task ${task.id}] 在 frame "${frame.url()}" 中找到订阅按钮（兜底匹配）`);
            break;
          }
        } catch (e) {}
      }
    }
    
    if (!subscribeBtn) {
      throw new Error('未找到订阅按钮');
    }
    
    await subscribeBtn.waitFor({ state: 'attached', timeout: 15000 });
    await subscribeBtn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    await subscribeBtn.click({ force: true });
    console.log(`[Task ${task.id}] 已点击订阅`);

    // ============ Step 14: 等待成功 ============
    console.log(`[Task ${task.id}] Step 14: 等待订阅成功...`);
    await page.waitForTimeout(10000);

    // 点击订阅后等待10秒，直接视为成功
    task.status = 'success';
    task.message = '🎉 绑卡成功！Google One AI Premium 已激活。';
    markKeyUsed(task.cardKey);
    logSuccess(task.email, task.offerLink || config.browser.offerUrl);
    if (logId) updateBindStatus(logId, 'success', '绑卡成功');
    console.log(`[Task ${task.id}] ✅ 绑卡成功！`);
  } catch (err: any) {
    console.error(`[Task ${task.id}] ❌ 绑卡失败: ${err.message}`);
    task.status = 'failed';
    task.message = `绑卡失败: ${err.message}`;
    if (logId) updateBindStatus(logId, 'failed', err.message);

    // 截图用于调试
    try {
      await page.screenshot({ path: path.join(DATA_DIR, `error-bind-${task.id}.png`), fullPage: true });
      console.log(`[Task ${task.id}] 错误截图已保存: data/error-bind-${task.id}.png`);
    } catch (_) {}
  } finally {
    // 清除敏感信息
    task.password = '';
    task.totpKey = '';
    await context.close();
    console.log(`[Task ${task.id}] === 绑卡流程结束 ===`);
  }
}

/**
 * 直接绑卡测试入口（跳过 Telegram 认证，用于调试）
 * 不消耗卡密，不影响数据库
 * 通过串行队列执行，同一时间只有一个绑卡任务在运行
 */
export async function startBindCardDirect(
  email: string,
  password: string,
  totpKey: string,
  offerLink?: string
): Promise<{ success: boolean; message: string }> {
  return enqueueBindCard<{ success: boolean; message: string }>(
    () => _startBindCardDirectImpl(email, password, totpKey, offerLink),
    `directBind-${email}`
  );
}

async function _startBindCardDirectImpl(
  email: string,
  password: string,
  totpKey: string,
  offerLink?: string
): Promise<{ success: boolean; message: string }> {
  // 全局超时包装
  return Promise.race([
    _startBindCardDirectCore(email, password, totpKey, offerLink),
    new Promise<{ success: boolean; message: string }>((_, reject) =>
      setTimeout(() => reject(new Error('绑卡流程超时（超过10分钟），已强制中断')), BINDCARD_TIMEOUT_MS)
    ),
  ]).catch((err: any) => {
    console.error(`[DirectBind] ❌ 全局超时: ${err.message}`);
    return { success: false, message: err.message || '绑卡超时' };
  });
}

async function _startBindCardDirectCore(
  email: string,
  password: string,
  totpKey: string,
  offerLink?: string
): Promise<{ success: boolean; message: string }> {
  if (!browser || !browser.isConnected()) {
    console.log('[DirectBind] Browser not available, attempting to relaunch...');
    await initBrowser();
    if (!browser) {
      return { success: false, message: '浏览器启动失败' };
    }
  }

  const taskId = `debug-${Date.now().toString(36)}`;
  console.log(`[DirectBind] === 开始直接绑卡测试 ===`);
  console.log(`[DirectBind] Email: ${email}`);
  console.log(`[DirectBind] Offer: ${offerLink || config.browser.offerUrl}`);

  const context = await browser.newContext({
    userAgent: DESKTOP_USER_AGENT,
    viewport: DESKTOP_VIEWPORT,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  });

  const page = await context.newPage();

  // 注入全面的反检测脚本（在页面加载前执行）
  await page.addInitScript(STEALTH_SCRIPT);

  const result = { success: false, message: '' };

  try {
    const link = offerLink || config.browser.offerUrl;
    if (!link) {
      throw new Error('缺少 offerLink 参数且 .env 中未配置 GOOGLE_OFFER_URL');
    }

    // ============ Step 1: 打开 Google One Pro 链接 ============
    console.log(`[DirectBind] Step 1: 打开 offer 链接...`);
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    let currentUrl = page.url();
    console.log(`[DirectBind] 重定向到: ${currentUrl}`);
    await ensureChineseLocale(page, 'DirectBind 登录页');

    // ============ Step 2: 输入邮箱 ============
    console.log(`[DirectBind] Step 2: 输入邮箱...`);
    const emailInput = page.locator('input#identifierId, input[name="identifier"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(email);
    await page.waitForTimeout(500);

    // ============ Step 3: 点击下一步 ============
    console.log(`[DirectBind] Step 3: 点击下一步（邮箱）...`);
    await clickButtonByText(page, ['下一步', /^Next$/], '下一步（邮箱）');
    await page.waitForTimeout(3000);

    // ============ Step 4: 输入密码 ============
    console.log(`[DirectBind] Step 4: 输入密码...`);
    const passwordInput = page.locator('input[name="Passwd"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
    await passwordInput.fill(password);
    await page.waitForTimeout(500);

    // ============ Step 5: 点击下一步 ============
    console.log(`[DirectBind] Step 5: 点击下一步（密码）...`);
    await clickButtonByText(page, ['下一步', /^Next$/], '下一步（密码）');
    await page.waitForTimeout(5000);

    // ============ Step 6: 点击"试试其他方式" ============
    console.log(`[DirectBind] Step 6: 点击"试试其他方式"...`);
    await clickButtonByText(
      page,
      ['试试其他方式', '尝试其他方式', /Try another way/i],
      '试试其他方式'
    );
    await page.waitForTimeout(2000);

    // ============ Step 7: 选择"Google 身份验证器" ============
    console.log(`[DirectBind] Step 7: 选择 Google 身份验证器...`);
    const authOption = page
      .locator('div[jsname="fmcmS"], li, [role="link"], [role="button"]')
      .filter({ hasText: /(Google 身份验证器|Google Authenticator)/i })
      .first();
    await authOption.waitFor({ state: 'visible', timeout: 15000 });
    await authOption.scrollIntoViewIfNeeded().catch(() => {});
    await authOption.click();
    await page.waitForTimeout(2000);

    // ============ Step 8: 输入 TOTP 验证码 ============
    console.log(`[DirectBind] Step 8: 输入 TOTP 验证码...`);
    const totp = new TOTP({
      secret: totpKey.replace(/\s/g, ''),
      digits: 6,
      period: 30,
      algorithm: 'SHA1',
    });
    const totpCode = totp.generate();
    console.log(`[DirectBind] 生成验证码: ${totpCode}`);

    const totpInput = page.locator('input#totpPin, input[name="totpPin"]').first();
    await totpInput.waitFor({ state: 'visible', timeout: 15000 });
    await totpInput.fill(totpCode);
    await page.waitForTimeout(500);

    // ============ Step 9: 点击下一步 ============
    console.log(`[DirectBind] Step 9: 点击下一步（TOTP）...`);
    await clickButtonByText(page, ['下一步', /^Next$/], '下一步（TOTP）');
    await page.waitForTimeout(5000);

    // 验证已跳转到 Google One 页面
    currentUrl = page.url();
    console.log(`[DirectBind] 登录后 URL: ${currentUrl}`);
    if (!currentUrl.includes('one.google.com')) {
      await page.waitForURL(/one\.google\.com/, { timeout: 20000 });
    }
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    // 同样：one.google.com 也强制 hl=zh，保证后面中文选择器命中
    await ensureChineseLocale(page, 'DirectBind Google One');
    console.log(`[DirectBind] 已进入 Google One 页面: ${page.url()}`);

    // ============ Step 10: 点击"开始试用" ============
    console.log(`[DirectBind] Step 10: 点击"开始试用"...`);
    const startTrialBtn = page.locator('span[jsname="V67aGc"].UywwFc-vQzf8d:has-text("开始试用")').first();
    await startTrialBtn.waitFor({ state: 'visible', timeout: 20000 });
    await startTrialBtn.click();
    console.log(`[DirectBind] 已点击开始试用，等待弹窗...`);
    await page.waitForTimeout(5000);

    // ============ Step 11: 点击"添加卡"（如果需要） ============
    console.log(`[DirectBind] Step 11: 检查是否需要添加卡...`);
    
    // 先检查是否已经在订阅确认页（账号之前已绑卡的情况）
    let alreadyHasCard = false;
    for (const frame of page.frames()) {
      try {
        const subBtn = frame.locator('button.UywwFc-LgbsSe:has(span.UywwFc-vQzf8d:has-text("订阅")), button:has(span[jsname="V67aGc"]:has-text("订阅"))').first();
        if (await subBtn.isVisible().catch(() => false)) {
          alreadyHasCard = true;
          console.log(`[DirectBind] ✅ 检测到"订阅"按钮已可见，账号已有绑定卡，跳过添加卡步骤`);
          break;
        }
      } catch (e) {}
    }
    
    if (!alreadyHasCard) {
    let paymentFrame: any = page;
    
    const frames = page.frames();
    console.log(`[DirectBind] 页面共有 ${frames.length} 个 frame`);
    
    let foundInFrame = false;
    for (const frame of frames) {
      try {
        const addCardInFrame = frame.locator('span.PjwE0:has-text("添加卡"), span:has-text("添加卡")').first();
        const isVisible = await addCardInFrame.isVisible().catch(() => false);
        if (isVisible) {
          console.log(`[DirectBind] 在 frame "${frame.url()}" 中找到"添加卡"`);
          paymentFrame = frame;
          foundInFrame = true;
          break;
        }
      } catch (e) {}
    }
    
    if (!foundInFrame) {
      console.log(`[DirectBind] 未在子 frame 中找到"添加卡"，等待后重试...`);
      await page.waitForTimeout(3000);
      for (const frame of page.frames()) {
        try {
          const addCardInFrame = frame.locator('span.PjwE0:has-text("添加卡"), span:has-text("添加卡")').first();
          const isVisible = await addCardInFrame.isVisible().catch(() => false);
          if (isVisible) {
            console.log(`[DirectBind] 第二次尝试：在 frame "${frame.url()}" 中找到"添加卡"`);
            paymentFrame = frame;
            foundInFrame = true;
            break;
          }
        } catch (e) {}
      }
    }
    
    const addCardBtn = paymentFrame.locator('div.k6TPnc span.PjwE0:has-text("添加卡"), span.PjwE0:has-text("添加卡"), button:has(span.PjwE0:has-text("添加卡")), button.trm7ce:has-text("添加卡")').first();
    await addCardBtn.waitFor({ state: 'attached', timeout: 15000 });
    await addCardBtn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    await addCardBtn.click({ force: true });
    console.log(`[DirectBind] 已点击添加卡，等待卡信息表单...`);
    await page.waitForTimeout(4000);

    // ============ Step 12: 填写卡信息 ============
    console.log(`[DirectBind] Step 12: 填写卡信息...`);

    let cardFormFrame: any = paymentFrame;
    await page.waitForTimeout(2000);
    for (const frame of page.frames()) {
      try {
        const cardInput = frame.locator('input.VfPpkd-fmcmS-wGMbrd[inputmode="numeric"][autocomplete="off"]').first();
        if (await cardInput.isVisible().catch(() => false)) {
          cardFormFrame = frame;
          console.log(`[DirectBind] 卡表单在 frame: "${frame.url()}"`);
          break;
        }
      } catch (e) {}
    }

    // (1) 输入卡号
    const cardNumberInput = cardFormFrame.locator('input.VfPpkd-fmcmS-wGMbrd[inputmode="numeric"][autocomplete="off"]').first();
    await cardNumberInput.waitFor({ state: 'visible', timeout: 15000 });
    await cardNumberInput.click();
    await page.waitForTimeout(500);
    await cardNumberInput.pressSequentially(config.card.number, { delay: 80 });
    console.log(`[DirectBind] 卡号已填入`);
    await page.waitForTimeout(500);

    // (2) 输入有效期（MM/YY）
    const expiryInput = cardFormFrame.locator('input[aria-label*="失效日期"], input[aria-label*="expir"], input[aria-label*="Expir"]').first();
    await expiryInput.waitFor({ state: 'visible', timeout: 10000 });
    await expiryInput.click();
    await page.waitForTimeout(300);
    await expiryInput.pressSequentially(config.card.expiry, { delay: 80 });
    console.log(`[DirectBind] 有效期已填入`);
    await page.waitForTimeout(500);

    // (3) 输入安全码 CVV
    let cvvInput = cardFormFrame.locator('label:has-text("安全码") + div input.VfPpkd-fmcmS-wGMbrd, label:has-text("安全码") input.VfPpkd-fmcmS-wGMbrd').first();
    if (!(await cvvInput.isVisible().catch(() => false))) {
      cvvInput = cardFormFrame.getByLabel('安全码');
    }
    if (!(await cvvInput.isVisible().catch(() => false))) {
      cvvInput = cardFormFrame.getByLabel(/CVC|CVV|security code/i);
    }
    if (!(await cvvInput.isVisible().catch(() => false))) {
      cvvInput = cardFormFrame.locator('input.VfPpkd-fmcmS-wGMbrd').nth(2);
    }
    await cvvInput.waitFor({ state: 'visible', timeout: 10000 });
    await cvvInput.click();
    await page.waitForTimeout(300);
    await cvvInput.pressSequentially(config.card.cvv, { delay: 80 });
    console.log(`[DirectBind] CVV已填入`);
    await page.waitForTimeout(500);

    // (4) 输入邮编
    let zipInput = cardFormFrame.locator('input[autocomplete="postal-code"]').first();
    if (!(await zipInput.isVisible().catch(() => false))) {
      zipInput = cardFormFrame.getByLabel(/邮政编码|邮编|postal|zip/i);
    }
    if (!(await zipInput.isVisible().catch(() => false))) {
      zipInput = cardFormFrame.locator('input[inputmode="tel"]').first();
    }
    await zipInput.waitFor({ state: 'visible', timeout: 10000 });
    await zipInput.click();
    await page.waitForTimeout(300);
    await zipInput.fill('');
    await zipInput.pressSequentially(config.card.zip, { delay: 80 });
    console.log(`[DirectBind] 邮编已填入`);
    await page.waitForTimeout(500);

    // (5) 点击"保存卡"
    console.log(`[DirectBind] 点击"保存卡"...`);
    const saveCardBtn = cardFormFrame.locator('span[jsname="V67aGc"]:has-text("保存卡"), span.VfPpkd-vQzf8d:has-text("保存卡")').first();
    await saveCardBtn.waitFor({ state: 'visible', timeout: 10000 });
    await saveCardBtn.click();
    console.log(`[DirectBind] 已点击保存卡`);
    await page.waitForTimeout(5000);
    } // end if (!alreadyHasCard)

    // ============ Step 13: 点击"订阅" ============
    console.log(`[DirectBind] Step 13: 点击"订阅"...`);
    const subscribeBtnSelector = 'button.UywwFc-LgbsSe:has(span.UywwFc-vQzf8d:has-text("订阅"))';
    const subscribeFallbackSelector = 'button:has(span[jsname="V67aGc"]:has-text("订阅"))';
    
    let subscribeBtn: any = null;
    let subscribeFrame: any = null;
    
    for (const frame of page.frames()) {
      try {
        let btn = frame.locator(subscribeBtnSelector).first();
        if (await btn.count() > 0) {
          subscribeBtn = btn;
          subscribeFrame = frame;
          console.log(`[DirectBind] 在 frame "${frame.url()}" 中找到订阅按钮（精确匹配）`);
          break;
        }
        btn = frame.locator(subscribeFallbackSelector).first();
        if (await btn.count() > 0) {
          subscribeBtn = btn;
          subscribeFrame = frame;
          console.log(`[DirectBind] 在 frame "${frame.url()}" 中找到订阅按钮（备选匹配）`);
          break;
        }
      } catch (e) {}
    }
    
    if (!subscribeBtn) {
      for (const frame of page.frames()) {
        try {
          const btn = frame.locator('button:has-text("订阅")').first();
          if (await btn.count() > 0) {
            subscribeBtn = btn;
            subscribeFrame = frame;
            console.log(`[DirectBind] 在 frame "${frame.url()}" 中找到订阅按钮（兜底匹配）`);
            break;
          }
        } catch (e) {}
      }
    }
    
    if (!subscribeBtn) {
      throw new Error('未找到订阅按钮');
    }
    
    await subscribeBtn.waitFor({ state: 'attached', timeout: 15000 });
    await subscribeBtn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    await subscribeBtn.click({ force: true });
    console.log(`[DirectBind] 已点击订阅`);

    // ============ Step 14: 等待成功 ============
    console.log(`[DirectBind] Step 14: 等待订阅成功...`);
    await page.waitForTimeout(10000);

    // 点击订阅后等待10秒，直接视为成功
    result.success = true;
    result.message = '🎉 绑卡成功！Google One AI Premium 已激活。';
    console.log(`[DirectBind] ✅ 绑卡成功！`);
  } catch (err: any) {
    console.error(`[DirectBind] ❌ 绑卡失败: ${err.message}`);
    result.message = `绑卡失败: ${err.message}`;
    try {
      await page.screenshot({ path: path.join(DATA_DIR, `direct-bind-error-${taskId}.png`), fullPage: true });
      console.log(`[DirectBind] 错误截图已保存: data/direct-bind-error-${taskId}.png`);
    } catch (_) {}
  } finally {
    await context.close();
    console.log(`[DirectBind] === 直接绑卡测试结束 ===`);
  }

  return result;
}
