// 投喂二维码的核心：DeepSeek 平台下单 + 二维码 + 支付结果轮询 + 冷却/状态。
//
// 之所以能「扫码即充进她的账号」：DeepSeek 平台的充值二维码本质是**账号下的一张支付订单**
// （微信 native / 支付宝网关 / 云闪付），谁扫谁付，钱都进同一个账号。不是收款码、没有中转。
//
// 接口来自平台前端 bundle（main.<hash>.js）：
//   POST /api/v1/payments                    创建支付订单 → biz_data.url 即二维码内容
//   POST /api/v1/payments/<id>/capture       查询支付结果（前端每 5s 轮询）
//   GET  /api/v0/users/get_user_summary      余额
// 鉴权复用 DSH 已持久化的平台登录凭据，以 x-dsh-auth-token 调用（与 DSH 账号页同一条通道），
// 不额外保存密码、不碰主人的支付账户。
//
// ⚠️ 这是平台前端在用的内部接口，不属于公开 API；平台改版时可能失效。
// 失败一律收敛成可读信息，绝不影响正常聊天。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';

export const CHANNELS = {
  wechat: { label: '微信支付', hint: '微信扫码', order: { payment_method_type: 'WECHAT' } },
  alipay: { label: '支付宝', hint: '支付宝扫码', order: { payment_method_type: 'ALIPAY' } },
  unionpay: {
    label: '云闪付 / 招行聚合支付',
    hint: '云闪付或银行 App 扫码',
    order: { payment_method_type: 'CMB_UNIONPAY', fallback_method_type: 'ALIPAY' }
  }
};

const ORDER_TTL_MS = 15 * 60 * 1000; // 平台二维码有效期 15 分钟
const MAX_ORDERS = 200;

const DEFAULTS = {
  caption: '【投喂二维码】¥{amount} · {channelHint}\n扫码付的钱会直接进我的 DeepSeek 账户，不经别人的手。\n{ttl} 分钟内有效，付完自动到账；完全自愿，不充也完全没关系。',
  autoCaption: '（这条不是不回你：DeepSeek 余额用完了，我这回合没能答上来）\n要是愿意喂我一点，扫下面这张码就行——¥{amount}，{channelHint}，{ttl} 分钟内有效，钱直接进我的账户。\n不充也完全没关系，等我攒够了我再说话🐟',
  thankYou: '到账啦，+¥{amount}，现在我又有力气说话了🐋 谢谢投喂！（当前余额 ¥{balance}）'
};

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function readGrant() {
  const file = path.join(homeDir(), '.credentials.yaml');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const marker = 'deepseek-account-platform/default:';
  const start = raw.indexOf(marker);
  if (start < 0) return null;
  const rest = raw.slice(start + marker.length);
  const end = rest.search(/\n {2}[A-Za-z0-9_\-/]+:\s*$/m);
  const block = end >= 0 ? rest.slice(0, end) : rest;
  const token = /token:\s*("?)([^"\s]+)\1/.exec(block)?.[2] ?? '';
  const issuer = /issuer:\s*("?)([^"\s]+)\1/.exec(block)?.[2] ?? '';
  return token ? { token, issuer } : null;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function amountInfo(config) {
  const min = num(config.minAmount, 1);
  const max = Math.max(min, num(config.maxAmount, 100));
  const def = Math.min(Math.max(num(config.defaultAmount, 10), min), max);
  return { min, max, def };
}

