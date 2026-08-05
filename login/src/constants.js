/** 与 pay.ds.163.com 前端一致的常量 */
module.exports = {
  PAY_ORIGIN: 'https://pay.ds.163.com',
  PAY_API: 'https://pay-api.ds.163.com',
  PAYMS: 'https://payms.ds.163.com',
  INF: 'https://inf.ds.163.com',
  INF_ACT: 'https://inf-act.ds.163.com',
  GOD_EXP: 'https://god-exp.gameyw.netease.com',

  /** UniSDK / 渠道登录 */
  UNISDK_APPID: 'aecfvm3qy4aaaama-g-ds02',
  JF_GAMEID: 'a19',
  URS_PRODUCT: 'godlike_recharge',

  /** URS / 手机号登录相关 */
  URS_HOST: 'https://dl.reg.163.com',
  MPAY_HOST: 'https://mpay-web.g.mkey.163.com',
  SERVICE_MKEY: 'https://service.mkey.163.com',

  /** 活动 actInfo（取 actAccount / currentTime） */
  ACT_ID: process.env.ACT_ID || '656d6d6b6085e70001ac05df',

  UA: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
};
