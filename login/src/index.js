const { BrowserLoginService } = require('./browserLogin');
const accountRepo = require('./accountRepo');

async function main() {
  const browserLogin = new BrowserLoginService();

  try {
    console.log('');
    console.log('==============================');
    console.log('   福利金登录（浏览器可视页）');
    console.log('==============================');
    console.log('');
    console.log('即将打开官方登录页。');
    console.log('请在浏览器中手动输入手机号、验证码；');
    console.log('若出现滑块风控，直接在该页面完成即可。');
    console.log('登录成功后，程序会自动保存用户信息并关闭窗口。');
    console.log('');

    const result = await browserLogin.waitForManualLogin({
      timeoutMs: 10 * 60 * 1000,
    });
    const saved = await accountRepo.upsertAccount(result.user);

    console.log('');
    console.log('登录完成，用户信息已写入 MySQL：');
    console.log(`  手机号:   ${saved.mobile}`);
    console.log(`  昵称:     ${saved.nickname}`);
    console.log(`  会员等级: ${saved.vipLevel}`);
    if (saved.uid) console.log(`  UID:      ${saved.uid}`);
    console.log('');
  } catch (e) {
    try {
      await browserLogin.close();
    } catch (_) {}
    console.error('');
    console.error('登录失败:', e.message || e);
    console.error('');
    console.error('备选：用抓包 Cookie 导入');
    console.error('  npm run import');
    console.error('');
    process.exitCode = 1;
  }
}

main();