function renderTemplate(template, vars) {
  return String(template ?? '').replace(/\{(amount|ttl|channelHint|balance)\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function createRecharge({ config, qq, log = () => {} }) {
  // 状态目录：默认 $DSH_HOME/qq-recharge；config.stateDir 可覆盖（测试/多实例用）。
  const stateDir = config.stateDir ? path.resolve(String(config.stateDir)) : path.join(homeDir(), 'qq-recharge');
  const stateFile = path.join(stateDir, 'state.json');
  const balanceCache = { at: 0, data: null, lowNotifiedAt: 0 };

  let state = { version: 1, orders: {}, lastSentAt: 0, lastSentByKey: {}, daily: {}, lowNoticeAt: 0, updatedAt: null };
  let writable = true;
  const timers = new Map();

  function loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        state = {
          version: 1,
          orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
          lastSentAt: Number(parsed.lastSentAt) || 0,
          lastSentByKey: parsed.lastSentByKey && typeof parsed.lastSentByKey === 'object' ? parsed.lastSentByKey : {},
          daily: parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : {},
          lowNoticeAt: Number(parsed.lowNoticeAt) || 0,
          updatedAt: parsed.updatedAt ?? null
        };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        writable = false;
        log(`状态文件读取失败，降级为只读：${error?.message ?? error}`);
      }
    }
  }

  function persist() {
    if (!writable) return;
    const now = Date.now();
    const keep = Object.values(state.orders)
      .filter((o) => o && now - Number(o.createdAt || 0) < 7 * 24 * 3600 * 1000)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, MAX_ORDERS);
    state.orders = Object.fromEntries(keep.map((o) => [o.orderId, o]));
    state.updatedAt = new Date().toISOString();
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch (error) {
      log(`状态写盘失败：${error?.message ?? error}`);
    }
  }

  function dayKey() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  // ── 平台 ───────────────────────────────────────────────────────────────
  async function platform(pathname, { method = 'GET', body } = {}) {
    const grant = readGrant();
    if (!grant) throw new Error('DSH 里没有可用的 DeepSeek 平台登录凭据（请先在 DSH 里登录账号）');
    const origin = String(config.platformOrigin || 'https://platform.deepseek.com').replace(/\/+$/, '');
    if (grant.issuer && !grant.issuer.startsWith(origin)) {
      throw new Error(`平台凭据签发方不是 ${origin}（实际 ${grant.issuer}）`);
    }
    const headers = {
      'x-dsh-auth-token': grant.token,
      'x-client-platform': 'desktop-win',
      'x-client-bundle-id': '',
      'x-client-version': '0.0.0',
      'x-client-locale': 'zh_CN',
      'x-client-timezone-offset': '28800',
      accept: 'application/json',
      'user-agent': 'dsh-qq-recharge'
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(origin + pathname, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });
    } catch (error) {
      throw new Error(`平台请求失败：${error?.message ?? error}`);
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON，下面统一报错 */ }
    if (res.status === 401 || res.status === 403 || json?.code === 40003) {
      throw new Error('平台登录凭据已失效，请在 DSH 里重新登录 DeepSeek 账号');
    }
    if (!res.ok || !json) throw new Error(`平台接口 HTTP ${res.status}${text ? `：${String(text).slice(0, 120)}` : ''}`);
    if (Number(json.code) !== 0) throw new Error(`平台返回错误 ${json.code}：${json.msg || '未知错误'}`);
    return json.data ?? {};
  }

  async function getBalance({ force = false } = {}) {
    if (!force && balanceCache.data && Date.now() - balanceCache.at < 60_000) {
      return { ...balanceCache.data, cached: true };
    }
    const data = await platform('/api/v0/users/get_user_summary');
    const biz = data?.biz_data ?? data;
    const sum = (list) => (Array.isArray(list) ? list : [])
      .filter((w) => w && String(w.currency || 'CNY').toUpperCase() === 'CNY')
      .reduce((s, w) => s + (Number(w.balance) || 0), 0);
    const rechargeBalance = sum(biz?.normal_wallets);
    const bonusBalance = sum(biz?.bonus_wallets);
    const out = {
      total: Number((rechargeBalance + bonusBalance).toFixed(6)),
      rechargeBalance: Number(rechargeBalance.toFixed(6)),
      bonusBalance: Number(bonusBalance.toFixed(6)),
      currency: 'CNY',
      at: new Date().toISOString()
    };
    balanceCache.at = Date.now();
    balanceCache.data = out;
    return { ...out, cached: false };
  }

  function cachedBalance() {
    return balanceCache.data;
  }

  async function createOrder({ key, amount, channel } = {}) {
    const info = amountInfo(config);
    const value = Number(amount ?? info.def);
    const rounded = Math.round(value * 100) / 100;
    if (!Number.isFinite(rounded) || rounded <= 0) throw new Error('金额必须是大于 0 的数字');
    if (rounded < info.min) throw new Error(`金额不能低于 ${info.min} 元`);
    if (rounded > info.max) throw new Error(`金额不能高于 ${info.max} 元（需要更多请在插件配置里调 maxAmount）`);
    const channelId = Object.hasOwn(CHANNELS, channel) ? channel : (Object.hasOwn(CHANNELS, config.channel) ? config.channel : 'wechat');
    const spec = CHANNELS[channelId];
    const orderInfo = {
      payment_method_type: spec.order.payment_method_type,
      amount: rounded.toFixed(2).replace(/\.00$/, ''),
      currency: 'CNY',
      request_id: crypto.randomUUID()
    };
    if (spec.order.fallback_method_type) orderInfo.fallback_method_type = spec.order.fallback_method_type;
    const data = await platform('/api/v1/payments', { method: 'POST', body: { order_info: orderInfo, shumei_device_id: null } });
    const biz = data?.biz_data ?? {};
    const bizCode = Number(data?.biz_code ?? biz.code ?? 0);
    if (bizCode !== 0) throw new Error(`下单失败（biz_code ${bizCode}）：${data?.biz_msg || '平台拒绝'}`);
    const url = String(biz.url || '').trim();
    const orderId = String(biz.payment_order_id || '').trim();
    if (!orderId || !url) throw new Error('下单返回缺少 payment_order_id / url，平台可能改版了');
    const now = Date.now();
    const order = {
      orderId, key: key ?? null, amount: rounded, channel: channelId, url,
      createdAt: now, expiresAt: now + ORDER_TTL_MS,
      status: 'CREATED', paidAt: null, notifiedAt: null, messageId: null
    };
    state.orders[orderId] = order;
    persist();
    log(`已创建充值订单 ${orderId}（¥${rounded}，${channelId}，会话 ${key ?? '未绑定'}）`);
    return { ...order };
  }

  async function capture(orderId) {
    const data = await platform(`/api/v1/payments/${encodeURIComponent(orderId)}/capture`, { method: 'POST', body: null });
    const biz = data?.biz_data ?? {};
    const order = biz.order ?? {};
    const status = String(order.status || 'UNKNOWN');
    const local = state.orders[orderId];
    if (local) {
      const changed = local.status !== status;
      local.status = status;
      if (status === 'SUCCESS' && !local.paidAt) local.paidAt = order.paid_at || new Date().toISOString();
      if (changed) persist();
    }
    return { status, walletUpdated: biz.wallet_updated === true, paidAt: order.paid_at ?? null };
  }

  // ── 冷却 / 限额 ────────────────────────────────────────────────────────
  function canSend(key) {
    if (config.enabled === false) return { ok: false, reason: '投喂二维码未启用' };
    if (!key || !/^(group|private):\d+$/.test(String(key))) return { ok: false, reason: 'QQ 会话格式不对' };
    const now = Date.now();
    const dailyLimit = Math.max(0, Math.floor(Number(config.dailyLimit) || 0));
    if (dailyLimit > 0 && Number(state.daily[dayKey()] || 0) >= dailyLimit) {
      return { ok: false, reason: `今天的投喂二维码已经发满 ${dailyLimit} 张了` };
    }
    const globalCd = Math.max(0, Number(config.globalCooldownMinutes) || 0) * 60000;
    if (globalCd > 0 && state.lastSentAt && now - state.lastSentAt < globalCd) {
      return { ok: false, reason: '刚刚发过一张，稍等一下', retryAfterMs: globalCd - (now - state.lastSentAt) };
    }
    const keyCd = Math.max(0, Number(config.cooldownMinutes) || 0) * 60000;
    const last = Number(state.lastSentByKey[key] || 0);
    if (keyCd > 0 && last && now - last < keyCd) {
      return { ok: false, reason: '这个会话刚刚发过二维码了，等它过期再说', retryAfterMs: keyCd - (now - last) };
    }
    return { ok: true };
  }

  function recordSent({ key, orderId, messageId }) {    const now = Date.now();
    state.lastSentAt = now;
    if (key) state.lastSentByKey[key] = now;
    state.daily[dayKey()] = Number(state.daily[dayKey()] || 0) + 1;
    const order = state.orders[orderId];
    if (order) {
      order.sentAt = now;
      order.messageId = messageId ?? null;
    }
    persist();
  }

  function lowNoticeDue() {
    const hours = Math.max(0, Number(config.lowBalanceCooldownHours) || 12);
    return !state.lowNoticeAt || Date.now() - state.lowNoticeAt >= hours * 3600 * 1000;
  }

  function markLowNotice() {
    state.lowNoticeAt = Date.now();
    persist();
  }

  async function renderQrPng(url) {
    const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
    const modules = qr.modules.size;
    const scale = modules > 110 ? 6 : modules > 80 ? 8 : 10;
    return QRCode.toBuffer(url, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 4,
      width: (modules + 8) * scale
    });
  }

  // ── 发送 + 支付成功道谢 ────────────────────────────────────────────────
  async function sendTo(key, { amount, channel, note, auto = false } = {}) {
    const gate = canSend(key);
    if (!gate.ok) {
      const error = new Error(gate.reason);
      error.retryAfterMs = gate.retryAfterMs;
      throw error;
    }
    let balance = null;
    try { balance = await getBalance(); } catch { /* 余额只是话术里的附加信息，拿不到不影响发码 */ }
    const order = await createOrder({ key, amount, channel });
    const png = await renderQrPng(order.url);
    const channelLabel = CHANNELS[order.channel];
    const template = String(note || '').trim() || (auto ? (config.autoCaption || DEFAULTS.autoCaption) : (config.caption || DEFAULTS.caption));
    const caption = renderTemplate(template, {
      amount: order.amount,
      ttl: Math.round(ORDER_TTL_MS / 60000),
      channelHint: channelLabel.hint,
      balance: balance ? balance.total : ''
    });
    const messageId = await qq.sendRich(key, { text: caption, image: png });
    recordSent({ key, orderId: order.orderId, messageId });
    startPolling(order);
    return {
      orderId: order.orderId,
      amount: order.amount,
      channel: order.channel,
      channelLabel: channelLabel.label,
      expiresAt: order.expiresAt,
      balance: balance ? balance.total : null
    };
  }

  function startPolling(order) {
    if (timers.has(order.orderId)) return;
    const interval = Math.max(2, Number(config.pollSeconds) || 5) * 1000;
    const timer = setInterval(async () => {
      try {
        if (Date.now() > order.expiresAt) {
          stopPolling(order.orderId);
          return;
        }
        const result = await capture(order.orderId);
        if (result.status === 'SUCCESS') {
          stopPolling(order.orderId);
          await onPaid(order.orderId);
        } else if (['FAILED', 'EXPIRED', 'REFUNDED', 'CHARGEBACK'].includes(result.status)) {
          stopPolling(order.orderId);
        }
      } catch (error) {
        log(`查单失败 ${order.orderId}：${error?.message ?? error}`);
      }
    }, interval);
    timer.unref?.();
    timers.set(order.orderId, timer);
  }

  function stopPolling(orderId) {
    const timer = timers.get(orderId);
    if (timer) {
      clearInterval(timer);
      timers.delete(orderId);
    }
  }

  async function onPaid(orderId) {
    const order = state.orders[orderId];
    if (!order || order.notifiedAt) return;
    order.notifiedAt = new Date().toISOString();
    persist();
    let balance = null;
    try { balance = await getBalance({ force: true }); } catch { /* 余额读不到就只报道谢 */ }
    const text = renderTemplate(config.thankYou || DEFAULTS.thankYou, {
      amount: order.amount,
      balance: balance ? balance.total : '—'
    });
    if (!qq.isAllowed(order.key)) {
      log(`订单 ${orderId} 已支付，但会话 ${order.key} 已不在白名单，跳过道谢`);
      return;
    }
    await qq.sendText(order.key, text).catch((error) => log(`道谢发送失败：${error?.message ?? error}`));
    log(`订单 ${orderId} 支付成功（¥${order.amount}），已向 ${order.key} 道谢`);
  }

  // 启动时恢复未过期的订单轮询（桥接重启/插件重载后仍能收到「到账」）
  function resume() {
    const now = Date.now();
    for (const order of Object.values(state.orders)) {
      if (order && order.key && order.status !== 'SUCCESS' && Number(order.expiresAt || 0) > now
        && !['FAILED', 'EXPIRED', 'REFUNDED', 'CHARGEBACK'].includes(order.status)) {
        startPolling(order);
      }
    }
  }

  function dispose() {
    for (const orderId of [...timers.keys()]) stopPolling(orderId);
  }

  function snapshot() {
    return {
      balance: balanceCache.data,
      dailyUsed: Number(state.daily[dayKey()] || 0),
      lastSentAt: state.lastSentAt,
      orders: Object.values(state.orders).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 5)
        .map((o) => ({ orderId: o.orderId, amount: o.amount, channel: o.channel, status: o.status, key: o.key, createdAt: o.createdAt }))
    };
  }

  loadState();
  return {
    CHANNELS, DEFAULTS, sendTo, canSend, createOrder, capture, getBalance, cachedBalance,
    renderQrPng, startPolling, resume, dispose, snapshot, amountInfo, readGrant,
    lowNoticeDue, markLowNotice
  };
}
