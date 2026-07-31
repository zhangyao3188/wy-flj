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
  isSessionExpired,
  isAcquireSuccess,
  isAlreadyAcquired,
  jarToCookieList,
  jarToCookieHeader,
  pickTargetByVip,
  findSamePeriod,
  fetchShowingList,
  fetchXyUserInfo,
  resolveMaxVipLevel,
  acquire,
  syncServerTime,
  nowMs,
  normalizeLevel,
  waitUntil,
  readCookie,
  sleep,
} = require('./client');

/** 开抢前多少毫秒开始发请求 */
const FIRE_EARLY_MS = 100;
/** 开抢前多少毫秒再预热一遍 */
const WARMUP_BEFORE_MS = 15000;
/** 正式倒计时展示窗口（末 N 毫秒精确到 ms） */
const COUNTDOWN_LAST_MS = 10000;
/** 测试模式模拟倒计时时长（未指定 --at 时） */
const TEST_COUNTDOWN_MS = 5000;

/**
 * 解析测试开抢时间。
 * 支持：
 * - 13 位毫秒时间戳 / 10 位秒时间戳
 * - HH:mm:ss / HH:mm（当天；若已过则视为明天）
 * - YYYY-MM-DD HH:mm:ss
 */
function parseTestStartTime(input, refNow = Date.now()) {
  if (input == null || input === '') return null;
  const s = String(input).trim();
  if (!s) return null;

  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;

  let m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const d = new Date(refNow);
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    let t = d.getTime();
    if (t <= refNow) t += 24 * 60 * 60 * 1000;
    return t;
  }

  m = s.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0),
      0
    ).getTime();
  }

  const parsed = Date.parse(s.replace(/-/g, '/'));
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`无法解析开始时间: ${input}`);
}

/**
 * 测试模式开火时刻：有 --at 用指定时间，否则 now + 5s
 */
function resolveTestFireAt(options = {}, now = nowMs()) {
  if (options.testStartAtMs != null && Number.isFinite(Number(options.testStartAtMs))) {
    return Number(options.testStartAtMs);
  }
  if (options.testStartAt) {
    return parseTestStartTime(options.testStartAt, now);
  }
  const testCountdownMs =
    options.testCountdownMs != null ? options.testCountdownMs : TEST_COUNTDOWN_MS;
  return now + testCountdownMs;
}

