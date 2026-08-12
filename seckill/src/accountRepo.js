const db = require('./db');

function normalizeTargetCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 9999);
}

function normalizeVipLevel(value) {
  const s = String(value || '')
    .trim()
    .toUpperCase();
  const m = s.match(/^V?(\d{1,2})$/);
  if (m) return `V${Number(m[1])}`;
  if (/^V\d+$/.test(s)) return s;
  return null;
}

function levelRank(lv) {
  const m = String(lv || '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** 上海时区当日 [start, end) */
function chinaDayRange(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const day = fmt.format(date);
  const start = new Date(`${day}T00:00:00+08:00`);
  const end = new Date(`${day}T00:00:00+08:00`);
  end.setDate(end.getDate() + 1);
  return { day, start, end };
}

function rowToLevel(row) {
  if (!row) return null;
  const successCount = Number(row.success_count) || 0;
  const targetCount = normalizeTargetCount(row.target_count);
  return {
    id: row.id,
    accountId: row.account_id,
    mobile: row.mobile,
    vipLevel: row.vip_level,
    successCount,
    targetCount,
    completed: successCount >= targetCount,
    lastSuccessAt: row.last_success_at || null,
  };
}

function rowToUser(row) {
  if (!row) return null;
  let cookies = [];
  try {
    cookies = row.cookies_json ? JSON.parse(row.cookies_json) : [];
  } catch (_) {
    cookies = [];
  }
  let vipRaw = null;
  let selfRaw = null;
  try {
    vipRaw = row.vip_raw ? JSON.parse(row.vip_raw) : null;
  } catch (_) {}
  try {
    selfRaw = row.self_raw ? JSON.parse(row.self_raw) : null;
  } catch (_) {}

  const successCount = Number(row.success_count) || 0;
  const targetCount = normalizeTargetCount(row.target_count);
  return {
    id: row.id,
    mobile: row.mobile,
    nickname: row.nickname,
    actAccount: row.act_account || null,
    vipLevel: row.vip_level,
    uid: row.uid,
    godUuid: row.god_uuid,
    deviceId: row.device_id,
    cookies,
    cookieHeader: row.cookie_header,
    vipRaw,
    selfRaw,
    status: row.status,
    successCount,
    targetCount,
    completed: successCount >= targetCount,
    levelId: row._levelId != null ? row._levelId : null,
    lastSuccessAt: row.last_success_at || null,
    loggedInAt: row.logged_in_at,
    updatedAt: row.updated_at,
  };
}

async function findByMobile(mobile) {
  await ensureAccountColumns();
  const rows = await db.query('SELECT * FROM accounts WHERE mobile = ? LIMIT 1', [
    String(mobile),
  ]);
  return rowToUser(rows[0]);
}

/** 全部账号（含禁用），用于批量同步资料 */
async function listAllAccounts() {
  await ensureAccountColumns();
  const rows = await db.query(`SELECT * FROM accounts ORDER BY updated_at DESC`);
  return rows.map(rowToUser);
}

async function updateActAccount(mobile, actAccount) {
  await ensureAccountColumns();
  const value =
    actAccount != null && String(actAccount).trim()
      ? String(actAccount).trim().slice(0, 128)
      : null;
  await db.query(`UPDATE accounts SET act_account = ? WHERE mobile = ?`, [
    value,
    String(mobile),
  ]);
  return findByMobile(mobile);
}

async function listLevelsByMobile(mobile) {
  await ensureAccountColumns();
  try {
    const rows = await db.query(
      `SELECT * FROM account_seckill_levels WHERE mobile = ? ORDER BY vip_level ASC`,
      [String(mobile)]
    );
    return rows.map(rowToLevel).sort((a, b) => levelRank(a.vipLevel) - levelRank(b.vipLevel));
  } catch (_) {
    return [];
  }
}

/**
 * 抢购任务列表：每个「账号×等级」一条；未完成才返回
 */
async function listSeckillJobs() {
  await ensureAccountColumns();
  const accounts = await db.query(
    `SELECT * FROM accounts WHERE status = 1 ORDER BY updated_at DESC`
  );
  const jobs = [];
  for (const row of accounts) {
    const user = rowToUser(row);
    let levels = await listLevelsByMobile(user.mobile);
    if (!levels.length) {
      levels = [
        {
          id: null,
          accountId: user.id,
          mobile: user.mobile,
          vipLevel: user.vipLevel || 'V1',
          successCount: user.successCount || 0,
          targetCount: user.targetCount || 1,
          completed: (user.successCount || 0) >= (user.targetCount || 1),
        },
      ];
    }
    for (const lv of levels) {
      if (lv.completed) continue;
      jobs.push({
        ...user,
        vipLevel: lv.vipLevel,
        forceVipLevel: lv.vipLevel,
        levelId: lv.id,
        successCount: lv.successCount,
        targetCount: lv.targetCount,
        completed: false,
        maxVipLevel: user.vipLevel,
      });
    }
  }
  return jobs;
}

/** @deprecated 兼容：返回未展开账号；抢购请用 listSeckillJobs */
async function listActiveAccounts() {
  return listSeckillJobs();
}

async function updateCookies(mobile, { cookies, cookieHeader, godUuid, deviceId, vipLevel, vipRaw } = {}) {
  const fields = [];
  const params = [];
  if (cookies != null) {
    fields.push('cookies_json = ?');
    params.push(JSON.stringify(cookies));
  }
  if (cookieHeader != null) {
    fields.push('cookie_header = ?');
    params.push(cookieHeader);
  }
  if (godUuid) {
    fields.push('god_uuid = ?');
    params.push(godUuid);
  }
  if (deviceId) {
    fields.push('device_id = ?');
    params.push(deviceId);
  }
  if (vipLevel) {
    fields.push('vip_level = ?');
    params.push(String(vipLevel));
  }
  if (vipRaw != null) {
    fields.push('vip_raw = ?');
    params.push(typeof vipRaw === 'string' ? vipRaw : JSON.stringify(vipRaw));
  }
  if (!fields.length) return findByMobile(mobile);
  params.push(String(mobile));
  await db.query(`UPDATE accounts SET ${fields.join(', ')} WHERE mobile = ?`, params);
  return findByMobile(mobile);
}

async function updateVipLevel(mobile, vipLevel, vipRaw = null) {
  return updateCookies(mobile, { vipLevel, vipRaw });
}

/**
 * 真实抢购成功 +1（按等级；无等级表则回退账号表），并写入当日成功日志
 * @param {string|null} mobile
 * @param {string|null} vipLevel
 * @param {{ accountId?: number, couponId?: string, stockId?: string }} [meta]
 */
async function incrementSuccessCount(mobile, vipLevel = null, meta = {}) {
  await ensureAccountColumns();
  const level = normalizeVipLevel(vipLevel);
  const now = new Date();
  let successCount = 0;
  let accountId = meta.accountId != null ? Number(meta.accountId) : null;

  if (level) {
    try {
      let r = null;
      if (mobile) {
        r = await db.query(
          `UPDATE account_seckill_levels
           SET success_count = COALESCE(success_count, 0) + 1,
               last_success_at = ?
           WHERE mobile = ? AND vip_level = ?`,
          [now, String(mobile), level]
        );
      }
      if ((!r || !r.affectedRows) && accountId) {
        r = await db.query(
          `UPDATE account_seckill_levels
           SET success_count = COALESCE(success_count, 0) + 1,
               last_success_at = ?
           WHERE account_id = ? AND vip_level = ?`,
          [now, accountId, level]
        );
      }
      if (r && r.affectedRows) {
        const rows = mobile
          ? await db.query(
              `SELECT success_count, account_id FROM account_seckill_levels WHERE mobile = ? AND vip_level = ? LIMIT 1`,
              [String(mobile), level]
            )
          : await db.query(
              `SELECT success_count, account_id FROM account_seckill_levels WHERE account_id = ? AND vip_level = ? LIMIT 1`,
              [accountId, level]
            );
        successCount = Number(rows[0] && rows[0].success_count) || 0;
        if (!accountId && rows[0] && rows[0].account_id) {
          accountId = Number(rows[0].account_id);
        }
      }
    } catch (_) {
      // fall through
    }
  }

  if (!successCount) {
    if (mobile) {
      await db.query(
        `UPDATE accounts
         SET success_count = COALESCE(success_count, 0) + 1,
             last_success_at = ?
         WHERE mobile = ?`,
        [now, String(mobile)]
      );
      const user = await findByMobile(mobile);
      successCount = user ? user.successCount : 0;
      if (!accountId && user) accountId = user.id;
    } else if (accountId) {
      await db.query(
        `UPDATE accounts
         SET success_count = COALESCE(success_count, 0) + 1,
             last_success_at = ?
         WHERE id = ?`,
        [now, accountId]
      );
      const rows = await db.query(
        `SELECT success_count FROM accounts WHERE id = ? LIMIT 1`,
        [accountId]
      );
      successCount = Number(rows[0] && rows[0].success_count) || 0;
    }
  } else if (mobile || accountId) {
    // 等级表已 +1 时，同步账号最近成功时间
    if (mobile) {
      await db.query(`UPDATE accounts SET last_success_at = ? WHERE mobile = ?`, [
        now,
        String(mobile),
      ]).catch(() => {});
    }
    if (accountId) {
      await db.query(`UPDATE accounts SET last_success_at = ? WHERE id = ?`, [
        now,
        accountId,
      ]).catch(() => {});
    }
  }

  try {
    await db.query(
      `INSERT INTO seckill_success_logs
        (account_id, mobile, vip_level, coupon_id, stock_id, success_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed')`,
      [
        accountId || null,
        mobile ? String(mobile) : null,
        level || null,
        meta.couponId ? String(meta.couponId).slice(0, 128) : null,
        meta.stockId ? String(meta.stockId).slice(0, 256) : null,
        now,
      ]
    );
  } catch (e) {
    console.warn(`[accountRepo] 写入成功日志失败: ${e.message || e}`);
  }

  return successCount;
}

/**
 * 疑似成功（809 已领取过本轮福利金）：不写 success_count，仅记入当日成功日志
 * @returns {Promise<boolean>} 是否新写入
 */
async function recordSuspectedSuccess(mobile, vipLevel = null, meta = {}) {
  await ensureAccountColumns();
  const level = normalizeVipLevel(vipLevel);
  const now = new Date();
  let accountId = meta.accountId != null ? Number(meta.accountId) : null;
  if (!accountId && mobile) {
    const user = await findByMobile(mobile);
    if (user) accountId = user.id;
  }

  const { start, end } = chinaDayRange();
  try {
    const dupSql = accountId
      ? `SELECT id FROM seckill_success_logs
         WHERE account_id = ? AND vip_level <=> ? AND kind = 'suspected'
           AND success_at >= ? AND success_at < ? LIMIT 1`
      : `SELECT id FROM seckill_success_logs
         WHERE mobile = ? AND vip_level <=> ? AND kind = 'suspected'
           AND success_at >= ? AND success_at < ? LIMIT 1`;
    const dupParams = accountId
      ? [accountId, level || null, start, end]
      : [String(mobile), level || null, start, end];
    const existing = await db.query(dupSql, dupParams);
    if (existing.length) return false;
  } catch (_) {}

  try {
    await db.query(
      `INSERT INTO seckill_success_logs
        (account_id, mobile, vip_level, coupon_id, stock_id, success_at, kind, note)
       VALUES (?, ?, ?, ?, ?, ?, 'suspected', ?)`,
      [
        accountId || null,
        mobile ? String(mobile) : null,
        level || null,
        meta.couponId ? String(meta.couponId).slice(0, 128) : null,
        meta.stockId ? String(meta.stockId).slice(0, 256) : null,
        now,
        meta.errmsg ? String(meta.errmsg).slice(0, 256) : '809 已领取过本轮福利金',
      ]
    );
    return true;
  } catch (e) {
    console.warn(`[accountRepo] 写入疑似成功日志失败: ${e.message || e}`);
    return false;
  }
}

let ensuredColumns = false;
async function ensureAccountColumns() {
  if (ensuredColumns) return;
  try {
    await db.query(
      `ALTER TABLE accounts ADD COLUMN success_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '真实抢购成功次数（不含已领取）' AFTER status`
    );
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      // ignore
    }
  }
  try {
    await db.query(
      `ALTER TABLE accounts ADD COLUMN target_count INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '设定的抢购次数' AFTER success_count`
    );
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      // ignore
    }
  }
  try {
    await db.query(
      `ALTER TABLE accounts ADD COLUMN act_account VARCHAR(128) NULL COMMENT '账户名称 actInfo.actAccount' AFTER nickname`
    );
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      // ignore
    }
  }
  try {
    await db.query(
      `ALTER TABLE accounts ADD COLUMN last_success_at DATETIME NULL COMMENT '最近一次真实抢购成功时间' AFTER target_count`
    );
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      // ignore
    }
  }
  try {
    await db.query(`
CREATE TABLE IF NOT EXISTS account_seckill_levels (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  mobile VARCHAR(20) NOT NULL,
  vip_level VARCHAR(16) NOT NULL,
  target_count INT UNSIGNED NOT NULL DEFAULT 1,
  success_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_success_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_mobile_level (mobile, vip_level),
  KEY idx_account_id (account_id),
  KEY idx_mobile (mobile)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (_) {}
  try {
    await db.query(
      `ALTER TABLE account_seckill_levels ADD COLUMN last_success_at DATETIME NULL COMMENT '该等级最近一次真实抢购成功时间' AFTER success_count`
    );
  } catch (e) {
    if (!/Duplicate column/i.test(e.message || '')) {
      // ignore
    }
  }
  try {
    await db.query(`
CREATE TABLE IF NOT EXISTS seckill_success_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NULL,
  mobile VARCHAR(20) NULL,
  vip_level VARCHAR(16) NULL,
  coupon_id VARCHAR(128) NULL,
  stock_id VARCHAR(256) NULL,
  success_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind VARCHAR(16) NOT NULL DEFAULT 'confirmed' COMMENT 'confirmed=真实成功 suspected=疑似成功(809)',
  note VARCHAR(256) NULL COMMENT '疑似成功说明',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_success_at (success_at),
  KEY idx_account_id (account_id),
  KEY idx_mobile (mobile),
  KEY idx_kind (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (_) {}
  try {
    await db.query(
      `ALTER TABLE seckill_success_logs ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'confirmed' COMMENT 'confirmed=真实成功 suspected=疑似成功(809)' AFTER success_at`
    );
  } catch (_) {}
  try {
    await db.query(
      `ALTER TABLE seckill_success_logs ADD COLUMN note VARCHAR(256) NULL COMMENT '疑似成功说明' AFTER kind`
    );
  } catch (_) {}
  try {
    await db.query(`
      INSERT INTO account_seckill_levels (account_id, mobile, vip_level, target_count, success_count)
      SELECT a.id,
             COALESCE(NULLIF(a.mobile, ''), CONCAT('#', a.id)),
             a.vip_level,
             COALESCE(NULLIF(a.target_count, 0), 1),
             COALESCE(a.success_count, 0)
      FROM accounts a
      WHERE NOT EXISTS (
        SELECT 1 FROM account_seckill_levels l WHERE l.account_id = a.id
      )
    `);
  } catch (_) {}
  ensuredColumns = true;
}

async function ensureSuccessCountColumn() {
  return ensureAccountColumns();
}

module.exports = {
  findByMobile,
  listAllAccounts,
  listActiveAccounts,
  listSeckillJobs,
  listLevelsByMobile,
  updateCookies,
  updateVipLevel,
  updateActAccount,
  incrementSuccessCount,
  recordSuspectedSuccess,
  ensureSuccessCountColumn,
  ensureAccountColumns,
  normalizeTargetCount,
  normalizeVipLevel,
  rowToUser,
};
