const accountRepo = require('./accountRepo');
const {
  createClientFromUser,
  ensureXsrf,
  ensureSession,
  cookieExchange,
  fetchActInfo,
  syncServerTime,
  nowMs,
  fetchExchangeList,
  exchangePrize,
  isExchangeSuccess,
  isAlreadyExchanged,
  isSessionExpired,
  waitUntil,
  parseStartAt,
  sleep,
  loadConfig,
} = require('./client');

const WARMUP_BEFORE_MS = Number(process.env.WARMUP_BEFORE_MS || 15000);
const COUNTDOWN_LAST_MS = 10000;
const TEST_MINUTE_SEC_THRESHOLD = 50;

function parseFireOffsetRange(raw) {
  if (raw == null || raw === '') return { min: 0, max: 0 };
  const s = String(raw).trim();
  const m = s.match(/^\[?\s*(-?\d+)\s*[,，]\s*(-?\d+)\s*\]?$/);
  if (m) {
    let min = Number(m[1]);
    let max = Number(m[2]);
    if (min > max) [min, max] = [max, min];
    return { min, max };
  }
  const n = Number(s);
  if (Number.isFinite(n)) return { min: n, max: n };
  return { min: 0, max: 0 };
}

function resolveFireOffsetRange(options = {}) {
  if (options.fireOffsetRange != null) return parseFireOffsetRange(options.fireOffsetRange);
  return parseFireOffsetRange(process.env.FIRE_EARLY_MS);
}

function sampleFireOffset(range) {
  const r = range && Number.isFinite(range.min) ? range : { min: 0, max: 0 };
  if (r.min === r.max) return r.min;
  return r.min + Math.floor(Math.random() * (r.max - r.min + 1));
}

function formatFireOffsetLabel(offsetMs) {
  const n = Number(offsetMs) || 0;
  if (n < 0) return `提前 ${Math.abs(n)}ms`;
  if (n > 0) return `延后 ${n}ms`;
  return '准时';
}