function resolveAcquireIntervalMs(options = {}) {
  if (options.intervalMs != null && Number.isFinite(Number(options.intervalMs))) {
    return Math.max(0, Number(options.intervalMs));
  }
  const fromEnv = Number(process.env.ACQUIRE_INTERVAL_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return 0;
}

async function calibrateClock(client, tag = '[seckill] ') {
  const sync = await syncServerTime(client);
  console.log(
    `${tag}服务器时间校准 currentTime=${sync.currentTime} offset=${
      sync.serverOffsetMs >= 0 ? '+' : ''
    }${sync.serverOffsetMs}ms rtt=${sync.rttMs}ms`
  );
  return sync;
}

/**
 * 等到目标服务器时刻；末 10 秒毫秒倒计时。
 */
async function waitUntilServer(targetMs, { label = '开抢', logEveryMs = 10000 } = {}) {
  let lastLog = 0;
  await waitUntil(targetMs, {
    label,
    countdownLastMs: COUNTDOWN_LAST_MS,
    onTick: (left) => {
      if (left > COUNTDOWN_LAST_MS) {
        const t = nowMs();
        if (t - lastLog > logEveryMs) {
          lastLog = t;
          console.log(`[${label}] 等待中，剩余 ${formatLeft(left)}（服务器时间）`);
        }
      }
    },
  });
}

function formatLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m${sec}s`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

/** 列表未返回 stockId 时，按前端常见规则推导 */
function inferStockId(target) {
  if (target && target.stockId) return target.stockId;
  if (target && target.couponId && Number.isFinite(target.seckillStartTime)) {
    return `${target.couponId}_WEEKLY_${target.seckillStartTime}`;
  }
  return null;
}

async function persistCookies(user, jar, tag = '', extra = {}) {
  try {
    const cookies = jarToCookieList(jar);
    const cookieHeader = jarToCookieHeader(jar);
    const godUuid = readCookie(jar, 'GOD_UUID') || user.godUuid || null;
    await accountRepo.updateCookies(user.mobile, {
      cookies,
      cookieHeader,
      godUuid,
      deviceId: user.deviceId || null,
      ...(extra.vipLevel ? { vipLevel: extra.vipLevel } : {}),
      ...(extra.vipRaw != null ? { vipRaw: extra.vipRaw } : {}),
    });
    if (tag) console.log(`${tag}已将刷新后的 cookie${extra.vipLevel ? `/等级${extra.vipLevel}` : ''} 写回数据库`);
  } catch (e) {
    console.warn(`${tag}写回 cookie 失败: ${e.message || e}`);
  }
}

/**
 * 预热：走一遍抢购链路（xsrf → nlogin → cookie-exchange → get-info等级 → showing-list → 预备参数）
 * 等级以 get-info.currentLv 为准（账号最大可抢档位）；若过期则更新 cookie。
 */
async function warmupSession(account, { label = '预热' } = {}) {
  const tag = `[${account.mobile}] `;
  const { client, jar, user } = account;
  console.log(`${tag}${label}开始…`);

  await ensureXsrf(client, jar);
  await ensureSession(client).catch(() => null);

  try {
    await cookieExchange(client);
  } catch (e) {
    console.warn(`${tag}${label} cookie-exchange 调用异常: ${e.message || e}`);
  }
  await ensureXsrf(client, jar);

  // 拉取账号最大档位
  let vipData = null;
  try {
    vipData = await fetchXyUserInfo(client);
    if (isSessionExpired(vipData)) {
      console.warn(`${tag}${label} get-info 会话过期(873)，重新 cookie-exchange…`);
      await cookieExchange(client);
      await ensureXsrf(client, jar);
      vipData = await fetchXyUserInfo(client);
    }
  } catch (e) {
    console.warn(`${tag}${label} get-info 失败: ${e.message || e}`);
  }

  let listResp = await fetchShowingList(client);
  if (isSessionExpired(listResp)) {
    console.warn(`${tag}${label}检测到会话过期(873)，重新 cookie-exchange…`);
    await cookieExchange(client);
    await ensureXsrf(client, jar);
    await ensureSession(client).catch(() => null);
    vipData = await fetchXyUserInfo(client).catch(() => vipData);
    listResp = await fetchShowingList(client);
    if (isSessionExpired(listResp)) {
      throw new Error('会话仍过期(873)，请重新通过 login 登录');
    }
  }

  if (!(listResp && (listResp.code === 200 || listResp.status === 200))) {
    throw new Error(`获取秒杀列表失败: ${JSON.stringify(listResp).slice(0, 300)}`);
  }

  const listResult = listResp.result || listResp.data || listResp;
  const vipLevel = resolveMaxVipLevel(
    vipData,
    listResult,
    account.vipLevel || (user && user.vipLevel) || 'V1'
  );
  account.vipLevel = vipLevel;
  if (user) user.vipLevel = vipLevel;

  await persistCookies(user || { mobile: account.mobile }, jar, tag, {
    vipLevel,
    vipRaw: vipData,
  });

  console.log(`${tag}${label}账号最大档位=${vipLevel}（来源 get-info.currentLv）`);

  const { target, reason, candidates } = pickTargetByVip(listResult, vipLevel);
  if (!target || !target.couponId || !Number.isFinite(target.seckillStartTime)) {
    throw new Error(`选品失败: ${reason}; candidates=${candidates.length}`);
  }

  if (
    target.status === 'ACQUIRED' ||
    (target.rawPeriod && target.rawPeriod.acquiredStatus === 'ACQUIRED')
  ) {
    account.alreadyAcquired = true;
    console.log(`${tag}${label}本场已领取，将跳过抢购`);
  }

  const ready = await preparePayload(client, target, candidates, {
    allowBorrowStock: !!account._immediate,
  });
  await ensureXsrf(client, jar);

  account.target = target;
  account.ready = ready;
  account.reason = reason;
  account.warmedAt = Date.now();
  console.log(
    `${tag}${label}完成 档位=${vipLevel} couponId=${ready.couponId} stockId=${ready.stockId} start=${new Date(
      ready.seckillStartTime
    ).toLocaleString('zh-CN', { hour12: false })}`
  );
  return account;
}

/**
 * 启动即预备请求参数（couponId / stockId），进入预备态后等待开火。
 */
async function preparePayload(client, target, candidates, { allowBorrowStock = false } = {}) {
  let ready = { ...target };

  if (!ready.stockId) {
    try {
      const resp = await fetchShowingList(client);
      if (isSessionExpired(resp)) {
        throw Object.assign(new Error('session expired'), { resp });
      }
      if (resp && (resp.code === 200 || resp.status === 200)) {
        const latest = findSamePeriod(resp.result || resp.data || resp, target);
        if (latest) ready = { ...ready, ...latest };
      }
    } catch (e) {
      if (e && e.resp && isSessionExpired(e.resp)) throw e;
    }
  }

  if (!ready.stockId && allowBorrowStock) {
    const withStock = (candidates || []).find((c) => c.couponId === target.couponId && c.stockId);
    if (withStock) {
      ready.stockId = withStock.stockId;
      ready._borrowedStock = true;
      ready._borrowedFromStatus = withStock.status;
    }
  }

  if (!ready.stockId) {
    ready.stockId = inferStockId(ready);
    if (ready.stockId) ready._inferredStock = true;
  }

  if (!ready.couponId || !ready.stockId) {
    throw new Error('预备失败：无法得到 couponId / stockId');
  }

  return {
    couponId: ready.couponId,
    stockId: ready.stockId,
    amount: ready.amount,
    status: ready.status,
    weekDay: ready.weekDay,
    seckillStartTime: ready.seckillStartTime,
    seckillEndTime: ready.seckillEndTime,
    xyLevel: ready.xyLevel,
    stockRemain: ready.stockRemain,
    _inferredStock: !!ready._inferredStock,
    _borrowedStock: !!ready._borrowedStock,
    _borrowedFromStatus: ready._borrowedFromStatus || null,
  };
}

async function fireLoop(client, ready, target, options = {}) {
  const tag = options.tag ? `[${options.tag}] ` : '';
  const maxAttempts = options.maxAttempts != null ? options.maxAttempts : Infinity;
  const intervalMs = resolveAcquireIntervalMs(options);
  const jar = options.jar || null;
  const user = options.user || null;
  let attempt = 0;
  let success = false;
  let stopReason = null;
  let successCount = null;
  let refreshedOn873 = false;
  const startedAt = Date.now();

  while (!success && attempt < maxAttempts) {
    attempt += 1;
    const t0 = Date.now();
    try {
      const resp = await acquire(client, {
        couponId: ready.couponId,
        stockId: ready.stockId,
      });
      const cost = Date.now() - t0;
      const code = resp && resp.code;
      const msg = (resp && (resp.errmsg || resp.message)) || '';

      // 成功结构：code=200 + result.received=true → 立刻停该账号，并计入成功次数
      if (isAcquireSuccess(resp)) {
        success = true;
        stopReason = 'acquired';
        const mobile = (user && user.mobile) || options.tag;
        if (mobile) {
          try {
            await accountRepo.ensureSuccessCountColumn();
            successCount = await accountRepo.incrementSuccessCount(mobile);
            console.log(
              `${tag}[seckill] SUCCESS #${attempt} ${cost}ms received=true → 停止该账号，成功次数=${successCount}`
            );
          } catch (e) {
            console.log(
              `${tag}[seckill] SUCCESS #${attempt} ${cost}ms received=true → 停止该账号（写库失败: ${e.message || e}）`
            );
          }
        } else {
          console.log(
            `${tag}[seckill] SUCCESS #${attempt} ${cost}ms received=true → 停止该账号`
          );
        }
        break;
      }

      if (isAlreadyAcquired(resp)) {
        success = true;
        stopReason = 'already_acquired';
        console.log(
          `${tag}[seckill] 已领取 #${attempt} ${cost}ms → 停止该账号（不计成功次数）`
        );
        break;
      }

      console.log(
        `${tag}[seckill] #${attempt} ${cost}ms code=${code} msg=${msg}`.slice(0, 260)
      );

      if (isSessionExpired(resp)) {
        if (!refreshedOn873) {
          refreshedOn873 = true;
          console.warn(`${tag}[seckill] 抢购中会话过期(873)，尝试 cookie-exchange…`);
          try {
            await cookieExchange(client);
            if (jar) await ensureXsrf(client, jar);
            if (jar && user) await persistCookies(user, jar, tag);
          } catch (e) {
            console.warn(`${tag}[seckill] cookie-exchange 失败: ${e.message || e}`);
          }
        } else {
          console.error(`${tag}[seckill] 刷新后仍 873，停止该账号（需重新登录）`);
          stopReason = 'session_expired';
          break;
        }
      } else if (code === 803 || code === 825) {
        try {
          const resp2 = await fetchShowingList(client);
          if (isSessionExpired(resp2)) {
            console.warn(`${tag}[seckill] 刷新 stockId 时会话过期(873)`);
          } else {
            const latest = findSamePeriod(resp2.result || resp2.data || resp2, target);
            if (latest && latest.stockId) {
              ready.stockId = latest.stockId;
              console.log(`${tag}[seckill] 已更新 stockId=${ready.stockId}`);
            }
          }
        } catch (_) {}
      }
    } catch (e) {
      const cost = Date.now() - t0;
      console.log(`${tag}[seckill] #${attempt} ${cost}ms ERROR ${e.message || e}`);
    }

    // 未停抢时，按配置间隔再发下一枪（ACQUIRE_INTERVAL_MS，单位毫秒）
    if (!success && attempt < maxAttempts && intervalMs > 0) {
      await sleep(intervalMs);
    }
  }

  return {
    success,
    attempts: attempt,
    elapsedMs: Date.now() - startedAt,
    target: ready,
    stopReason,
    intervalMs,
    successCount: stopReason === 'acquired' ? successCount : undefined,
  };
}

