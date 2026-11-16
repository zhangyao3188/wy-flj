/**
 * 开抢前按任务分配优质代理：循环 get_ip → 网易接口质检 → 写入 account.proxyMeta / proxyAgent。
 * 质检接口：GET pay-api.ds.163.com/v1/web/init/server/time
 * 到达 deadline 后立刻停止；未分到的任务开火时直连。
 * 所有网络步骤均带超时，避免单 IP/单请求拖死整场。
 */
const axios = require('axios');
const { isRushProxyEnabled, getRushProxyConfig, fetchProxies } = require('./rushProxy');
const {
  createClientFromUser,
  jarToCookieList,
  jarToCookieHeader,
} = require('./client');

const NETEASE_PROBE_URL = 'https://pay-api.ds.163.com/v1/web/init/server/time';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
/** 提取代理单次最多占用的时间 */
const FETCH_BUDGET_MS = 6000;
/** 距截止少于此值不再开新一轮提取/质检 */
const MIN_REMAIN_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function unassignedAccounts(accounts) {
  return (accounts || []).filter((item) => item && !item.proxyAgent && !item.proxyMeta);
}

function formatProxyLog(proxy) {
  const base = `${proxy.ip}:${proxy.port}`;
  if (proxy.outIp) return `${base} out=${proxy.outIp}`;
  return base;
}

function accountLabel(account) {
  return `${account.mobile || '?'}/${account.vipLevel || account.forceVipLevel || '?'}`;
}

async function raceTimeout(promise, ms, label = 'timeout') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), Math.max(1, ms));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 经代理探测网易 server/time，仅作优质性判断（RTT）。
 * 到点立刻 AbortController 硬中断 + 销毁 agent，不等慢 IP 把响应拖回来再舍弃。
 */
