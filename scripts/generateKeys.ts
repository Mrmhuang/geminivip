import { generateKey } from '../src/cardKey';
import { config } from '../src/config';

const count = parseInt(process.argv[2] || '5', 10);

if (!config.cardSecret) {
  console.error('Error: CARD_SECRET not set in .env');
  process.exit(1);
}

console.log(`\n生成 ${count} 个卡密:\n`);
for (let i = 0; i < count; i++) {
  console.log(generateKey(config.cardSecret));
}
console.log('\n');
