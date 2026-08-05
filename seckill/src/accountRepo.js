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
 * 真实抢购成功 +1（按等级；无等级表则回退账号表）
 */
async function incrementSuccessCount(mobile, vipLevel = null) {
  await ensureAccountColumns();
  const level = normalizeVipLevel(vipLevel);
  if (level) {
    try {
      const r = await db.query(
        `UPDATE account_seckill_levels
         SET success_count = COALESCE(success_count, 0) + 1
         WHERE mobile = ? AND vip_level = ?`,
        [String(mobile), level]
      );
      if (r && r.affectedRows) {
        const rows = await db.query(
          `SELECT success_count FROM account_seckill_levels WHERE mobile = ? AND vip_level = ? LIMIT 1`,
          [String(mobile), level]
        );
        return Number(rows[0] && rows[0].success_count) || 0;
      }
    } catch (_) {
      // fall through
    }
  }
  await db.query(
    'UPDATE accounts SET success_count = COALESCE(success_count, 0) + 1 WHERE mobile = ?',
    [String(mobile)]
  );
  const user = await findByMobile(mobile);
  return user ? user.successCount : 0;
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
    await db.query(`
CREATE TABLE IF NOT EXISTS account_seckill_levels (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  mobile VARCHAR(20) NOT NULL,
  vip_level VARCHAR(16) NOT NULL,
  target_count INT UNSIGNED NOT NULL DEFAULT 1,
  success_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_mobile_level (mobile, vip_level),
  KEY idx_account_id (account_id),
  KEY idx_mobile (mobile)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (_) {}
  try {
    await db.query(`
      INSERT INTO account_seckill_levels (account_id, mobile, vip_level, target_count, success_count)
      SELECT a.id, a.mobile, a.vip_level,
             COALESCE(NULLIF(a.target_count, 0), 1),
             COALESCE(a.success_count, 0)
      FROM accounts a
      WHERE NOT EXISTS (
        SELECT 1 FROM account_seckill_levels l WHERE l.mobile = a.mobile
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
  ensureSuccessCountColumn,
  ensureAccountColumns,
  normalizeTargetCount,
  normalizeVipLevel,
  rowToUser,
};