/**
 * 为单个账号完成会话校验、选品、参数预备（不等待开抢）。
 * 账号仅从线上 MySQL 读取（options.user 可传入已查好的记录）。
 */
async function prepareAccount(mobile, options = {}) {
  let user = options.user || null;
  if (!user) {
    user = await accountRepo.findByMobile(mobile);
  }
  if (!user || user.status === 0) {
    throw new Error(`用户 ${mobile} 在数据库中不存在或已禁用，请先通过 login 在线登录`);
  }

  const immediate = !!options.immediate;
  // 等级以预热时 get-info 为准；此处仅作初始占位
  const vipLevel = normalizeLevel(options.vipLevel || user.vipLevel || 'V1');
  const { client, jar, logFile } = createClientFromUser(user);

  const account = {
    mobile: user.mobile,
    nickname: user.nickname,
    vipLevel,
    client,
    jar,
    logFile,
    user,
    _immediate: immediate,
    alreadyAcquired: false,
    nloginOk: false,
    hasGodUuid: !!user.godUuid,
  };

  // 启动时预热一遍（含过期则更新 cookie）
  await warmupSession(account, { label: '启动预热' });

  const session = await ensureSession(client).catch(() => null);
  account.nloginOk = !!(session && (session.code === 200 || session.status === 200));

  return account;
}

