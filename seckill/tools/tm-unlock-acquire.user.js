// ==UserScript==
// @name         网易充值助手 - 福利金 showing-list 库存解禁
// @namespace    wy-flj-seckill
// @version      2.0.0
// @description  拦截 showing-list-v2 回参，把对应档位当前场次的 acquiredStatus/stockRemain 改成可领
// @match        https://pay.ds.163.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const LIST_PATH = '/v1/web/exp/week-coupon/showing-list-v2';
  /** 改成可领：有库存、未领取 */
  const PATCH_ACQUIRED = 'UN_ACQUIRED';
  const PATCH_REMAIN = 1;

  let enabled = true;
  let lastPatch = null;

  function isListUrl(url) {
    return String(url || '').indexOf(LIST_PATH) !== -1;
  }

  /**
   * 只改「对应档位」当前进行中场次：
   * 回参里带 acquiredStatus / stockRemain 的 PROGRESSING period（如 V1 的已抢光）
   */
  function patchListPayload(data) {
    if (!data || typeof data !== 'object') return { data, patched: 0 };
    const result = data.result || data.data;
    if (!result || !Array.isArray(result.coupons)) return { data, patched: 0 };

    let patched = 0;
    const details = [];

    for (const coupon of result.coupons) {
      const periods = coupon.periods || [];
      for (const p of periods) {
        if (String(p.status) !== 'PROGRESSING') continue;
        // 只有当前用户档位才会带 acquiredStatus / stockRemain（见回参.json V1）
        if (p.acquiredStatus == null && p.stockRemain == null) continue;

        const before = {
          xyLevel: coupon.xyLevel || coupon.name,
          acquiredStatus: p.acquiredStatus,
          stockRemain: p.stockRemain,
          stockId: p.stockId,
        };

        p.acquiredStatus = PATCH_ACQUIRED;
        p.stockRemain = PATCH_REMAIN;
        // 若缺 stockId，按官网规则补齐，方便页面领取
        if (!p.stockId && coupon.couponId && p.seckillStartTime) {
          p.stockId = coupon.couponId + '_WEEKLY_' + p.seckillStartTime;
        }

        patched += 1;
        details.push({
          before,
          after: {
            xyLevel: coupon.xyLevel || coupon.name,
            acquiredStatus: p.acquiredStatus,
            stockRemain: p.stockRemain,
            stockId: p.stockId,
          },
        });
      }
    }

    lastPatch = { at: new Date().toLocaleString('zh-CN', { hour12: false }), patched, details };
    return { data, patched };
  }

  function patchResponseText(text) {
    if (!enabled) return text;
    try {
      const json = JSON.parse(text);
      const { data, patched } = patchListPayload(json);
      if (patched > 0) {
        console.log('[wy-flj] showing-list 已改库存/状态', lastPatch);
        updatePanel();
      }
      return JSON.stringify(data);
    } catch (_) {
      return text;
    }
  }

  // ---- 劫持 fetch ----
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      const p = rawFetch.apply(this, arguments);
      if (!isListUrl(url)) return p;
      return p.then(function (res) {
        return res
          .clone()
          .text()
          .then(function (text) {
            const next = patchResponseText(text);
            return new Response(next, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            });
          });
      });
    };
  }

  // ---- 劫持 XHR ----
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__wyFljList = isListUrl(url);
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__wyFljList) {
      this.addEventListener('readystatechange', function () {
        if (this.readyState !== 4) return;
        if (!enabled) return;
        try {
          const next = patchResponseText(this.responseText);
          if (next === this.responseText) return;
          Object.defineProperty(this, 'responseText', { configurable: true, get: function () { return next; } });
          Object.defineProperty(this, 'response', { configurable: true, get: function () { return next; } });
        } catch (e) {
          console.warn('[wy-flj] XHR patch failed', e);
        }
      });
    }
    return XS.apply(this, arguments);
  };

  // ---- 简易面板 ----
  const PANEL_ID = 'wy-flj-tm-panel';

  function updatePanel() {
    const el = document.getElementById('wy-flj-out');
    const st = document.getElementById('wy-flj-count');
    if (st) st.textContent = enabled ? '改参开' : '改参关';
    if (el) {
      el.textContent = lastPatch
        ? JSON.stringify(lastPatch, null, 2)
        : '等待 showing-list-v2…刷新页面后生效';
    }
  }

  function ensurePanel() {
    if (!document.body || document.getElementById(PANEL_ID)) return;
    const box = document.createElement('div');
    box.id = PANEL_ID;
    box.innerHTML =
      '<style>' +
      '#' + PANEL_ID + '{position:fixed;right:12px;bottom:12px;z-index:2147483646;width:340px;max-height:50vh;overflow:auto;' +
      'background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);' +
      'font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
      '#' + PANEL_ID + ' .hd{display:flex;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #374151;cursor:move;user-select:none}' +
      '#' + PANEL_ID + ' .bd{padding:10px 12px}' +
      '#' + PANEL_ID + ' button{margin:0 6px 6px 0;padding:5px 10px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}' +
      '#' + PANEL_ID + ' button.secondary{background:#4b5563}' +
      '#' + PANEL_ID + ' .muted{color:#9ca3af}' +
      '#' + PANEL_ID + ' pre{white-space:pre-wrap;word-break:break-all;background:#0b1220;padding:8px;border-radius:6px;max-height:160px;overflow:auto}' +
      '</style>' +
      '<div class="hd"><b>福利金改参 v2.0</b><span class="muted" id="wy-flj-count">改参开</span></div>' +
      '<div class="bd">' +
      '<div class="muted">拦截 showing-list-v2：仅改对应档位 PROGRESSING 的 acquiredStatus→UN_ACQUIRED、stockRemain→1</div>' +
      '<button type="button" id="wy-flj-toggle">开关改参</button>' +
      '<button type="button" id="wy-flj-reload" class="secondary">刷新页面</button>' +
      '<button type="button" id="wy-flj-hide" class="secondary">收起</button>' +
      '<pre id="wy-flj-out">等待 showing-list-v2…刷新页面后生效</pre>' +
      '</div>';
    document.body.appendChild(box);

    document.getElementById('wy-flj-toggle').onclick = function () {
      enabled = !enabled;
      updatePanel();
    };
    document.getElementById('wy-flj-reload').onclick = function () {
      location.reload();
    };
    document.getElementById('wy-flj-hide').onclick = function () {
      const bd = box.querySelector('.bd');
      bd.style.display = bd.style.display === 'none' ? '' : 'none';
    };

    const hd = box.querySelector('.hd');
    let ox = 0;
    let oy = 0;
    let dragging = false;
    hd.addEventListener('mousedown', function (e) {
      dragging = true;
      const rect = box.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      box.style.left = Math.max(0, e.clientX - ox) + 'px';
      box.style.top = Math.max(0, e.clientY - oy) + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', function () {
      dragging = false;
    });
  }

  function bootPanel() {
    if (!document.body) {
      setTimeout(bootPanel, 50);
      return;
    }
    ensurePanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootPanel);
  } else {
    bootPanel();
  }
})();
