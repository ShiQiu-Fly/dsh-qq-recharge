// DSH 插件：QQ 里的「投喂二维码」
//
// 大肥鱼没余额、或群友主动想给她充值时，用 DSH 已登录的 DeepSeek 账号**现场创建一张充值订单**，
// 把订单二维码发到 QQ。谁扫码付款，钱都直接进她自己的 DeepSeek 余额 —— 不是收款码、没有中转。
//
// 三个入口：
//   1) 工具 qq_send_recharge_qr：她在会话里自己决定发（被问起 / 自己觉得该开口）。
//   2) 余额耗尽兜底：DSH 回合以 QUOTA / ACCOUNT_QUOTA 收尾时，插件替她补一张码 ——
//      这时她根本跑不了模型，只有插件能替她说话。
//   3) 低余额提醒（默认关）：余额低于阈值时，往最近活跃的群发一张，最多每 N 小时一次。
//
// 凭据：只读 ~/.dsh/.credentials.yaml 里 DSH 已存的平台登录凭据；插件不保存密码、不碰支付账户。
// QQ 边界：只读 qq-bridge 的 config.json / state/*.json；白名单、静默模式照旧生效。
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createQq } from './lib/qq.mjs';
import { createRecharge, CHANNELS } from './lib/recharge.mjs';

export const name = 'qq-recharge';
export const inject = ['tools'];

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关'),
  bridgeDir: Schema.string().default('D:\\qq-bridge').description('qq-bridge 安装目录（只读它的配置与会话映射）'),
  channel: Schema.union(['wechat', 'alipay', 'unionpay']).default('wechat').description('默认支付渠道：微信扫码最省事'),
  defaultAmount: Schema.number().default(10).description('默认充值金额（元）'),
  minAmount: Schema.number().default(1).description('允许的最小金额（元）'),
  maxAmount: Schema.number().default(100).description('允许的最大金额（元）'),
  cooldownMinutes: Schema.number().default(3).description('同一会话两次发码的最小间隔（分钟）'),
  globalCooldownMinutes: Schema.number().default(1).description('全局最小间隔（分钟），防止多个群同时刷码'),
  dailyLimit: Schema.number().default(30).description('每天最多创建多少张码'),
  autoOnQuota: Schema.boolean().default(true).description('余额耗尽（QUOTA）时自动补一张码'),
  lowBalanceAutoSend: Schema.boolean().default(false).description('余额低于阈值时主动往最近活跃的群发一张（默认关，避免主动要钱）'),
  lowBalanceThreshold: Schema.number().default(5).description('低余额阈值（元）'),
  lowBalanceCooldownHours: Schema.number().default(12).description('低余额主动提醒的最小间隔（小时）'),
  pollSeconds: Schema.number().default(5).description('支付结果轮询间隔（秒）'),
  caption: Schema.string().description('手动发码的话术（{amount} {ttl} {channelHint} {balance} 会被替换）'),
  autoCaption: Schema.string().description('余额耗尽自动补码的话术'),
  thankYou: Schema.string().description('到账后的道谢话术')
});

const TEXT_OUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: { text: { type: 'string', required: true } }
  },
  render(_args, value) {
    return [{ type: 'text', text: String(value?.text ?? '') }];
  }
};

function sessionIdFromExec(exec) {
  try {
    const agent = exec?.agent ?? exec?.caller ?? exec?.agentRef;
    if (agent?.session) {
      const id = agent.session.id ?? agent.session.sessionId;
      if (typeof id === 'string' && id) return id;
    }
    if (agent && typeof agent === 'object') {
      for (const key of ['sessionId', 'id']) {
        if (typeof agent[key] === 'string' && agent[key]) return agent[key];
      }
    }
  } catch { /* 拿不到就返回空 */ }
  return '';
}

function retryHint(error) {
  const ms = Number(error?.retryAfterMs);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.ceil(ms / 60000);
  return minutes >= 1 ? `（约 ${minutes} 分钟后可以再发）` : `（约 ${Math.ceil(ms / 1000)} 秒后可以再发）`;
}

