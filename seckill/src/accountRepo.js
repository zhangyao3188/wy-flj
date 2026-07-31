const db = require('./db');

function normalizeTargetCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 9999);
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
    /** 成功次数已达设定抢购次数 */
    completed: successCount >= targetCount,
    loggedInAt: row.logged_in_at,
    updatedAt: row.updated_at,
  };
}

async function findByMobile(mobile) {
  const rows = await db.query('SELECT * FROM accounts WHERE mobile = ? LIMIT 1', [
    String(mobile),
  ]);
  return rowToUser(rows[0]);
}

/**
 * 可用账号：启用中，且成功次数未达到设定抢购次数
 */
async function listActiveAccounts() {
  await ensureAccountColumns();
  const rows = await db.query(
    `SELECT * FROM accounts
     WHERE status = 1
       AND COALESCE(success_count, 0) < COALESCE(NULLIF(target_count, 0), 1)
     ORDER BY updated_at DESC`
  );
  return rows.map(rowToUser);
}

/** 刷新 cookie 后写回数据库，供下次抢购使用 */
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
 * 真实抢购成功 +1（received=true）；已领取不走此方法
 * @returns {Promise<number>} 更新后的成功次数
 */
async function incrementSuccessCount(mobile) {
  await ensureAccountColumns();
  await db.query(
    'UPDATE accounts SET success_count = COALESCE(success_count, 0) + 1 WHERE mobile = ?',
    [String(mobile)]
  );
  const user = await findByMobile(mobile);
  return user ? user.successCount : 0;
}

/** 启动时确保 success_count / target_count 列存在（兼容旧库） */
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
  ensuredColumns = true;
}

/** @deprecated 使用 ensureAccountColumns */
async function ensureSuccessCountColumn() {
  return ensureAccountColumns();
}

module.exports = {
  findByMobile,
  listActiveAccounts,
  updateCookies,
  updateVipLevel,
  incrementSuccessCount,
  ensureSuccessCountColumn,
  ensureAccountColumns,
  normalizeTargetCount,
  rowToUser,
};
