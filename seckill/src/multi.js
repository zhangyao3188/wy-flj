const fs = require('fs');
const path = require('path');

const localEnv = path.resolve(__dirname, '../.env');
if (fs.existsSync(localEnv)) require('dotenv').config({ path: localEnv });

const accountRepo = require('./accountRepo');
const { ensureXsrf, waitUntil } = require('./client');
const {
  prepareAccount,
  warmupSession,
  fireLoop,
  formatLeft,
  FIRE_EARLY_MS,
  WARMUP_BEFORE_MS,
} = require('./runner');

/**
 * 仅从线上 MySQL accounts 加载账号
 */
async function loadAccountsFromDb(mobilesFilter) {
  let users;
  if (mobilesFilter && mobilesFilter.length) {
    users = [];
    for (const mobile of mobilesFilter) {
      const u = await accountRepo.findByMobile(mobile);
      if (u && u.status !== 0) users.push(u);
      else console.warn(`[dev] 数据库无此可用账号: ${mobile}`);
    }
  } else {
    users = await accountRepo.listActiveAccounts();
  }
  if (!users.length) {
    throw new Error('线上数据库无可用账号，请先通过 login 在线登录');
  }
  return users;
}

async function runMulti(options = {}) {
  const immediate = !!options.immediate;
  const fireEarlyMs = options.fireEarlyMs != null ? options.fireEarlyMs : FIRE_EARLY_MS;
  const warmupBeforeMs =
    options.warmupBeforeMs != null ? options.warmupBeforeMs : WARMUP_BEFORE_MS;

  const users = await loadAccountsFromDb(options.mobiles);
  const mobiles = users.map((u) => u.mobile);

  console.log('');
  console.log('==============================');
  console.log('   多账号并行抢购（线上数据库）');
  console.log('==============================');
  console.log(`[dev] 账号数=${mobiles.length}${immediate ? ' [测试立即抢]' : ''}`);
  console.log(`[dev] 账号: ${mobiles.join(', ')}`);
  console.log(`[dev] 启动预热 + 开抢前 ${warmupBeforeMs / 1000}s 再预热；成功即停该账号`);
  console.log('');

  const prepared = [];
  const failed = [];
  const prepareResults = await Promise.all(
    users.map(async (user) => {
      try {
        const account = await prepareAccount(user.mobile, { ...options, user });
        return { ok: true, account };
      } catch (e) {
        return { ok: false, mobile: user.mobile, error: e.message || String(e) };
      }
    })
  );

  for (const r of prepareResults) {
    if (r.ok) prepared.push(r.account);
    else failed.push({ mobile: r.mobile, error: r.error });
  }

  for (const f of failed) {
    console.error(`[dev] 启动预热失败 ${f.mobile}: ${f.error}`);
  }
  if (!prepared.length) {
    throw new Error('全部账号预热失败，无法开抢');
  }

  console.log('');
  console.log(`[dev] 启动预热成功 ${prepared.length}/${mobiles.length}`);
  for (const a of prepared) {
    const startAt = new Date(a.ready.seckillStartTime).toLocaleString('zh-CN', {
      hour12: false,
    });
    console.log(
      `[dev] ✓ ${a.mobile} ${a.nickname || ''} ${a.vipLevel} couponId=${a.ready.couponId} stockId=${a.ready.stockId}${a.ready._inferredStock ? '(推导)' : ''} start=${startAt}${a.alreadyAcquired ? ' [已领取]' : ''}`
    );
    if (a.logFile) console.log(`[dev]   日志: ${a.logFile}`);
  }
  console.log('');

  if (!immediate) {
    const earliestStart = Math.min(...prepared.map((a) => a.ready.seckillStartTime));
    const warmAt = earliestStart - warmupBeforeMs;
    const wakeAt = earliestStart - fireEarlyMs;

    if (Date.now() < warmAt) {
      console.log(
        `[dev] 等待开抢前 ${warmupBeforeMs / 1000}s 二次预热（约 ${formatLeft(warmAt - Date.now())} 后）`
      );
      let lastLog = 0;
      await waitUntil(warmAt, {
        onTick: () => {
          const now = Date.now();
          if (now - lastLog > 10000) {
            lastLog = now;
            console.log(`[dev] 等待中，距二次预热 ${formatLeft(warmAt - Date.now())}`);
          }
        },
      });
    }

    // 开抢前 30s：全员再预热一遍（过期则更新 cookie）
    if (Date.now() < wakeAt + 5000) {
      console.log(`[dev] >>> 开抢前预热（${prepared.length} 账号）`);
      const warmResults = await Promise.all(
        prepared.map(async (account) => {
          try {
            await warmupSession(account, { label: '开抢前预热' });
            return { mobile: account.mobile, ok: true };
          } catch (e) {
            console.error(`[dev] 开抢前预热失败 ${account.mobile}: ${e.message || e}`);
            account._warmupFailed = true;
            return { mobile: account.mobile, ok: false, error: e.message || String(e) };
          }
        })
      );
      const warmOk = warmResults.filter((r) => r.ok).length;
      console.log(`[dev] 开抢前预热完成 ${warmOk}/${prepared.length}`);
    }

    if (Date.now() < wakeAt) {
      console.log(
        `[dev] 二次预热完成，最早开火约 ${formatLeft(wakeAt - Date.now())} 后（开抢前 ${fireEarlyMs}ms）`
      );
      let lastLog = 0;
      await waitUntil(wakeAt, {
        onTick: () => {
          const now = Date.now();
          if (now - lastLog > 10000) {
            lastLog = now;
            console.log(`[dev] 预备中，距最早开火 ${formatLeft(wakeAt - Date.now())}`);
          }
        },
      });
    }
  } else {
    console.log('[dev] 测试模式：启动预热完成，立即并行开火');
  }

  const toFire = prepared.filter((a) => !a.alreadyAcquired && !a._warmupFailed);
  const skipped = prepared.filter((a) => a.alreadyAcquired || a._warmupFailed);
  for (const a of skipped) {
    console.log(
      `[dev] 跳过 ${a.mobile}: ${a.alreadyAcquired ? '本场已领取' : '开抢前预热失败'}`
    );
  }

  console.log(`[dev] >>> 开始并行抢购（${toFire.length}），成功即停该账号`);

  const results = await Promise.all(
    toFire.map(async (account) => {
      try {
        if (!immediate) {
          const fireAt = account.ready.seckillStartTime - fireEarlyMs;
          if (Date.now() < fireAt) await waitUntil(fireAt);
          await ensureXsrf(account.client, account.jar);
        }
        console.log(`[${account.mobile}] 开火 couponId=${account.ready.couponId}`);
        const result = await fireLoop(account.client, account.ready, account.target, {
          ...options,
          tag: account.mobile,
          jar: account.jar,
          user: account.user,
        });
        return { mobile: account.mobile, vipLevel: account.vipLevel, ok: true, ...result };
      } catch (e) {
        console.error(`[${account.mobile}] 抢购异常: ${e.message || e}`);
        return {
          mobile: account.mobile,
          vipLevel: account.vipLevel,
          ok: false,
          success: false,
          error: e.message || String(e),
        };
      }
    })
  );

  for (const a of skipped) {
    results.push({
      mobile: a.mobile,
      vipLevel: a.vipLevel,
      ok: true,
      success: !!a.alreadyAcquired,
      attempts: 0,
      stopReason: a.alreadyAcquired ? 'already_acquired' : 'warmup_failed',
    });
  }

  console.log('');
  console.log('[dev] ========== 汇总 ==========');
  for (const r of results) {
    console.log(
      `[dev] ${r.mobile} success=${!!r.success} attempts=${r.attempts || 0}${r.stopReason ? ` stop=${r.stopReason}` : ''}${r.error ? ` error=${r.error}` : ''}`
    );
  }
  for (const f of failed) {
    console.log(`[dev] ${f.mobile} prepareFailed error=${f.error}`);
  }
  console.log('[dev] ==========================');

  return { results, failed };
}

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const positional = args.filter((a) => !a.startsWith('-'));
  const immediate =
    flags.has('--now') ||
    flags.has('-n') ||
    flags.has('--immediate') ||
    flags.has('--test') ||
    process.env.SECKILL_IMMEDIATE === '1';
  let maxAttempts;
  const maxIdx = args.findIndex((a) => a === '--max' || a === '--max-attempts');
  if (maxIdx >= 0 && args[maxIdx + 1]) maxAttempts = Number(args[maxIdx + 1]);
  return {
    mobiles: positional.length ? positional : null,
    immediate,
    maxAttempts: Number.isFinite(maxAttempts) ? maxAttempts : undefined,
  };
}

module.exports = { runMulti, loadAccountsFromDb };

if (require.main === module) {
  const cli = parseCliArgs(process.argv);
  runMulti({
    mobiles: cli.mobiles,
    immediate: cli.immediate,
    ...(cli.maxAttempts != null ? { maxAttempts: cli.maxAttempts } : {}),
  })
    .then((r) => {
      process.exit((r.results || []).some((x) => x.success) ? 0 : 2);
    })
    .catch((e) => {
      console.error('[dev] fatal', e.message || e);
      process.exit(1);
    });
}