/**
 * 抢购流程：
 * 正式模式：启动预热 → 校准服务器时间 → 开抢前15s再预热 → 末10s毫秒倒计时 → 开抢前100ms 连续 acquire
 * 测试模式：预热 → 模拟 5s 倒计时 → 开火
 */
async function runSeckill(mobile, options = {}) {
  const immediate = !!options.immediate;
  const fireEarlyMs = options.fireEarlyMs != null ? options.fireEarlyMs : FIRE_EARLY_MS;
  const warmupBeforeMs =
    options.warmupBeforeMs != null ? options.warmupBeforeMs : WARMUP_BEFORE_MS;

  console.log(`[seckill] 用户=${mobile}${immediate ? ' [测试倒计时抢]' : ''}`);
  const account = await prepareAccount(mobile, options);

  console.log(
    `[seckill] 用户=${account.mobile} 昵称=${account.nickname} 等级=${account.vipLevel}`
  );
  if (account.logFile) console.log(`[seckill] 详细日志: ${account.logFile}`);
  if (account.nloginOk) console.log('[seckill] nlogin 成功');
  else if (account.hasGodUuid) console.log('[seckill] 已有 GOD_UUID，跳过 nlogin 失败提示');
  else console.warn('[seckill] 警告: nlogin 未成功；请确认登录有效');

  const startAt = new Date(account.ready.seckillStartTime).toLocaleString('zh-CN', {
    hour12: false,
  });
  console.log(`[seckill] 选品策略: ${account.reason}`);
  console.log('[seckill] ========== 预备完成 ==========');
  console.log(`[seckill] couponId=${account.ready.couponId}`);
  console.log(
    `[seckill] stockId=${account.ready.stockId}${account.ready._inferredStock ? ' (推导)' : ''}`
  );
  console.log(`[seckill] seckillStartTime=${account.ready.seckillStartTime} (${startAt})`);
  console.log('[seckill] ==============================');

  // 拿到档位开抢时间后，立刻用服务器时间校准
  await calibrateClock(account.client);

  if (account.alreadyAcquired) {
    console.log('[seckill] 本场已领取，跳过开火');
    return {
      success: true,
      attempts: 0,
      elapsedMs: 0,
      target: account.ready,
      mobile: account.mobile,
      vipLevel: account.vipLevel,
      stopReason: 'already_acquired',
    };
  }

  if (immediate) {
    const fireAt = resolveTestFireAt(options, nowMs());
    const left = fireAt - nowMs();
    const atText = new Date(fireAt).toLocaleString('zh-CN', { hour12: false });
    if (left <= 0) {
      console.log(`[seckill] 测试模式：指定时间 ${atText} 已过，立即开火`);
    } else {
      console.log(
        `[seckill] 测试模式：等待到 ${atText} 开火（约 ${formatLeft(left)}，服务器时间）`
      );
      await waitUntilServer(fireAt, { label: '测试倒计时' });
    }
    await ensureXsrf(account.client, account.jar);
  } else {
    const startMs = account.ready.seckillStartTime;
    const warmAt = startMs - warmupBeforeMs;
    const fireAt = startMs - fireEarlyMs;

    if (nowMs() < warmAt) {
      console.log(
        `[seckill] 等待开抢前 ${warmupBeforeMs / 1000}s 预热（约 ${formatLeft(
          warmAt - nowMs()
        )} 后，服务器时间）`
      );
      await waitUntilServer(warmAt, { label: '等待预热' });
    }

    if (nowMs() < fireAt) {
      await warmupSession(account, { label: '开抢前预热' });
      if (account.alreadyAcquired) {
        console.log('[seckill] 开抢前预热发现已领取，跳过开火');
        return {
          success: true,
          attempts: 0,
          elapsedMs: 0,
          target: account.ready,
          mobile: account.mobile,
          vipLevel: account.vipLevel,
          stopReason: 'already_acquired',
        };
      }
      // 预热后再校准一次，减小时钟漂移
      await calibrateClock(account.client);
    }

    if (nowMs() < fireAt) {
      console.log(
        `[seckill] 预热完成，将在开抢前 ${fireEarlyMs}ms 开火（约 ${formatLeft(
          fireAt - nowMs()
        )} 后）；末 ${COUNTDOWN_LAST_MS / 1000}s 毫秒倒计时`
      );
      await waitUntilServer(fireAt, { label: '开抢倒计时' });
    } else {
      console.log('[seckill] 已到/超过开火时刻，立即开始');
    }
    await ensureXsrf(account.client, account.jar);
  }

  console.log(
    `[seckill] 开始连续抢购${
      immediate ? '（测试模式）' : `（提前 ${fireEarlyMs}ms）`
    }…`
  );
  const intervalMs = resolveAcquireIntervalMs(options);
  if (intervalMs > 0) {
    console.log(`[seckill] 轮询间隔 ACQUIRE_INTERVAL_MS=${intervalMs}ms`);
  } else {
    console.log('[seckill] 轮询间隔 0（请求返回后立即下一发）');
  }

  const result = await fireLoop(account.client, account.ready, account.target, {
    ...options,
    tag: account.mobile,
    jar: account.jar,
    user: account.user,
  });
  return {
    ...result,
    mobile: account.mobile,
    vipLevel: account.vipLevel,
  };
}