async function qualityCheckProxy(proxy, qualityMaxMs) {
  const limit = Math.max(1, Number(qualityMaxMs) || 1500);
  const t0 = Date.now();
  const controller = new AbortController();
  let hardTimedOut = false;
  const timer = setTimeout(() => {
    hardTimedOut = true;
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
    // 立刻掐掉代理隧道/空闲连接，避免 axios timeout 在 HttpsProxyAgent 下“假超时”
    try {
      proxy.agent?.destroy?.();
    } catch {
      /* ignore */
    }
  }, limit);

  try {
    const res = await axios.get(NETEASE_PROBE_URL, {
      httpAgent: proxy.agent,
      httpsAgent: proxy.agent,
      proxy: false,
      timeout: limit,
      signal: controller.signal,
      validateStatus: () => true,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': UA,
        Origin: 'https://pay.ds.163.com',
        Referer: 'https://pay.ds.163.com/',
      },
    });
    const rttMs = Date.now() - t0;
    // 理论上不会走到这里（已 abort），兜底：超阈值仍判劣质
    if (hardTimedOut || rttMs > limit) {
      try {
        proxy.agent?.destroy?.();
      } catch {
        /* ignore */
      }
      return { ok: false, rttMs, error: `超时中止（>${limit}ms）` };
    }
    if (res.status >= 500) {
      return { ok: false, rttMs, error: `http ${res.status}` };
    }
    return { ok: true, rttMs, httpStatus: res.status };
  } catch (err) {
    const rttMs = Date.now() - t0;
    const timedOut =
      hardTimedOut ||
      controller.signal.aborted ||
      err.code === 'ECONNABORTED' ||
      err.name === 'CanceledError' ||
      err.name === 'AbortError' ||
      /timeout|aborted|canceled|cancelled/i.test(String(err.message || ''));
    if (timedOut) {
      try {
        proxy.agent?.destroy?.();
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      rttMs: Math.min(rttMs, limit),
      error: timedOut ? `超时中止（>${limit}ms）` : err.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把已质检通过的代理挂到 account，并重建走代理的 axios client。
 */
function applyProxyToAccount(account, proxy, qualityRttMs) {
  account.proxyAgent = proxy.agent;
  account.proxyMeta = {
    ip: proxy.ip,
    port: proxy.port,
    outIp: proxy.outIp || '',
    adr: proxy.adr || '',
    proxyUrl: proxy.proxyUrl,
    expireAt: proxy.expireAt,
    qualityRttMs,
    provider: proxy.provider || '',
  };

  const baseUser = account.user || { mobile: account.mobile };
  const user = {
    ...baseUser,
    mobile: account.mobile,
    godUuid: baseUser.godUuid,
    deviceId: baseUser.deviceId,
    cookies: jarToCookieList(account.jar),
    cookieHeader: jarToCookieHeader(account.jar),
    proxyUrl: proxy.proxyUrl,
    proxyAgent: proxy.agent,
  };

  const { client, jar, logFile } = createClientFromUser(user);
  account.client = client;
  account.jar = jar;
  if (logFile) account.logFile = logFile;
  account.user = { ...baseUser, ...user };
  account.preparedAcquire = undefined;
  return account;
}

/**
 * @param {object[]} accounts 已 prepare 的抢购任务（账号×等级）
 * @param {{ deadlineMs: number }} options 绝对时间戳；到点必须返回，未分到直连
 */
async function allocateRushProxies(accounts, options = {}) {
  const config = getRushProxyConfig();
  if (!config.enabled) {
    console.log('[rush-proxy] 已关闭（RUSH_PROXY_ENABLED≠1），全部直连');
    return { enabled: false, assigned: 0, remaining: (accounts || []).length };
  }

  const list = Array.isArray(accounts) ? accounts : [];
  if (!list.length) {
    return { enabled: true, assigned: 0, remaining: 0 };
  }

  const deadlineMs = Number(options.deadlineMs);
  if (!Number.isFinite(deadlineMs)) {
    throw new Error('allocateRushProxies 需要 deadlineMs');
  }

  console.log(
    `[rush-proxy] 开始分配：待抢 ${list.length} 任务，质检≤${config.qualityMaxMs}ms（网易 server/time），` +
      `截止 ${new Date(deadlineMs).toLocaleString('zh-CN', { hour12: false })}（未分到则直连）`
  );

  let round = 0;
  let stoppedByDeadline = false;

  while (Date.now() < deadlineMs) {
    const pending = unassignedAccounts(list);
    if (!pending.length) break;

    const remainMs = deadlineMs - Date.now();
    if (remainMs < MIN_REMAIN_MS) {
      stoppedByDeadline = true;
      break;
    }

    round += 1;
    const need = pending.length;
    const fetchBudget = Math.min(FETCH_BUDGET_MS, Math.max(500, remainMs - 200));
    console.log(
      `[rush-proxy] 第 ${round} 轮：待分配 ${need}，本轮提取 ${need}，剩余窗 ${Math.round(remainMs / 1000)}s（提取预算 ${fetchBudget}ms）`
    );

    let proxies = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      proxies = await fetchProxies(need, { timeoutMs: fetchBudget });
    } catch (err) {
      console.warn(`[rush-proxy] 提取失败/超时: ${err.message}，短暂重试`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(400, Math.max(0, deadlineMs - Date.now())));
      continue;
    }

    if (Date.now() >= deadlineMs) {
      stoppedByDeadline = true;
      for (const p of proxies) {
        try {
          p.agent.destroy?.();
        } catch {
          /* ignore */
        }
      }
      break;
    }

    if (!proxies.length) {
      console.warn('[rush-proxy] 本轮未拿到代理，短暂重试');
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(400, Math.max(0, deadlineMs - Date.now())));
      continue;
    }

    // 质检并行，单次超时再被 deadline 收紧，避免串行拖死
    const qualityBudget = Math.min(
      config.qualityMaxMs,
      Math.max(200, deadlineMs - Date.now() - 100)
    );
    // eslint-disable-next-line no-await-in-loop
    const checks = await Promise.all(
      proxies.map(async (proxy) => {
        if (Date.now() >= deadlineMs) {
          return { proxy, check: { ok: false, rttMs: 0, error: 'deadline' } };
        }
        try {
          // 外层再卡一道：质检内部已在 qualityBudget 时 abort；这里最多多等 50ms 兜底
          const check = await raceTimeout(
            qualityCheckProxy(proxy, qualityBudget),
            qualityBudget + 50,
            'quality-timeout'
          );
          return { proxy, check };
        } catch (err) {
          try {
            proxy.agent?.destroy?.();
          } catch {
            /* ignore */
          }
          return {
            proxy,
            check: {
              ok: false,
              rttMs: qualityBudget,
              error: `超时中止（>${qualityBudget}ms）`,
            },
          };
        }
      })
    );

    if (Date.now() >= deadlineMs) stoppedByDeadline = true;

    let good = 0;
    let bad = 0;
    for (const { proxy, check } of checks) {
      if (Date.now() >= deadlineMs) {
        stoppedByDeadline = true;
        try {
          proxy.agent.destroy?.();
        } catch {
          /* ignore */
        }
        continue;
      }
      const target = unassignedAccounts(list)[0];
      if (!target) {
        try {
          proxy.agent.destroy?.();
        } catch {
          /* ignore */
        }
        continue;
      }
      if (!check.ok) {
        bad += 1;
        console.warn(
          `[rush-proxy] 劣质 ${formatProxyLog(proxy)} rtt=${check.rttMs}ms (${check.error})，舍弃`
        );
        try {
          proxy.agent.destroy?.();
        } catch {
          /* ignore */
        }
        continue;
      }
      applyProxyToAccount(target, proxy, check.rttMs);
      good += 1;
      console.log(
        `[rush-proxy] 优质 ${formatProxyLog(proxy)} rtt=${check.rttMs}ms → ${accountLabel(target)}`
      );
    }

    const left = unassignedAccounts(list).length;
    console.log(`[rush-proxy] 第 ${round} 轮结束：优质 ${good}，劣质 ${bad}，未分配 ${left}`);
    if (stoppedByDeadline) break;
  }

  const remaining = unassignedAccounts(list).length;
  const assigned = list.length - remaining;
  if (remaining) {
    console.warn(
      `[rush-proxy] 分配结束${stoppedByDeadline || Date.now() >= deadlineMs ? '（已到截止）' : ''}，` +
        `已分配 ${assigned}，仍直连 ${remaining} 任务`
    );
  } else {
    console.log(`[rush-proxy] 全部分配完成 ${assigned}/${assigned}`);
  }

  return {
    enabled: true,
    assigned,
    remaining,
    rounds: round,
    stoppedByDeadline: stoppedByDeadline || Date.now() >= deadlineMs,
  };
}

module.exports = {
  allocateRushProxies,
  applyProxyToAccount,
  qualityCheckProxy,
  unassignedAccounts,
  isRushProxyEnabled,
};
