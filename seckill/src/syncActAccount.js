/**
 * 批量同步 accounts.act_account（来源：actInfo.actAccount）
 *
 * 用法：
 *   npm run sync:act              # 只补空
 *   npm run sync:act -- --force   # 全部重拉
 *   npm run sync:act -- 13800138000
 */
const path = require('path');
const fs = require('fs');

const localEnv = path.resolve(__dirname, '../.env');
if (fs.existsSync(localEnv)) require('dotenv').config({ path: localEnv });

const accountRepo = require('./accountRepo');
const {
  createClientFromUser,
  ensureXsrf,
  ensureSession,
  cookieExchange,
  fetchActAccount,
  sleep,
} = require('./client');

function parseArgs(argv) {
  const force = argv.includes('--force') || argv.includes('-f');
  const mobile = argv.find((a) => /^1\d{10}$/.test(a)) || null;
  return { force, mobile };
}

async function syncOne(user) {
  const { client, jar } = createClientFromUser(user);
  await ensureXsrf(client, jar);
  await ensureSession(client).catch(() => null);
  await cookieExchange(client).catch(() => null);
  await ensureXsrf(client, jar);
  const actAccount = await fetchActAccount(client);
  if (!actAccount) {
    return { ok: false, reason: 'actInfo 未返回 actAccount（会话可能失效）' };
  }
  await accountRepo.updateActAccount(user.mobile, actAccount);
  return { ok: true, actAccount };
}

async function main() {
  const { force, mobile } = parseArgs(process.argv.slice(2));
  await accountRepo.ensureAccountColumns();

  let list;
  if (mobile) {
    const one = await accountRepo.findByMobile(mobile);
    if (!one) {
      console.error(`[sync:act] 账号不存在: ${mobile}`);
      process.exit(1);
    }
    list = [one];
  } else {
    list = await accountRepo.listAllAccounts();
  }

  const targets = force
    ? list
    : list.filter((u) => !u.actAccount || !String(u.actAccount).trim());

  console.log(
    `[sync:act] 共 ${list.length} 个账号，待同步 ${targets.length}${
      force ? '（--force 全量）' : '（仅空值）'
    }`
  );

  let ok = 0;
  let fail = 0;
  let skip = 0;

  if (!targets.length) {
    console.log('[sync:act] 无需同步');
    process.exit(0);
  }

  for (let i = 0; i < targets.length; i++) {
    const user = targets[i];
    const tag = `[${i + 1}/${targets.length}] ${user.mobile}`;
    try {
      const r = await syncOne(user);
      if (r.ok) {
        ok += 1;
        console.log(`${tag} → ${r.actAccount}`);
      } else {
        fail += 1;
        console.warn(`${tag} 失败: ${r.reason}`);
      }
    } catch (e) {
      fail += 1;
      console.warn(`${tag} 异常: ${e.message || e}`);
    }
    if (i < targets.length - 1) await sleep(200);
  }

  skip = list.length - targets.length;
  console.log(`[sync:act] 完成：成功 ${ok}，失败 ${fail}，跳过 ${skip}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('[sync:act]', e);
  process.exit(1);
});