module.exports = {
  runSeckill,
  prepareAccount,
  warmupSession,
  fireLoop,
  formatLeft,
  resolveAcquireIntervalMs,
  calibrateClock,
  waitUntilServer,
  parseTestStartTime,
  resolveTestFireAt,
  FIRE_EARLY_MS,
  WARMUP_BEFORE_MS,
  COUNTDOWN_LAST_MS,
  TEST_COUNTDOWN_MS,
};

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('-') && !a.includes(':')));
  const positional = [];
  let testStartAt;
  let maxAttempts;
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
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  const immediate =
    flags.has('--now') ||
    flags.has('-n') ||
    flags.has('--immediate') ||
    flags.has('--test') ||
    !!testStartAt ||
    process.env.SECKILL_IMMEDIATE === '1';
  const mobile = positional[0] || process.env.MOBILE;
  if (process.env.SECKILL_MAX_ATTEMPTS && !Number.isFinite(maxAttempts)) {
    maxAttempts = Number(process.env.SECKILL_MAX_ATTEMPTS);
  }
  return {
    mobile,
    immediate,
    maxAttempts: Number.isFinite(maxAttempts) ? maxAttempts : undefined,
    testStartAt: testStartAt || process.env.SECKILL_TEST_START_AT || undefined,
  };
}