/** 轮询间隔：默认 0，上一请求结束后立刻发下一轮 */
function resolveAcquireIntervalMs(options = {}) {
  if (options.intervalMs != null && Number.isFinite(Number(options.intervalMs))) {
    return Math.max(0, Number(options.intervalMs));
  }
  const fromEnv = Number(process.env.ACQUIRE_INTERVAL_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return 0;
}

function resolveAcquireWarmupMs(options = {}) {
  if (options.acquireWarmupMs != null) return Math.max(0, Number(options.acquireWarmupMs));
  const fromEnv = Number(process.env.ACQUIRE_WARMUP_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return 5000;
}

/** 商品列表旁路轮询间隔；默认 0=上一轮结束后立刻下一轮 */
function resolveGoodsWatchIntervalMs(options = {}) {
  if (options.goodsWatchIntervalMs != null && Number.isFinite(Number(options.goodsWatchIntervalMs))) {
    return Math.max(0, Number(options.goodsWatchIntervalMs));
  }
  const fromEnv = Number(process.env.GOODS_WATCH_INTERVAL_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return 0;
}

function normalizePrizeName(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function goodsDisplayName(g) {
  if (!g || typeof g !== 'object') return '';
  return String(g.prizeName || g.name || g.goodsName || g.title || '');
}

function goodsExchangeId(g) {
  if (!g || typeof g !== 'object') return '';
  return String(g.exchangeId || g.id || g.goodsId || '');
}

/** 测试模式默认开火：当前秒 < 50 → 下一整分；≥ 50 → 下下整分（与 seckill 一致） */
function resolveNextWholeMinuteFireAt(now = nowMs(), thresholdSec = TEST_MINUTE_SEC_THRESHOLD) {
  const d = new Date(now);
  const minuteStart = new Date(d);
  minuteStart.setSeconds(0, 0);
  const sec = d.getSeconds();
  const addMinutes = sec < thresholdSec ? 1 : 2;
  return minuteStart.getTime() + addMinutes * 60 * 1000;
}

function resolveTestFireAt(options = {}, now = nowMs()) {
  if (options.testStartAtMs != null && Number.isFinite(Number(options.testStartAtMs))) {
    return Number(options.testStartAtMs);
  }
  if (options.testStartAt) {
    return parseStartAt(options.testStartAt, now);
  }
  if (options.testCountdownMs != null && Number.isFinite(Number(options.testCountdownMs))) {
    return now + Math.max(0, Number(options.testCountdownMs));
  }
  const threshold =
    options.testMinuteSecThreshold != null
      ? Number(options.testMinuteSecThreshold)
      : TEST_MINUTE_SEC_THRESHOLD;
  return resolveNextWholeMinuteFireAt(now, Number.isFinite(threshold) ? threshold : 50);
}

/** 正式模式：POINTS_SECKILL_START_AT=yyyy-mm-dd hh:mm:ss */
function resolveDevStartAt(options = {}, now = nowMs()) {
  const raw =
    options.startAt ||
    options.devStartAt ||
    process.env.POINTS_SECKILL_START_AT ||
    process.env.SECKILL_START_AT ||
    process.env.POINTS_START_AT;
  if (!raw) {
    throw new Error(
      '未配置开抢时间：请在 points-seckill/.env 设置 POINTS_SECKILL_START_AT=yyyy-mm-dd hh:mm:ss'
    );
  }
  const t = parseStartAt(raw, now);
  if (!Number.isFinite(t)) {
    throw new Error(`开抢时间无效: ${raw}（需要 yyyy-mm-dd hh:mm:ss）`);
  }
  return t;
}

function formatFireTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}.${String(ms % 1000).padStart(3, '0')}`;
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

/** 同账号多商品并行时用 [mobile/goods] 区分日志，互不影响 */
function jobTag(account) {
  const mobile = account && account.mobile ? String(account.mobile) : '?';
  const goodsLabel = account && account.goodsName
    ? String(account.goodsName).slice(0, 16)
    : account && account.goodsId
      ? String(account.goodsId).slice(-10)
      : '?';
  return `[${mobile}/${goodsLabel}] `;
}

async function calibrateClock(client, tag = '[points] ') {
  const sync = await syncServerTime(client);
  console.log(
    `${tag}服务器时间校准 currentTime=${sync.currentTime} offset=${
      sync.serverOffsetMs >= 0 ? '+' : ''
    }${sync.serverOffsetMs}ms rtt=${sync.rttMs}ms`
  );
  return sync;
}

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

async function warmupSession(account, { label = '预热' } = {}) {
  const tag = jobTag(account);
  await ensureXsrf(account.client, account.jar);
  await ensureSession(account.client).catch(() => {});
  try {
    await cookieExchange(account.client);
  } catch (_) {}
  await ensureXsrf(account.client, account.jar);
  const actInfo = await fetchActInfo(account.client);
  account.actInfo = actInfo;
  console.log(
    `${tag}[${label}] actAccount=${actInfo.actAccount || account.actAccount || '-'} appKey=${
      actInfo.appKey || account.appKey || '-'
    }`
  );
  return actInfo;
}

async function refreshGoods(account) {
  const listed = await fetchExchangeList(account.listClient || account.client, account.actInfo);
  const hit =
    listed.list.find((g) => String(g.exchangeId) === String(account.goodsId)) ||
    listed.list.find((g) => String(g.id) === String(account.goodsId));
  if (hit) {
    account.goodsName = hit.name || hit.prizeName || account.goodsName;
    account.latestGoods = hit;
  }
  account.moduleParams = listed.params;
  return hit || null;
}

/**
 * 开抢旁路：并行轮询 getExchangeList，按 prizeName 匹配；
 * 发现 exchangeId 变更则热切换抢购通道（主通道仍先用旧 id 打，下一发起用新 id）。
 * 每次轮询先拉 actInfo，用最新 actId/asId 查列表。
 */
async function watchGoodsIdentity(account, ctl, options = {}) {
  const tag = jobTag(account);
  const intervalMs = resolveGoodsWatchIntervalMs(options);
  const matchRaw = account.matchPrizeName || account.goodsName;
  const matchName = normalizePrizeName(matchRaw);
  if (!matchName) {
    console.warn(`${tag}[goods-watch] 无商品名称，跳过列表轮询`);
    return;
  }
  const client = account.listClient || account.client;
  console.log(
    `${tag}[goods-watch] 启动列表轮询（不影响抢购通道）匹配「${matchRaw}」 interval=${intervalMs}ms`
  );

  while (!ctl.stopped) {
    try {
      const actInfo = await fetchActInfo(client);
      if (actInfo && typeof actInfo === 'object') {
        account.actInfo = actInfo;
      }
      const listed = await fetchExchangeList(client, account.actInfo);
      if (listed.params) {
        account.moduleParams = listed.params;
      }
      const hit = (listed.list || []).find(
        (g) => normalizePrizeName(goodsDisplayName(g)) === matchName
      );
      if (hit) {
        const newId = goodsExchangeId(hit);
        const oldId = String(account.goodsId || '');
        if (newId && newId !== oldId) {
          account.goodsId = newId;
          account.goodsName = goodsDisplayName(hit) || account.goodsName;
          account.latestGoods = hit;
          const p = listed.params || {};
          console.log(
            `${tag}[goods-watch] 商品变更 id ${oldId} → ${newId}` +
              ` actId=${p.actId || '-'} asId=${p.asId || '-'} → 抢购通道已切换`
          );
        }
      }
    } catch (e) {
      if (!ctl.stopped) {
        console.warn(`${tag}[goods-watch] ${e.message || e}`);
      }
    }
    if (ctl.stopped) break;
    await sleep(intervalMs > 0 ? intervalMs : 0);
  }
}

async function fireLoop(account, options = {}) {
  const tag = jobTag(account);
  const maxAttempts = options.maxAttempts != null ? options.maxAttempts : Infinity;
  const intervalMs = resolveAcquireIntervalMs(options);
  let attempt = 0;
  let success = false;
  let stopReason = null;
  const startedAt = Date.now();
  let refreshedOn873 = false;
  const cfg = loadConfig();

  const watchCtl = { stopped: false };
  let watchTask = null;
  if (!options.warmupAcquire && options.watchGoods !== false) {
    watchTask = watchGoodsIdentity(account, watchCtl, options);
  }

  try {
    while (!success && attempt < maxAttempts) {
      attempt += 1;
      const t0 = Date.now();
      const exchangeId = account.goodsId;
      try {
        const resp = await exchangePrize(account.client, {
          exchangeId,
          roleId: account.roleId,
          server: account.server,
          appKey: account.appKey || cfg.appKey,
          fireMeta: {
            goodsName: account.goodsName,
            exchangeId,
            fireAt: options.fireAt,
            warmupAcquire: !!options.warmupAcquire,
          },
        });
        const cost = Date.now() - t0;
        const code = resp && resp.code;
        const msg = (resp && (resp.errmsg || resp.message || resp.msg)) || '';

        if (options.warmupAcquire) {
          console.log(`${tag}[warmup] #${attempt} ${cost}ms code=${code} ${msg}`.slice(0, 200));
          break;
        }

        if (isExchangeSuccess(resp)) {
          success = true;
          stopReason = 'acquired';
          console.log(`${tag}[points] SUCCESS #${attempt} ${cost}ms → 停止该商品任务`);
          accountRepo
            .incrementSuccessCount({
              taskId: account.taskId,
              accountId: account.accountId,
              mobile: account.mobile,
              goodsId: account.goodsId,
              goodsName: account.goodsName,
            })
            .then((n) => console.log(`${tag}[points] 成功次数已写入 successCount=${n}`))
            .catch((e) => console.warn(`${tag}[points] 成功写库失败: ${e.message || e}`));
          break;
        }

        if (isAlreadyExchanged(resp)) {
          success = true;
          stopReason = 'already_exchanged';
          console.log(`${tag}[points] 已兑换 #${attempt} ${cost}ms → 停止（记疑似，不计 success_count）`);
          accountRepo
            .recordSuspectedSuccess({
              accountId: account.accountId,
              mobile: account.mobile,
              goodsId: account.goodsId,
              goodsName: account.goodsName,
              note: msg || '已兑换',
            })
            .catch(() => {});
          break;
        }

        console.log(`${tag}[points] #${attempt} ${cost}ms code=${code} msg=${msg}`.slice(0, 260));

        if (isSessionExpired(resp)) {
          if (!refreshedOn873) {
            refreshedOn873 = true;
            console.warn(`${tag}[points] 会话过期(873)，尝试 cookie-exchange…`);
            try {
              await cookieExchange(account.client);
              await ensureXsrf(account.client, account.jar);
            } catch (e) {
              console.warn(`${tag}[points] cookie-exchange 失败: ${e.message || e}`);
            }
          } else {
            stopReason = 'session_expired';
            console.error(`${tag}[points] 刷新后仍 873，停止（需重新登录）`);
            break;
          }
        }
      } catch (e) {
        console.log(`${tag}[points] #${attempt} ERROR ${e.message || e}`);
      }

      if (!success && attempt < maxAttempts && intervalMs > 0) {
        await sleep(intervalMs);
      }
    }
  } finally {
    watchCtl.stopped = true;
    if (watchTask) {
      await watchTask.catch(() => {});
    }
  }

  return {
    success,
    attempts: attempt,
    elapsedMs: Date.now() - startedAt,
    stopReason,
    intervalMs,
  };
}

