/**
 * 本地调试脚本：直接从绑卡流程开始测试
 *
 * 用途：跳过 Telegram 认证环节，直接用已知的 Google 账号 + offer 链接
 * 走一遍 Playwright 自动绑卡流程，便于调试选择器、定位失败步骤。
 *
 * 特点：
 *   - 不启动 Express，不连 Telegram，不写数据库
 *   - 不消耗卡密
 *   - 默认强制有头浏览器（BROWSER_HEADLESS=false）
 *   - 失败/异常自动截图到 data/ 目录
 *
 * 用法：
 *   npm run test:bindcard -- --email=xxx@gmail.com --password=xxx --totp="xxx xxx xxx xxx" [--offer=https://...]
 *
 * 也可以从环境变量读：
 *   TEST_EMAIL / TEST_PASSWORD / TEST_TOTP / TEST_OFFER
 */

// 默认强制有头浏览器，方便观察。允许通过 BROWSER_HEADLESS=true 显式覆盖。
if (!process.env.BROWSER_HEADLESS) {
  process.env.BROWSER_HEADLESS = 'false';
}

import { initBrowser, closeBrowser, startBindCardDirect } from '../src/browserWorker';
import { config } from '../src/config';

interface Args {
  email?: string;
  password?: string;
  totp?: string;
  offer?: string;
}

function parseArgs(): Args {
  const args: Args = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) {
      const key = m[1] as keyof Args;
      args[key] = m[2];
    }
  }
  return args;
}

async function main() {
  const args = parseArgs();

  const email = args.email || process.env.TEST_EMAIL || '';
  const password = args.password || process.env.TEST_PASSWORD || '';
  const totp = args.totp || process.env.TEST_TOTP || '';
  const offer = args.offer || process.env.TEST_OFFER || config.browser.offerUrl;

  if (!email || !password || !totp) {
    console.error('\n❌ 缺少必需参数。请通过命令行参数或环境变量提供：');
    console.error('   --email=xxx@gmail.com');
    console.error('   --password=xxx');
    console.error('   --totp="32位TOTP密钥"');
    console.error('   --offer=https://...   （可选，默认用 GOOGLE_OFFER_URL）\n');
    console.error('示例：');
    console.error('   npm run test:bindcard -- --email=demo@gmail.com --password=xxx --totp="abcd efgh ijkl mnop qrst uvwx yzab cdef"\n');
    process.exit(1);
  }

  // 校验信用卡信息（绑卡必需）
  if (!config.card.number || !config.card.expiry || !config.card.cvv || !config.card.name) {
    console.error('\n❌ .env 中缺少信用卡配置（CARD_NUMBER / CARD_EXPIRY / CARD_CVV / CARD_NAME）。\n');
    process.exit(1);
  }

  console.log('========================================');
  console.log('🔧 本地绑卡调试脚本');
  console.log('========================================');
  console.log(`  Email      : ${email}`);
  console.log(`  Password   : ${'*'.repeat(password.length)}`);
  console.log(`  TOTP       : ${totp.replace(/\S/g, '*')}`);
  console.log(`  Offer Link : ${offer}`);
  console.log(`  Headless   : ${config.browser.headless}`);
  console.log(`  CARD       : ${config.card.number.slice(0, 4)}**** / ${config.card.expiry} / *** / ${config.card.name}`);
  console.log('========================================\n');

  // 启动浏览器
  await initBrowser();

  try {
    const result = await startBindCardDirect(email, password, totp, offer);
    console.log('\n========================================');
    if (result.success) {
      console.log('✅ 测试成功：', result.message);
    } else {
      console.log('⚠️  测试未通过：', result.message);
      console.log('   → 检查 data/ 目录下的截图');
    }
    console.log('========================================\n');
    process.exitCode = result.success ? 0 : 1;
  } catch (err: any) {
    console.error('\n❌ 测试脚本异常：', err.message);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
