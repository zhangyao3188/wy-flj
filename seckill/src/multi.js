const fs = require('fs');
const path = require('path');

const localEnv = path.resolve(__dirname, '../.env');
if (fs.existsSync(localEnv)) require('dotenv').config({ path: localEnv });

const accountRepo = require('./accountRepo');
const { ensureXsrf, waitUntil, nowMs } = require('./client');
const {
  prepareAccount,
  warmupSession,
  fireLoop,
  formatLeft,
  resolveAcquireIntervalMs,
  calibrateClock,
  waitUntilServer,
  resolveTestFireAt,
  resolveFireOffsetRange,
  sampleFireOffset,
  formatFireOffsetLabel,
  formatFireRangeLabel,
  FIRE_EARLY_MS,
  WARMUP_BEFORE_MS,
  COUNTDOWN_LAST_MS,
} = require('./runner');

/** 准备完成后的等级统计：共 N 个账号，其中 V1 x 个，V2 y 个… */
function formatVipLevelStats(accounts) {
  const counts = new Map();
  for (const a of accounts || []) {
    const lv = String((a && a.vipLevel) || '未知').toUpperCase();
    counts.set(lv, (counts.get(lv) || 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => {
      const na = Number(String(a[0]).replace(/\D/g, ''));
      const nb = Number(String(b[0]).replace(/\D/g, ''));
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return String(a[0]).localeCompare(String(b[0]));
    })
    .map(([lv, n]) => `${lv} ${n}个`);
  const detail = parts.length ? `，其中${parts.join('，')}` : '';
  return `共 ${accounts.length} 个账号${detail}`;
}

/**
 * 从线上 MySQL 加载抢购任务（账号×等级展开；已完成等级会过滤）
 */
async function loadAccountsFromDb(mobilesFilter) {
  await accountRepo.ensureAccountColumns();
  let users;
  if (mobilesFilter && mobilesFilter.length) {
    users = [];
    for (const mobile of mobilesFilter) {
      const base = await accountRepo.findByMobile(mobile);
      if (!base || base.status === 0) {
        console.warn(`[dev] 数据库无此可用账号: ${mobile}`);
        continue;
      }
      const levels = await accountRepo.listLevelsByMobile(mobile);
      const list =
        levels.length > 0
          ? levels
          : [
              {
                id: null,
                vipLevel: base.vipLevel,
                successCount: base.successCount,
                targetCount: base.targetCount,
                completed: base.completed,
              },
            ];
      for (const lv of list) {
        if (lv.completed || lv.successCount >= lv.targetCount) {
          console.warn(
            `[dev] 跳过已完成: ${mobile}/${lv.vipLevel}（成功 ${lv.successCount}/${lv.targetCount}）`
          );
          continue;
        }
        users.push({
          ...base,
          vipLevel: lv.vipLevel,
          forceVipLevel: lv.vipLevel,
          levelId: lv.id,
          successCount: lv.successCount,
          targetCount: lv.targetCount,
          completed: false,
          maxVipLevel: base.vipLevel,
        });
      }
    }
  } else {
    users = await accountRepo.listSeckillJobs();
  }
  if (!users.length) {
    throw new Error('线上数据库无可用抢购任务（可能均已达设定次数），请先通过 login 配置账号/等级');
  }
  return users;
}

async function runMulti(options = {}) {
  const immediate = !!options.immediate;
  const fireRange = resolveFireOffsetRange(options);
  const warmupBeforeMs =
    options.warmupBeforeMs != null ? options.warmupBeforeMs : WARMUP_BEFORE_MS;

  const users = await loadAccountsFromDb(options.mobiles);
  const mobiles = users.map((u) => u.mobile);

  console.log('');
  console.log('==============================');
  console.log('   多账号并行抢购（线上数据库）');
  console.log('==============================');
  const modeLabel = immediate
    ? options.testStartAt || options.testStartAtMs
      ? ' [测试指定时间]'
      : ' [测试下一整分]'
    : '';
  console.log(`[dev] 账号数=${mobiles.length}${modeLabel}（按账号×等级展开）`);
  console.log(
    `[dev] 任务: ${users.map((u) => `${u.mobile}/${u.vipLevel}(${u.successCount}/${u.targetCount})`).join(', ')}`
  );
  const intervalMs = resolveAcquireIntervalMs(options);
  console.log(
    `[dev] 启动预热 + 开抢前 ${warmupBeforeMs / 1000}s 再预热；成功即停；轮询间隔=${intervalMs}ms；开火偏移区间 FIRE_EARLY_MS=${formatFireRangeLabel(
      fireRange
    )}（负=提前，正=延后，账号内随机）；末${COUNTDOWN_LAST_MS / 1000}s毫秒倒计时`
  );
  console.log('');

  const prepared = [];
  const failed = [];
  const prepareResults = await Promise.all(
    users.map(async (user) => {
      try {
        const account = await prepareAccount(user.mobile, {
          ...options,
          user,
          vipLevel: user.forceVipLevel || user.vipLevel,
        });
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

  // 每个账号在区间内随机一个开火偏移
  for (const a of prepared) {
    a.fireOffsetMs = sampleFireOffset(fireRange);
  }

  console.log('');
  console.log(`[dev] 启动预热成功 ${prepared.length}/${mobiles.length}`);
  for (const a of prepared) {
    const startAt = new Date(a.ready.seckillStartTime).toLocaleString('zh-CN', {
      hour12: false,
    });
    console.log(
      `[dev] ✓ ${a.mobile}/${a.vipLevel} ${a.nickname || ''} couponId=${a.ready.couponId} stockId=${a.ready.stockId}${a.ready._inferredStock ? '(推导)' : ''} start=${startAt} 偏移=${formatFireOffsetLabel(a.fireOffsetMs)}${a.alreadyAcquired ? ' [已领取]' : ''}`
    );
    if (a.logFile) console.log(`[dev]   日志: ${a.logFile}`);
  }
  console.log(`[dev] ${formatVipLevelStats(prepared)}`);
  console.log('');

  // 任意一个账号校准服务器时间（拿到档位开始时间之后）
  await calibrateClock(prepared[0].client, '[dev] ');

  const span = Math.max(Math.abs(fireRange.min), Math.abs(fireRange.max));

  if (!immediate) {
    const earliestStart = Math.min(...prepared.map((a) => a.ready.seckillStartTime));
    const warmAt = earliestStart - warmupBeforeMs;
    // 最早可能开火时刻 = 开抢 + 区间最小值（负数更靠前）
    const wakeAt = earliestStart + fireRange.min;

    if (nowMs() < warmAt) {
      console.log(
        `[dev] 等待开抢前 ${warmupBeforeMs / 1000}s 二次预热（约 ${formatLeft(
          warmAt - nowMs()
        )} 后，服务器时间）`
      );
      await waitUntilServer(warmAt, { label: '等待预热' });
    }

    if (nowMs() < wakeAt + 5000) {
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
      const alive = prepared.find((a) => !a._warmupFailed);
      if (alive) await calibrateClock(alive.client, '[dev] ');
    }

    const preFire = prepared.filter((a) => !a.alreadyAcquired && !a._warmupFailed);
    const xsrfAt = wakeAt - Math.max(1500, span + 500);
    if (preFire.length && nowMs() < xsrfAt) {
      await waitUntilServer(xsrfAt, { label: '等待刷XSRF' });
    }
    if (preFire.length) {
      await Promise.all(
        preFire.map(async (account) => {
          try {
            await ensureXsrf(account.client, account.jar);
          } catch (e) {
            console.warn(`[dev] ${account.mobile} 预刷 XSRF 失败: ${e.message || e}`);
          }
        })
      );
    }

    if (nowMs() < wakeAt) {
      console.log(
        `[dev] 已预刷 XSRF，最早开火约 ${formatLeft(wakeAt - nowMs())} 后（区间 ${formatFireRangeLabel(
          fireRange
        )}）；末 ${COUNTDOWN_LAST_MS / 1000}s 毫秒倒计时`
      );
      await waitUntilServer(wakeAt, { label: '开抢倒计时' });
    }
  } else {
    const scheduledAt = resolveTestFireAt(options, nowMs());
    const earliestFire = scheduledAt + fireRange.min;
    const schedText = new Date(scheduledAt).toLocaleString('zh-CN', { hour12: false });
    const preFire = prepared.filter((a) => !a.alreadyAcquired && !a._warmupFailed);
    const xsrfAt = earliestFire - Math.max(1500, span + 500);
    if (preFire.length && nowMs() < xsrfAt) {
      await waitUntilServer(xsrfAt, { label: '等待刷XSRF' });
    }
    await Promise.all(
      preFire.map(async (account) => {
        try {
          await ensureXsrf(account.client, account.jar);
        } catch (e) {
          console.warn(`[dev] ${account.mobile} 预刷 XSRF 失败: ${e.message || e}`);
        }
      })
    );
    // 记下测试目标时刻，各账号按自己的偏移等待
    for (const a of prepared) {
      a._testScheduledAt = scheduledAt;
    }
    console.log(
      `[dev] 测试模式：目标 ${schedText}，各账号在区间 ${formatFireRangeLabel(
        fireRange
      )} 内随机偏移开火`
    );
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
        const baseAt = immediate
          ? account._testScheduledAt
          : account.ready.seckillStartTime;
        const fireOffsetMs = account.fireOffsetMs || 0;
        const fireAt = baseAt + fireOffsetMs;
        if (nowMs() < fireAt) {
          await waitUntil(fireAt, {
            label: account.mobile,
            countdownLastMs: COUNTDOWN_LAST_MS,
            quiet: toFire.length > 1,
          });
        }
        console.log(
          `[${account.mobile}/${account.vipLevel}] 开火 ${formatFireOffsetLabel(fireOffsetMs)} couponId=${account.ready.couponId}`
        );
        const result = await fireLoop(account.client, account.ready, account.target, {
          ...options,
          tag: `${account.mobile}/${account.vipLevel}`,
          jar: account.jar,
          user: account.user,
          vipLevel: account.vipLevel,
          fireOffsetMs,
          fireOffsetLabel: formatFireOffsetLabel(fireOffsetMs),
          fireBaseAt: baseAt,
          fireAt,
        });
        return {
          mobile: account.mobile,
          vipLevel: account.vipLevel,
          ok: true,
          fireOffsetMs,
          ...result,
        };
      } catch (e) {
        console.error(`[${account.mobile}/${account.vipLevel}] 抢购异常: ${e.message || e}`);
        return {
          mobile: account.mobile,
          vipLevel: account.vipLevel,
          ok: false,
          success: false,
          fireOffsetMs: account.fireOffsetMs,
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
      `[dev] ${r.mobile}/${r.vipLevel || '?'} success=${!!r.success} attempts=${r.attempts || 0}${
        r.fireOffsetMs != null ? ` offset=${formatFireOffsetLabel(r.fireOffsetMs)}` : ''
      }${r.stopReason ? ` stop=${r.stopReason}` : ''}${r.successCount != null ? ` successCount=${r.successCount}` : ''}${r.error ? ` error=${r.error}` : ''}`
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
  const positional = [];
  let testStartAt;
  let maxAttempts;
  const flagSet = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--at' || a === '--start' || a === '--start-at') {
      testStartAt = args[++i];
      continue;
    }
    if (a.startsWith('--at=') || a.startsWith('--start=') || a.startsWith('--start-at=')) {
      testStartAt = a.slice(a.indexOf('=') + 1);
      continue;
    }
    if (a === '--max' || a === '--max-attempts') {
      maxAttempts = Number(args[++i]);
      continue;
    }
    if (a.startsWith('-')) {
      flagSet.add(a);
      continue;
    }
    positional.push(a);
  }
  const immediate =
    flagSet.has('--now') ||
    flagSet.has('-n') ||
    flagSet.has('--immediate') ||
    flagSet.has('--test') ||
    !!testStartAt ||
    process.env.SECKILL_IMMEDIATE === '1';
  return {
    mobiles: positional.length ? positional : null,
    immediate,
    maxAttempts: Number.isFinite(maxAttempts) ? maxAttempts : undefined,
    testStartAt: testStartAt || process.env.SECKILL_TEST_START_AT || undefined,
  };
}

module.exports = { runMulti, loadAccountsFromDb };

if (require.main === module) {
  const cli = parseCliArgs(process.argv);
  runMulti({
    mobiles: cli.mobiles,
    immediate: cli.immediate,
    ...(cli.maxAttempts != null ? { maxAttempts: cli.maxAttempts } : {}),
    ...(cli.testStartAt ? { testStartAt: cli.testStartAt } : {}),
  })
    .then((r) => {
      process.exit((r.results || []).some((x) => x.success) ? 0 : 2);
    })
    .catch((e) => {
      console.error('[dev] fatal', e.message || e);
      process.exit(1);
    });
}