if (require.main === module) {
  const { mobile, immediate, maxAttempts, testStartAt } = parseCliArgs(process.argv);
  if (!mobile) {
    console.error('用法:');
    console.error('  npm run seckill -- <手机号>           # 预备后，开抢前100ms开火');
    console.error('  npm run test:now -- <手机号>          # 测试：5s 倒计时后抢');
    console.error('  npm run test:now -- <手机号> --at 12:05:00');
    console.error('  npm run test:now -- <手机号> --at "2026-07-31 12:05:00"');
    process.exit(1);
  }
  runSeckill(mobile, {
    immediate,
    ...(Number.isFinite(maxAttempts) ? { maxAttempts } : {}),
    ...(testStartAt ? { testStartAt } : {}),
  })
    .then((r) => {
      console.log('[seckill] finished', {
        success: r.success,
        attempts: r.attempts,
        elapsedMs: r.elapsedMs,
        vipLevel: r.vipLevel,
        stopReason: r.stopReason,
        couponId: r.target && r.target.couponId,
        stockId: r.target && r.target.stockId,
        seckillStartTime: r.target && r.target.seckillStartTime,
        immediate,
        testStartAt,
      });
      process.exit(r.success ? 0 : 2);
    })
    .catch((e) => {
      console.error('[seckill] fatal', e.message || e);
      process.exit(1);
    });
}
