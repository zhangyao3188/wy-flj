/**
 * 从「账号信息接口」抓包文件 / curl 快速导入 Cookie 并落盘
 * 用法:
 *   node src/importCapture.js [手机号] [文件路径]
 *   node src/importCapture.js 13800138000 ./capture.txt
 */
const fs = require('fs');
const path = require('path');
const { createSession } = require('./http');
const { LoginService } = require('./loginService');
const accountRepo = require('./accountRepo');
const { parseCurlOrCookies } = require('./parseCurl');

async function main() {
  const capture =
    process.argv[3] || path.resolve(__dirname, '../capture.txt');
  if (!fs.existsSync(capture)) {
    throw new Error(`抓包文件不存在: ${capture}`);
  }
  const text = fs.readFileSync(capture, 'utf8');
  const parsed = parseCurlOrCookies(text);
  const mobile = process.argv[2] || parsed.mobile;
  if (!mobile || !/^1\d{10}$/.test(String(mobile))) {
    throw new Error('未能解析手机号，请传入: node src/importCapture.js <手机号> [文件]');
  }
  if (!parsed.cookieCount) {
    throw new Error(`未从抓包文件解析到 cookie: ${capture}`);
  }

  console.log(`导入手机号=${mobile}, cookie数=${parsed.cookieCount}`);
  const session = createSession();
  const svc = new LoginService(session);
  const result = await svc.importCookies(mobile, parsed.cookies, {
    headers: parsed.headers,
  });
  const saved = await accountRepo.upsertAccount(result.user);
  console.log('导入成功（已写入 MySQL）:', {
    mobile: saved.mobile,
    nickname: saved.nickname,
    actAccount: saved.actAccount,
    vipLevel: saved.vipLevel,
    uid: saved.uid,
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