async function prepareAccount(job) {
  const { client, jar, logFile } = createClientFromUser(job);
  const { client: listClient } = createClientFromUser(job, { jar, silent: true });
  const account = {
    ...job,
    client,
    listClient,
    jar,
    logFile,
    /** 列表匹配用：固定为任务提交时的商品名，避免热切换后丢匹配键 */
    matchPrizeName: job.goodsName || null,
  };
  await warmupSession(account, { label: '启动预热' });
  await ensureXsrf(listClient, jar).catch(() => {});
  await refreshGoods(account).catch((e) => {
    console.warn(`${jobTag(account)}刷新商品失败: ${e.message || e}，仍按已保存 exchangeId 抢购`);
  });
  return account;
}

async function runPointsSeckill(job, options = {}) {
  const account = await prepareAccount(job);
  const tag = jobTag(account);
  const fireRange = resolveFireOffsetRange(options);
  const fireOffsetMs = sampleFireOffset(fireRange);
  const immediate = !!options.immediate;
  const warmupBeforeMs = options.warmupBeforeMs != null ? options.warmupBeforeMs : WARMUP_BEFORE_MS;
  const acquireWarmupMs = resolveAcquireWarmupMs(options);

  const baseAt = immediate ? resolveTestFireAt(options, nowMs()) : resolveDevStartAt(options, nowMs());
  const fireAt = baseAt + fireOffsetMs;
  const baseLabel = formatFireTime(baseAt).replace(/\.\d+$/, '');
  const waitLabel = `${account.mobile}/${account.goodsName || account.goodsId}`;

  console.log(
    `${tag}商品=${account.goodsName || account.goodsId} 角色=${account.roleName || account.roleId || '-'} 区服=${
      account.serverName || account.server || '-'
    }`
  );
  console.log(
    `${tag}${immediate ? '测试开火' : '开抢时间(.env)'} ${baseLabel} ${formatFireOffsetLabel(
      fireOffsetMs
    )} → ${formatFireTime(fireAt)}`
  );
  console.log(`${tag}日志 ${account.logFile}`);

  await calibrateClock(account.client, tag);

  if (!immediate) {
    const warmAt = baseAt - warmupBeforeMs;
    if (nowMs() < warmAt) {
      console.log(`${tag}等待开抢前预热（约 ${formatLeft(warmAt - nowMs())}）`);
      await waitUntilServer(warmAt, { label: `${waitLabel} 等待预热` });
    }
    if (nowMs() < fireAt) {
      await warmupSession(account, { label: '开抢前预热' });
      await refreshGoods(account).catch(() => {});
      await calibrateClock(account.client, tag);
    }
  }

  if (acquireWarmupMs > 0 && fireAt - nowMs() > acquireWarmupMs) {
    const warmFire = fireAt - acquireWarmupMs;
    if (nowMs() < warmFire) await waitUntilServer(warmFire, { label: `${waitLabel} 接口预热` });
    await fireLoop(account, { ...options, warmupAcquire: true, maxAttempts: 1, fireAt });
  }

  if (nowMs() < fireAt) {
    await waitUntilServer(fireAt, { label: `${waitLabel} 开抢` });
  }

  return fireLoop(account, { ...options, fireAt });
}

module.exports = {
  prepareAccount,
  runPointsSeckill,
  fireLoop,
  calibrateClock,
  waitUntilServer,
  formatLeft,
  jobTag,
  resolveFireOffsetRange,
  sampleFireOffset,
  formatFireOffsetLabel,
  resolveAcquireIntervalMs,
  resolveAcquireWarmupMs,
  resolveGoodsWatchIntervalMs,
  watchGoodsIdentity,
  resolveTestFireAt,
  resolveDevStartAt,
  resolveNextWholeMinuteFireAt,
  parseStartAt,
  WARMUP_BEFORE_MS,
  COUNTDOWN_LAST_MS,
};
