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

async function listActiveAccounts() {
  const rows = await db.query(
    'SELECT * FROM accounts WHERE status = 1 ORDER BY updated_at DESC'
  );
  return rows.map(rowToUser);
}

/** 刷新 cookie 后写回数据库，供下次抢购使用 */
async function updateCookies(mobile, { cookies, cookieHeader, godUuid, deviceId } = {}) {
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
  if (!fields.length) return findByMobile(mobile);
  params.push(String(mobile));
  await db.query(`UPDATE accounts SET ${fields.join(', ')} WHERE mobile = ?`, params);
  return findByMobile(mobile);
}

module.exports = {
  findByMobile,
  listActiveAccounts,
  updateCookies,
  rowToUser,
};
