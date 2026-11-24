const fs = require('fs');
const path = require('path');

const localEnv = path.resolve(__dirname, '../.env');
if (fs.existsSync(localEnv)) require('dotenv').config({ path: localEnv });

const accountRepo = require('./accountRepo');
const { waitUntil, nowMs, sleep } = require('./client');
const {
  prepareAccount,
  annotateSeckillJobs,
  warmupSession,
  fireLoop,
  formatLeft,
  resolveAcquireIntervalMs,
  resolveAcquireWarmupMs,
  runAcquireConnectionWarmup,
  bindPreparedAcquire,
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
const { isRushProxyEnabled, getRushProxyConfig, getRushProxyProvider } = require('./rushProxy');
const { allocateRushProxies } = require('./rushProxyAlloc');

/** 单账号预热硬超时，避免某个代理无响应拖死全体开火 */
const WARMUP_ACCOUNT_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.SECKILL_WARMUP_TIMEOUT_MS ?? 10000) || 10000
);

function withTimeout(promise, ms, label = 'timeout') {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), Math.max(1, ms));
    }),
  ]);
}

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
  annotateSeckillJobs(users);
  return users;
}

async function runMulti(options = {}) {
  const immediate = !!options.immediate;
  const preferLive = !!(
    options.preferLive ||
    options.live ||
    options.current ||
    process.env.SECKILL_PREFER_LIVE === '1'
  );
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
  const liveLabel = preferLive ? ' [当前已开启场次]' : '';
  console.log(`[dev] 账号数=${mobiles.length}${modeLabel}${liveLabel}（按账号×等级展开）`);
  console.log(
    `[dev] 任务: ${users.map((u) => `${u.mobile}/${u.vipLevel}(${u.successCount}/${u.targetCount})`).join(', ')}`
  );
  const intervalMs = resolveAcquireIntervalMs(options);
  const acquireWarmupMs = resolveAcquireWarmupMs(options);
  const proxyEnabled = isRushProxyEnabled();
  const proxyCfg = getRushProxyConfig();
  console.log(
    `[dev] 启动预热 + 开抢前 ${warmupBeforeMs / 1000}s 再预热；acquire 连接预热=${acquireWarmupMs}ms；轮询间隔=${intervalMs}ms；开火偏移区间 FIRE_EARLY_MS=${formatFireRangeLabel(
      fireRange
    )}（负=提前，正=延后，账号内随机）；末${COUNTDOWN_LAST_MS / 1000}s毫秒倒计时`
  );
  if (proxyEnabled) {
    console.log(
      `[dev] 抢购代理: 开 provider=${getRushProxyProvider()} 质检≤${proxyCfg.qualityMaxMs}ms（网易 server/time）；开抢前 ${proxyCfg.stopBeforeRushMs}ms 停分配；未分到直连`
    );
  } else {
    console.log('[dev] 抢购代理: 关（RUSH_PROXY_ENABLED≠1，全部直连）');
  }
  console.log('');

  const prepared = [];
  const failed = [];
  const prepareResults = await Promise.all(
    users.map(async (user) => {
      try {
        const account = await prepareAccount(user.mobile, {
          ...options,
          preferLive,
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

  const skippedTasks = prepared.filter((a) => a.skipSeckill);
  for (const a of skippedTasks) {
    console.log(
      `[dev] 跳过任务 ${a.mobile}/${a.configuredLevel || a.forceVipLevel}: ${a.skipReason || '无需抢购'}`
    );
  }
  const activePrepared = prepared.filter((a) => !a.skipSeckill);

  for (const f of failed) {
    console.error(`[dev] 启动预热失败 ${f.mobile}: ${f.error}`);
  }
  if (!activePrepared.length) {
    throw new Error(
      skippedTasks.length
        ? '全部任务已跳过或预热失败，无法开抢'
        : '全部账号预热失败，无法开抢'
    );
  }

  // 每个账号在区间内随机一个开火偏移
  for (const a of activePrepared) {
    a.fireOffsetMs = sampleFireOffset(fireRange);
  }

  console.log('');
  console.log(`[dev] 启动预热成功 ${activePrepared.length}/${users.length} 个有效任务`);
  for (const a of activePrepared) {
    const startAt = new Date(a.ready.seckillStartTime).toLocaleString('zh-CN', {
      hour12: false,
    });
    console.log(
      `[dev] ✓ ${a.mobile}/${a.vipLevel} ${a.nickname || ''} couponId=${a.ready.couponId} stockId=${a.ready.stockId}${a.ready._inferredStock ? '(推导)' : ''} status=${(a.ready && a.ready.status) || (a.target && a.target.status) || '?'} start=${startAt} 偏移=${formatFireOffsetLabel(a.fireOffsetMs)}${a.alreadyAcquired ? ' [已领取]' : ''}${a.preferLive ? ' [live]' : ''}`
    );
    if (a.logFile) console.log(`[dev]   日志: ${a.logFile}`);
  }
  console.log(`[dev] ${formatVipLevelStats(activePrepared)}`);
  console.log('');

  // 任意一个账号校准服务器时间（拿到档位开始时间之后）
  await calibrateClock(activePrepared[0].client, '[dev] ');

  // 确定本轮开火锚点（正式=最早场次；测试=下一整分/指定时刻）
  const scheduledAt = immediate ? resolveTestFireAt(options, nowMs()) : null;
  const earliestStart = immediate
    ? scheduledAt
    : Math.min(...activePrepared.map((a) => a.ready.seckillStartTime));
  if (immediate) {
    for (const a of activePrepared) {
      a._testScheduledAt = scheduledAt;
    }
    const schedText = new Date(scheduledAt).toLocaleString('zh-CN', { hour12: false });
    console.log(
      `[dev] 测试模式：目标 ${schedText}，各账号在区间 ${formatFireRangeLabel(
        fireRange
      )} 内随机偏移开火`
    );
  }

  // 开抢前分配代理（质检用网易 server/time）
  // 分配窗：开抢前 ALLOC_LEAD（默认 120s）开始 → 开抢前 STOP_BEFORE（默认 5s）硬停
  // 到点未分完：剩余任务直连，绝不拖过开抢
  if (proxyEnabled) {
    const stopBefore = proxyCfg.stopBeforeRushMs || 0;
    const allocLeadMs = Math.max(
      stopBefore + 5000,
      Number(process.env.RUSH_PROXY_ALLOC_LEAD_MS ?? 120000) || 120000
    );
    let allocStartMs = earliestStart - allocLeadMs;
    let deadlineMs = earliestStart - stopBefore;
    // 测试倒计时很短时：立刻开始，截止尽量靠近开抢（至少留 500ms）
    if (deadlineMs <= Date.now()) {
      allocStartMs = Date.now();
      deadlineMs = Math.min(earliestStart - 500, Date.now() + 8000);
    } else if (allocStartMs < Date.now()) {
      allocStartMs = Date.now();
    }

    console.log(
      `[dev] 代理分配计划: 开始≈${new Date(allocStartMs).toLocaleString('zh-CN', {
        hour12: false,
      })} → 截止≈${new Date(deadlineMs).toLocaleString('zh-CN', {
        hour12: false,
      })}（开抢 ${new Date(earliestStart).toLocaleString('zh-CN', {
        hour12: false,
      })} 前 ${stopBefore}ms 停；未分到直连）`
    );

    if (deadlineMs > Date.now()) {
      if (nowMs() < allocStartMs) {
        console.log(
          `[dev] 等待进入代理分配窗（约 ${formatLeft(allocStartMs - nowMs())} 后开始）`
        );
        await waitUntilServer(allocStartMs, { label: '等待分配代理', logEveryMs: 30000 });
      }
      console.log('');
      console.log(
        `[dev] >>> 分配抢购代理（硬截止 ${new Date(deadlineMs).toLocaleString('zh-CN', {
          hour12: false,
        })}）`
      );
      try {
        const hardMs = Math.max(0, deadlineMs - Date.now());
        const alloc = await Promise.race([
          allocateRushProxies(activePrepared, { deadlineMs }),
          sleep(hardMs).then(() => ({
            enabled: true,
            assigned: activePrepared.filter((a) => a.proxyMeta).length,
            remaining: activePrepared.filter((a) => !a.proxyMeta).length,
            timedOut: true,
          })),
        ]);
        if (alloc.timedOut) {
          console.warn('[dev] 代理分配已到硬截止，停止等待，未分到的改直连');
        }
        console.log(
          `[dev] 代理分配结果: assigned=${alloc.assigned} remaining(直连)=${alloc.remaining}`
        );
        for (const a of activePrepared) {
          if (a.proxyMeta) {
            console.log(
              `[dev]   代理 ${a.mobile}/${a.vipLevel} → ${a.proxyMeta.ip}:${a.proxyMeta.port}` +
                `${a.proxyMeta.outIp ? ` out=${a.proxyMeta.outIp}` : ''} rtt=${a.proxyMeta.qualityRttMs}ms`
            );
          } else {
            console.log(`[dev]   直连 ${a.mobile}/${a.vipLevel}`);
          }
        }
      } catch (e) {
        console.warn(`[dev] 代理分配异常，全部直连: ${e.message || e}`);
      }
    } else {
      console.warn('[dev] 距开抢过近，跳过代理分配，全部直连');
    }
  }

  if (!immediate) {
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
      // 距开火太近则缩短/跳过预热，绝不拖过开火点
      const warmBudget = Math.max(0, wakeAt - nowMs() - 200);
      if (warmBudget < 800) {
        console.warn(`[dev] 距开火仅 ${warmBudget}ms，跳过开抢前会话预热`);
      } else {
        const perAccountMs = Math.min(WARMUP_ACCOUNT_TIMEOUT_MS, warmBudget);
        console.log(
          `[dev] >>> 开抢前预热（${activePrepared.length} 账号${proxyEnabled ? '，经代理出口' : ''}；单账号超时 ${perAccountMs}ms）`
        );
        const warmResults = await Promise.all(
          activePrepared.map(async (account) => {
            try {
              await withTimeout(
                warmupSession(account, {
                  label: '开抢前预热',
                  preferLive: !!account.preferLive,
                }),
                perAccountMs,
                `warmup-timeout(${perAccountMs}ms)`
              );
              return { mobile: account.mobile, ok: true };
            } catch (e) {
              console.error(`[dev] 开抢前预热失败 ${account.mobile}: ${e.message || e}`);
              account._warmupFailed = true;
              return { mobile: account.mobile, ok: false, error: e.message || String(e) };
            }
          })
        );
        const warmOk = warmResults.filter((r) => r.ok).length;
        console.log(`[dev] 开抢前预热完成 ${warmOk}/${activePrepared.length}`);
        const alive = activePrepared.find((a) => !a._warmupFailed);
        if (alive) {
          await withTimeout(calibrateClock(alive.client, '[dev] '), 3000, 'calibrate-timeout').catch(
            (e) => console.warn(`[dev] 校时跳过: ${e.message || e}`)
          );
        }
      }
    }

    const preFire = activePrepared.filter((a) => !a.alreadyAcquired && !a._warmupFailed);
    if (preFire.length && acquireWarmupMs > 0 && nowMs() < wakeAt - 500) {
      console.log(`[dev] >>> 开抢前 acquire 接口预热（${preFire.length} 账号，${acquireWarmupMs}ms 前）`);
      await Promise.all(
        preFire.map(async (account) => {
          const fireAt = account.ready.seckillStartTime + (account.fireOffsetMs || 0);
          try {
            await withTimeout(
              runAcquireConnectionWarmup(account, fireAt, options),
              Math.min(5000, Math.max(500, fireAt - nowMs())),
              'acquire-warmup-timeout'
            );
          } catch (e) {
            console.warn(`[dev] acquire 预热跳过 ${account.mobile}: ${e.message || e}`);
          }
        })
      );
    }

    if (preFire.length) {
      for (const account of preFire) {
        bindPreparedAcquire(account);
      }
    }

    if (nowMs() < wakeAt) {
      console.log(
        `[dev] 最早开火约 ${formatLeft(wakeAt - nowMs())} 后（区间 ${formatFireRangeLabel(
          fireRange
        )}）；末 ${COUNTDOWN_LAST_MS / 1000}s 毫秒倒计时`
      );
      await waitUntilServer(wakeAt, { label: '开抢倒计时' });
    }
  } else {
    // 测试模式：代理分配后立刻做会话/acquire 预热（走代理出口）；单账号超时，不拖全体
    const testWarmBudget = Math.max(0, scheduledAt - nowMs() - 300);
    const testPerAccountMs = Math.min(WARMUP_ACCOUNT_TIMEOUT_MS, Math.max(1500, testWarmBudget));
    console.log(
      `[dev] >>> 测试模式开抢前预热（${activePrepared.length} 账号${proxyEnabled ? '，经代理出口' : ''}；单账号超时 ${testPerAccountMs}ms）`
    );
    const warmResults = await Promise.all(
      activePrepared.map(async (account) => {
        try {
          await withTimeout(
            warmupSession(account, {
              label: '测试预热',
              preferLive: !!account.preferLive,
            }),
            testPerAccountMs,
            `warmup-timeout(${testPerAccountMs}ms)`
          );
          return { mobile: account.mobile, ok: true };
        } catch (e) {
          console.error(`[dev] 测试预热失败 ${account.mobile}: ${e.message || e}`);
          account._warmupFailed = true;
          return { mobile: account.mobile, ok: false, error: e.message || String(e) };
        }
      })
    );
    console.log(
      `[dev] 测试预热完成 ${warmResults.filter((r) => r.ok).length}/${activePrepared.length}`
    );

    const preFire = activePrepared.filter((a) => !a.alreadyAcquired && !a._warmupFailed);
    if (preFire.length && acquireWarmupMs > 0 && nowMs() < scheduledAt - 500) {
      console.log(`[dev] >>> 测试模式 acquire 接口预热（${preFire.length} 账号）`);
      await Promise.all(
        preFire.map(async (account) => {
          const fireAt = scheduledAt + (account.fireOffsetMs || 0);
          try {
            await withTimeout(
              runAcquireConnectionWarmup(account, fireAt, options),
              Math.min(5000, Math.max(500, fireAt - nowMs())),
              'acquire-warmup-timeout'
            );
          } catch (e) {
            console.warn(`[dev] acquire 预热跳过 ${account.mobile}: ${e.message || e}`);
          }
        })
      );
    }
    if (preFire.length) {
      for (const account of preFire) {
        bindPreparedAcquire(account);
      }
    }
  }

  const toFire = activePrepared.filter((a) => !a.alreadyAcquired && !a._warmupFailed);
  const skipped = activePrepared.filter((a) => a.alreadyAcquired || a._warmupFailed);
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
        const proxyHint = account.proxyMeta
          ? ` proxy=${account.proxyMeta.ip}:${account.proxyMeta.port}`
          : ' proxy=direct';
        console.log(
          `[${account.mobile}/${account.vipLevel}] 开火 ${formatFireOffsetLabel(fireOffsetMs)} couponId=${account.ready.couponId}${proxyHint}`
        );
        const result = await fireLoop(account.client, account.ready, account.target, {
          ...options,
          tag: `${account.mobile}/${account.vipLevel}`,
          jar: account.jar,
          user: account.user,
          accountId: (account.user && account.user.id) || null,
          vipLevel: account.vipLevel,
          configuredLevel: account.configuredLevel,
          downgraded: account.downgraded,
          preparedAcquire: account.preparedAcquire,
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
  const preferLive =
    flagSet.has('--live') ||
    flagSet.has('--current') ||
    flagSet.has('--progressing') ||
    flagSet.has('-l') ||
    process.env.SECKILL_PREFER_LIVE === '1';
  return {
    mobiles: positional.length ? positional : null,
    immediate,
    preferLive,
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
    preferLive: cli.preferLive,
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
