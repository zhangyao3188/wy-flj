/**
 * 从「账号信息接口」抓包文件快速导入 Cookie 并落盘用户信息
 * 用法: node src/importCapture.js [手机号]
 */
const fs = require('fs');
const path = require('path');
const { createSession } = require('./http');
const { LoginService } = require('./loginService');
const accountRepo = require('./accountRepo');

function parseCapture(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const cookies = {};
  const re = /^cookie:\s*([^=]+)=(.*)$/gim;
  let m;
  while ((m = re.exec(text))) {
    cookies[m[1].trim()] = m[2].trim();
  }
  // P_INFO 里可能带手机号
  let mobile = null;
  if (cookies.P_INFO) {
    const hit = String(cookies.P_INFO).match(/(1\d{10})/);
    if (hit) mobile = hit[1];
  }
  if (cookies.S_INFO) {
    const hit = String(cookies.S_INFO).match(/(1\d{10})/);
    if (hit) mobile = hit[1];
  }
  return { cookies, mobile };
}

async function main() {
  const capture =
    process.argv[3] ||
    path.resolve(__dirname, '../capture.txt');
  const parsed = parseCapture(capture);
  const mobile = process.argv[2] || parsed.mobile;
  if (!mobile) {
    throw new Error('未能解析手机号，请传入: node src/importCapture.js <手机号>');
  }
  if (!Object.keys(parsed.cookies).length) {
    throw new Error(`未从抓包文件解析到 cookie: ${capture}`);
  }

  console.log(`导入手机号=${mobile}, cookie数=${Object.keys(parsed.cookies).length}`);
  const session = createSession();
  const svc = new LoginService(session);
  const result = await svc.importCookies(mobile, parsed.cookies);
  const saved = await accountRepo.upsertAccount(result.user);
  console.log('导入成功（已写入 MySQL）:', {
    mobile: saved.mobile,
    nickname: saved.nickname,
    vipLevel: saved.vipLevel,
    uid: saved.uid,
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