export function apply(ctx, config) {
  if (config.enabled === false) return;
  const log = (...args) => console.log('[qq-recharge]', ...args);
  const qq = createQq({ bridgeDir: String(config.bridgeDir || 'D:\\qq-bridge'), log });
  const recharge = createRecharge({ config, qq, log });

  // 支付轮询在插件重载/卸载时清掉
  ctx.effect(() => () => recharge.dispose());

  async function runSend(args, key) {
    try {
      const sent = await recharge.sendTo(key, {
        amount: args?.amount,
        channel: args?.channel,
        note: args?.note
      });
      const channelLabel = CHANNELS[sent.channel]?.label ?? sent.channel;
      const minutes = Math.max(1, Math.round((sent.expiresAt - Date.now()) / 60000));
      return {
        text: `已发到 ${key}：¥${sent.amount} · ${channelLabel}，二维码 ${minutes} 分钟内有效。`
          + '付款成功会自动在会话里道谢；在那之前不要宣布已到账，也不要重复发。'
          + (sent.balance === null ? '' : `（当前余额 ¥${sent.balance}）`)
      };
    } catch (error) {
      return { text: `没发出去：${error?.message ?? error}${retryHint(error)}` };
    }
  }

  // ── 工具：她自己在会话里发码 ────────────────────────────────────────────
  const sendTool = defineTool({
    name: 'qq_send_recharge_qr',
    description:
      '给当前 QQ 会话发一张**即时充值二维码**：用她自己账号下的 DeepSeek 支付订单，谁扫码付款，钱都直接充进她的账号，'
      + '不经过任何中转、不需要她先收钱再手动充。二维码 15 分钟内有效，付款成功后插件会自动在同一个会话里道谢，'
      + '所以发完不要自己再宣布「到账了」。'
      + '什么时候用：余额不足/被提示没钱时；群友主动说想投喂、问怎么充值、问你是不是没额度了；或你确实想开口求助时。'
      + '不要为了要钱反复发，也不要假装已经有人充了。同一会话几分钟内重复调用会被拒绝并告诉你还要等多久。'
      + '金额按对方意愿选（默认 10 元）；对方明确说只有支付宝/云闪付时再换渠道。',
    parameters: {
      amount: { type: 'number', description: '充值金额（元），默认 10。只填对方说过的数，不要自己加码。' },
      channel: {
        type: 'string',
        enum: ['wechat', 'alipay', 'unionpay'],
        description: '支付渠道：wechat=微信扫码（默认、最省事）；alipay=支付宝；unionpay=云闪付/银行 App。'
      },
      note: { type: 'string', description: '可选：这次随二维码一起说的话（一两句，会作为一条 QQ 消息发出）。不填用默认话术。' }
    },
    output: TEXT_OUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const key = qq.keyForSession(sessionIdFromExec(exec));
      if (!key) return { text: '这个会话没有绑定 QQ，发不了投喂二维码；只能在她所在的 QQ 群/私聊里用。' };
      const blocked = qq.blockReason(key);
      if (blocked) return { text: `发不了：${blocked}` };
      return await runSend(args, key);
    }
  });

  ctx.effect(() => ctx.tools.register(sendTool));

  // ── 余额耗尽兜底 ────────────────────────────────────────────────────────
  const seenTurns = new Set();
  function firstTime(id) {
    if (!id) return false;
    if (seenTurns.has(id)) return false;
    seenTurns.add(id);
    if (seenTurns.size > 200) seenTurns.delete(seenTurns.values().next().value);
    return true;
  }

  ctx.on('session/event', (session, event) => {
    if (config.autoOnQuota === false) return;
    if (!event || event.type !== 'turn/end') return;
    const code = String(event.data?.reason?.error?.code ?? '');
    if (code !== 'QUOTA' && code !== 'ACCOUNT_QUOTA') return;
    const sessionId = String(session?.id ?? '');
    if (!sessionId || !firstTime(`${sessionId}:${event.data?.turn ?? ''}`)) return;
    const key = qq.keyForSession(sessionId);
    if (!key) return;
    void (async () => {
      try {
        const blocked = qq.blockReason(key);
        if (blocked) {
          log(`余额耗尽但没发码（${key}）：${blocked}`);
          return;
        }
        const sent = await recharge.sendTo(key, { auto: true });
        log(`余额耗尽（${code}），已向 ${key} 发送投喂二维码 ${sent.orderId}（¥${sent.amount}）`);
      } catch (error) {
        log(`余额耗尽后补码失败（${key}）：${error?.message ?? error}`);
      }
    })();
  });

  // ── 低余额主动提醒（默认关） ────────────────────────────────────────────
  if (config.lowBalanceAutoSend === true) {
    const tick = async () => {
      try {
        const balance = await recharge.getBalance();
        const threshold = Number(config.lowBalanceThreshold) || 0;
        if (!(threshold > 0) || balance.total >= threshold) return;
        if (!recharge.lowNoticeDue()) return;
        const key = qq.mostRecentSessionKey(true);
        if (!key) return;
        const blocked = qq.blockReason(key);
        if (blocked) return;
        const sent = await recharge.sendTo(key, { auto: true });
        recharge.markLowNotice();
        log(`余额 ¥${balance.total} 低于 ¥${threshold}，已向 ${key} 发送投喂二维码 ${sent.orderId}`);
      } catch (error) {
        log(`低余额提醒失败：${error?.message ?? error}`);
      }
    };
    ctx.effect(() => {
      const timer = setInterval(tick, 10 * 60 * 1000);
      timer.unref?.();
      void tick();
      return () => clearInterval(timer);
    });
  }

  recharge.resume();
  log(`已启用：qq_send_recharge_qr + 余额耗尽兜底（渠道 ${config.channel}，默认 ¥${config.defaultAmount}）`);
}
