const db = require('./db');

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
    successCount: Number(row.success_count) || 0,
    loggedInAt: row.logged_in_at,
    updatedAt: row.updated_at,
  };
}

async function upsertAccount(user) {
  const mobile = String(user.mobile);
  const sql = `
    INSERT INTO accounts (
      mobile, nickname, vip_level, uid, god_uuid, device_id,
      cookies_json, cookie_header, vip_raw, self_raw, status, logged_in_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON DUPLICATE KEY UPDATE
      nickname = VALUES(nickname),
      vip_level = VALUES(vip_level),
      uid = VALUES(uid),
      god_uuid = VALUES(god_uuid),
      device_id = VALUES(device_id),
      cookies_json = VALUES(cookies_json),
      cookie_header = VALUES(cookie_header),
      vip_raw = VALUES(vip_raw),
      self_raw = VALUES(self_raw),
      status = 1,
      logged_in_at = VALUES(logged_in_at)
  `;
  await db.query(sql, [
    mobile,
    user.nickname || null,
    user.vipLevel || 'V1',
    user.uid || null,
    user.godUuid || null,
    user.deviceId || null,
    JSON.stringify(user.cookies || []),
    user.cookieHeader || null,
    user.vipRaw ? JSON.stringify(user.vipRaw) : null,
    user.selfRaw ? JSON.stringify(user.selfRaw) : null,
    user.loggedInAt ? new Date(user.loggedInAt) : new Date(),
  ]);
  return findByMobile(mobile);
}

async function findByMobile(mobile) {
  const rows = await db.query('SELECT * FROM accounts WHERE mobile = ? LIMIT 1', [
    String(mobile),
  ]);
  return rowToUser(rows[0]);
}

async function listActiveAccounts() {
  const rows = await db.query(
    'SELECT * FROM accounts WHERE status = 1 ORDER BY updated_at DESC'
  );
  return rows.map(rowToUser);
}

async function createLoginSession({ token, expiresAt }) {
  await db.query(
    `INSERT INTO login_sessions (token, status, expires_at) VALUES (?, 'pending', ?)`,
    [token, expiresAt]
  );
  return findLoginSession(token);
}

async function findLoginSession(token) {
  const rows = await db.query('SELECT * FROM login_sessions WHERE token = ? LIMIT 1', [
    token,
  ]);
  return rows[0] || null;
}

async function updateLoginSession(token, patch) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    params.push(v);
  }
  if (!fields.length) return findLoginSession(token);
  params.push(token);
  await db.query(`UPDATE login_sessions SET ${fields.join(', ')} WHERE token = ?`, params);
  return findLoginSession(token);
}

module.exports = {
  upsertAccount,
  findByMobile,
  listActiveAccounts,
  createLoginSession,
  findLoginSession,
  updateLoginSession,
  rowToUser,
};
