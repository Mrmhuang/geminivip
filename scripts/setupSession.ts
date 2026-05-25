import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import input from 'input';
import { config } from '../src/config';

async function main() {
  console.log('=== Telegram Session Setup ===\n');

  if (!config.telegram.apiId || !config.telegram.apiHash) {
    console.error('请先在 .env 中配置 TELEGRAM_API_ID 和 TELEGRAM_API_HASH');
    console.error('获取地址: https://my.telegram.org');
    process.exit(1);
  }

  const session = new StringSession('');
  const client = new TelegramClient(session, config.telegram.apiId, config.telegram.apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('请输入手机号 (含国际区号, 如 +86xxx): '),
    password: async () => await input.text('请输入两步验证密码 (如果有): '),
    phoneCode: async () => await input.text('请输入收到的验证码: '),
    onError: (err) => console.error('Error:', err),
  });

  const sessionString = client.session.save() as unknown as string;
  console.log('\n=== 登录成功! ===\n');
  console.log('请将以下 session 字符串复制到 .env 文件中的 TELEGRAM_SESSION:\n');
  console.log(sessionString);
  console.log('\n');

  await client.disconnect();
}

main().catch(console.error);
