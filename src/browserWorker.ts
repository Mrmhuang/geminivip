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
      ],
    });
    console.log(`[Browser] Chromium launched successfully (headless: ${config.browser.headless})`);
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
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
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

    // 检查登录页 URL 是否包含 hl=zh
    let currentUrl = page.url();
    console.log(`[Task ${task.id}] 重定向到: ${currentUrl}`);

    if (currentUrl.includes('accounts.google.com')) {
      // 确保 hl=zh 参数存在
      const url = new URL(currentUrl);
      const hl = url.searchParams.get('hl');
      if (hl !== 'zh') {
        url.searchParams.set('hl', 'zh');
        console.log(`[Task ${task.id}] 添加 hl=zh 参数，刷新页面...`);
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
      }
    }

    // ============ Step 2: 输入邮箱 ============
    console.log(`[Task ${task.id}] Step 2: 输入邮箱...`);
    const emailInput = page.locator('input#identifierId, input[name="identifier"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(task.email);
    await page.waitForTimeout(500);

    // ============ Step 3: 点击下一步 ============
    console.log(`[Task ${task.id}] Step 3: 点击下一步（邮箱）...`);
    await page.locator('span[jsname="V67aGc"]:has-text("下一步")').first().click();
    await page.waitForTimeout(3000);

    // ============ Step 4: 输入密码 ============
    console.log(`[Task ${task.id}] Step 4: 输入密码...`);
    const passwordInput = page.locator('input[name="Passwd"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
    await passwordInput.fill(task.password);
    await page.waitForTimeout(500);

    // ============ Step 5: 点击下一步 ============
    console.log(`[Task ${task.id}] Step 5: 点击下一步（密码）...`);
    await page.locator('span[jsname="V67aGc"]:has-text("下一步")').first().click();
    await page.waitForTimeout(3000);

    // ============ Step 6: 点击"试试其他方式" ============
    console.log(`[Task ${task.id}] Step 6: 点击"试试其他方式"...`);
    const tryOtherWay = page.locator('span[jsname="V67aGc"]:has-text("试试其他方式")').first();
    await tryOtherWay.waitFor({ state: 'visible', timeout: 15000 });
    await tryOtherWay.click();
    await page.waitForTimeout(2000);

    // ============ Step 7: 选择"Google 身份验证器" ============
    console.log(`[Task ${task.id}] Step 7: 选择 Google 身份验证器...`);
    const authOption = page.locator('div[jsname="fmcmS"]:has-text("Google 身份验证器")').first();
    await authOption.waitFor({ state: 'visible', timeout: 15000 });
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
    await page.locator('span[jsname="V67aGc"]:has-text("下一步")').first().click();
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
