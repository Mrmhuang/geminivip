import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { TOTP } from 'otpauth';
import { Task } from './taskQueue';
import { config } from './config';
import { logSuccess, markKeyUsed, updateTelegramStatus, updateBindStatus, findSubmitLogByEmail } from './database';
import path from 'path';
import fs from 'fs';

let browser: Browser | null = null;

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 统一的 PC 桌面端浏览器画布配置（有头/无头共用）
// 避免移动端 viewport 导致 Google 页面走移动版布局，DOM 结构与选择器都会不同
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 初始化浏览器实例
 */
export async function initBrowser(): Promise<void> {
  try {
    browser = await chromium.launch({
      headless: config.browser.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        // 有头模式下，让浏览器窗口尺寸与 viewport 对齐，避免页面以移动端布局渲染
        `--window-size=${DESKTOP_VIEWPORT.width},${DESKTOP_VIEWPORT.height}`,
      ],
    });
    console.log(
      `[Browser] Chromium launched successfully (headless: ${config.browser.headless}, viewport: ${DESKTOP_VIEWPORT.width}x${DESKTOP_VIEWPORT.height})`
    );
  } catch (err: any) {
    console.error(`[Browser] Failed to launch: ${err.message}`);
    console.error('[Browser] Bind card feature will be unavailable.');
  }
}

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
 * 独立于 Telegram 队列，异步执行
 */
export async function startBindCard(task: Task): Promise<void> {
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
  });

  const page = await context.newPage();

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

    // ============ Step 11: 点击"添加卡" ============
    console.log(`[Task ${task.id}] Step 11: 点击"添加卡"...`);
    const addCardBtn = page.locator('span.PjwE0:has-text("添加卡")').first();
    await addCardBtn.waitFor({ state: 'visible', timeout: 15000 });
    await addCardBtn.click();
    console.log(`[Task ${task.id}] 已点击添加卡，等待卡信息表单...`);
    await page.waitForTimeout(3000);

    // ============ Step 12: 填写卡信息 ============
    console.log(`[Task ${task.id}] Step 12: 填写卡信息...`);

    // (1) 输入卡号 — 优先用 aria-labelledby 或 inputmode=numeric 结合位置
    const cardNumberInput = page.locator('input#i5, input[aria-labelledby="i4"], input[inputmode="numeric"][autocomplete="off"]').first();
    await cardNumberInput.waitFor({ state: 'visible', timeout: 10000 });
    await cardNumberInput.click();
    await page.waitForTimeout(300);
    await cardNumberInput.fill(config.card.number);
    console.log(`[Task ${task.id}] 卡号已填入`);
    await page.waitForTimeout(500);

    // (2) 输入有效期（MM/YY）
    const expiryInput = page.locator('input#i10, input[aria-label*="失效日期"], input[aria-label*="expir"]').first();
    await expiryInput.waitFor({ state: 'visible', timeout: 10000 });
    await expiryInput.click();
    await page.waitForTimeout(300);
    await expiryInput.fill(config.card.expiry);
    console.log(`[Task ${task.id}] 有效期已填入`);
    await page.waitForTimeout(500);

    // (3) 输入安全码 CVV
    const cvvInput = page.locator('input#c21, input[aria-labelledby][inputmode="numeric"]:not([id="i5"]):not([id="i10"])').first();
    await cvvInput.waitFor({ state: 'visible', timeout: 10000 });
    await cvvInput.click();
    await page.waitForTimeout(300);
    await cvvInput.fill(config.card.cvv);
    console.log(`[Task ${task.id}] CVV已填入`);
    await page.waitForTimeout(500);

    // (4) 输入姓名
    const nameInput = page.locator('input#c37, input[role="combobox"][data-axe="mdc-autocomplete"][autocomplete="off"]:not([inputmode="tel"])').first();
    await nameInput.waitFor({ state: 'visible', timeout: 10000 });
    await nameInput.click();
    await page.waitForTimeout(300);
    // 清空可能存在的默认值再填入
    await nameInput.fill('');
    await nameInput.fill(config.card.name);
    console.log(`[Task ${task.id}] 姓名已填入`);
    await page.waitForTimeout(500);

    // (5) 输入邮编
    const zipInput = page.locator('input#c43, input[role="combobox"][inputmode="tel"]').first();
    await zipInput.waitFor({ state: 'visible', timeout: 10000 });
    await zipInput.click();
    await page.waitForTimeout(300);
    await zipInput.fill('');
    await zipInput.fill(config.card.zip);
    console.log(`[Task ${task.id}] 邮编已填入`);
    await page.waitForTimeout(500);

    // (6) 点击"保存卡"
    console.log(`[Task ${task.id}] 点击"保存卡"...`);
    const saveCardBtn = page.locator('span[jsname="V67aGc"]:has-text("保存卡")').first();
    await saveCardBtn.waitFor({ state: 'visible', timeout: 10000 });
    await saveCardBtn.click();
    console.log(`[Task ${task.id}] 已点击保存卡`);
    await page.waitForTimeout(5000);

    // ============ Step 13: 点击"订阅" ============
    console.log(`[Task ${task.id}] Step 13: 点击"订阅"...`);
    const subscribeBtn = page.locator('span[jsname="V67aGc"].UywwFc-vQzf8d:has-text("订阅")').first();
    await subscribeBtn.waitFor({ state: 'visible', timeout: 15000 });
    await subscribeBtn.click();
    console.log(`[Task ${task.id}] 已点击订阅`);

    // ============ Step 14: 等待成功 ============
    console.log(`[Task ${task.id}] Step 14: 等待订阅成功...`);
    await page.waitForTimeout(10000);

    // 检查页面是否出现"成功"二字
    const pageContent = await page.content();
    const hasSuccess = pageContent.includes('成功');

    if (hasSuccess) {
      task.status = 'success';
      task.message = '🎉 绑卡成功！Google One AI Premium 已激活。';
      markKeyUsed(task.cardKey);
      logSuccess(task.email, task.offerLink || config.browser.offerUrl);
      if (logId) updateBindStatus(logId, 'success', '绑卡成功');
      console.log(`[Task ${task.id}] ✅ 绑卡成功！`);
    } else {
      // 再尝试截图看看当前状态
      try {
        await page.screenshot({ path: path.join(DATA_DIR, `bindcard-result-${task.id}.png`), fullPage: true });
      } catch (_) {}
      task.status = 'failed';
      task.message = '绑卡流程完成但未检测到"成功"字样，请手动检查。';
      if (logId) updateBindStatus(logId, 'failed', '未检测到成功字样');
      console.log(`[Task ${task.id}] ⚠️ 未检测到成功标识`);
    }
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
 */
