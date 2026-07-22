const path = require('path');
const fs = require('fs');

const localEnv = path.resolve(__dirname, '../.env');
if (fs.existsSync(localEnv)) require('dotenv').config({ path: localEnv });

const accountRepo = require('./accountRepo');
const { createClientFromUser, ensureXsrf, fetchShowingList, normalizeLevel } = require('./client');

async function main() {
  const mobile = process.argv[2] || '15310840704';
  const user = await accountRepo.findByMobile(mobile);
  if (!user) throw new Error('no user in MySQL');
  const { client, jar } = createClientFromUser(user);
  await ensureXsrf(client, jar);
  const listResp = await fetchShowingList(client);
  const out = path.resolve(__dirname, '../_list_dump.json');
  fs.writeFileSync(out, JSON.stringify(listResp, null, 2), 'utf8');
  console.log('saved', out);
  const result = listResp.result || listResp.data || listResp;
  const coupons = result.coupons || result.list || [];
  console.log('couponCount', coupons.length);
  if (coupons[0]) {
    console.log('coupon keys', Object.keys(coupons[0]));
    console.log('sample coupon', JSON.stringify(coupons[0], null, 2).slice(0, 2000));
  }
  // find V1
  const level = normalizeLevel(user.vipLevel);
  for (const c of coupons) {
    const lv = c.xyLevel || c.vipLevel || c.level;
    if (String(lv).toUpperCase() === level || String(lv) === level) {
      console.log('V1 coupon keys', Object.keys(c));
      console.log('periods0', c.periods && c.periods[0] ? Object.keys(c.periods[0]) : null);
      console.log('sample', JSON.stringify(c, null, 2).slice(0, 2500));
      break;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