export async function startBindCardDirect(
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
  });

  const page = await context.newPage();
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

    // ============ Step 11: 点击"添加卡" ============
    console.log(`[DirectBind] Step 11: 点击"添加卡"...`);
    const addCardBtn = page.locator('span.PjwE0:has-text("添加卡")').first();
    await addCardBtn.waitFor({ state: 'visible', timeout: 15000 });
    await addCardBtn.click();
    console.log(`[DirectBind] 已点击添加卡，等待卡信息表单...`);
    await page.waitForTimeout(3000);

    // ============ Step 12: 填写卡信息 ============
    console.log(`[DirectBind] Step 12: 填写卡信息...`);

    const cardNumberInput = page.locator('input#i5, input[aria-labelledby="i4"], input[inputmode="numeric"][autocomplete="off"]').first();
    await cardNumberInput.waitFor({ state: 'visible', timeout: 10000 });
    await cardNumberInput.click();
    await page.waitForTimeout(300);
    await cardNumberInput.fill(config.card.number);
    console.log(`[DirectBind] 卡号已填入`);
    await page.waitForTimeout(500);

    const expiryInput = page.locator('input#i10, input[aria-label*="失效日期"], input[aria-label*="expir"]').first();
    await expiryInput.waitFor({ state: 'visible', timeout: 10000 });
    await expiryInput.click();
    await page.waitForTimeout(300);
    await expiryInput.fill(config.card.expiry);
    console.log(`[DirectBind] 有效期已填入`);
    await page.waitForTimeout(500);

    const cvvInput = page.locator('input#c21, input[aria-labelledby][inputmode="numeric"]:not([id="i5"]):not([id="i10"])').first();
    await cvvInput.waitFor({ state: 'visible', timeout: 10000 });
    await cvvInput.click();
    await page.waitForTimeout(300);
    await cvvInput.fill(config.card.cvv);
    console.log(`[DirectBind] CVV已填入`);
    await page.waitForTimeout(500);

    const nameInput = page.locator('input#c37, input[role="combobox"][data-axe="mdc-autocomplete"][autocomplete="off"]:not([inputmode="tel"])').first();
    await nameInput.waitFor({ state: 'visible', timeout: 10000 });
    await nameInput.click();
    await page.waitForTimeout(300);
    await nameInput.fill('');
    await nameInput.fill(config.card.name);
    console.log(`[DirectBind] 姓名已填入`);
    await page.waitForTimeout(500);

    const zipInput = page.locator('input#c43, input[role="combobox"][inputmode="tel"]').first();
    await zipInput.waitFor({ state: 'visible', timeout: 10000 });
    await zipInput.click();
    await page.waitForTimeout(300);
    await zipInput.fill('');
    await zipInput.fill(config.card.zip);
    console.log(`[DirectBind] 邮编已填入`);
    await page.waitForTimeout(500);

    // (6) 点击"保存卡"
    console.log(`[DirectBind] 点击"保存卡"...`);
    const saveCardBtn = page.locator('span[jsname="V67aGc"]:has-text("保存卡")').first();
    await saveCardBtn.waitFor({ state: 'visible', timeout: 10000 });
    await saveCardBtn.click();
    console.log(`[DirectBind] 已点击保存卡`);
    await page.waitForTimeout(5000);

    // ============ Step 13: 点击"订阅" ============
    console.log(`[DirectBind] Step 13: 点击"订阅"...`);
    const subscribeBtn = page.locator('span[jsname="V67aGc"].UywwFc-vQzf8d:has-text("订阅")').first();
    await subscribeBtn.waitFor({ state: 'visible', timeout: 15000 });
    await subscribeBtn.click();
    console.log(`[DirectBind] 已点击订阅`);

    // ============ Step 14: 等待成功 ============
    console.log(`[DirectBind] Step 14: 等待订阅成功...`);
    await page.waitForTimeout(10000);

    const pageContent = await page.content();
    const hasSuccess = pageContent.includes('成功');

    if (hasSuccess) {
      result.success = true;
      result.message = '🎉 绑卡成功！Google One AI Premium 已激活。';
      console.log(`[DirectBind] ✅ 绑卡成功！`);
    } else {
      try {
        await page.screenshot({ path: path.join(DATA_DIR, `direct-bind-result-${taskId}.png`), fullPage: true });
      } catch (_) {}
      result.success = false;
      result.message = '绑卡流程完成但未检测到"成功"字样，请手动检查。截图已保存到 data/ 目录。';
      console.log(`[DirectBind] ⚠️ 未检测到成功标识`);
    }
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
