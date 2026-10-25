// 和 qq-bridge 的「只读接口」：解析 QQ 会话白名单、会话映射，然后把消息发到 SnowLuma 网关。
//
// 为什么直接连 SnowLuma 而不是改桥接：这样整个功能是一个可装卸的插件 —— 桥接升级不受影响，
// 插件卸载后桥接一行都不变。这里只读桥接的 config.json / state/*.json，不写它的任何文件。
//
// 发消息仍然遵守桥接的边界：白名单（allow/deny）、静默模式、管理员私聊例外。
import fs from 'node:fs';
import path from 'node:path';

const CACHE_MS = 3000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

export function createQq({ bridgeDir, log = () => {} }) {
  const configPath = path.join(bridgeDir, 'config.json');
  const sessionsPath = path.join(bridgeDir, 'state', 'sessions.json');
  const rolePath = path.join(bridgeDir, 'state', 'current-role.json');
  let cache = { at: 0, config: null, sessions: null };

  function refresh(force = false) {
    if (!force && cache.config && Date.now() - cache.at < CACHE_MS) return cache;
    cache = {
      at: Date.now(),
      config: readJson(configPath),
      sessions: readJson(sessionsPath)
    };
    return cache;
  }

  function bridgeConfig() {
    return refresh().config ?? {};
  }

  function ownerQQ() {
    return String(bridgeConfig().ownerQQ ?? '').trim();
  }

  function ownerKey() {
    const qq = ownerQQ();
    return qq ? `private:${qq}` : '';
  }

  function keyForSession(sessionId) {
    const id = String(sessionId ?? '').trim();
    if (!id) return '';
    const map = refresh().sessions?.sessions ?? {};
    for (const [key, sid] of Object.entries(map)) {
      if (String(sid) === id) return key;
    }
    return '';
  }

  function isAllowed(key) {
    const cfg = bridgeConfig();
    const match = /^(group|private):(\d+)$/.exec(String(key ?? ''));
    if (!match) return false;
    const [, kind, id] = match;
    const allow = cfg.allow ?? {};
    const deny = cfg.deny ?? {};
    const allowList = idList(kind === 'group' ? allow.groups : allow.private);
    const denyList = idList(kind === 'group' ? deny.groups : deny.private);
    if (denyList.includes(id)) return false;
    if (allowList.length === 0) return cfg.allowAllWhenEmpty === true;
    return allowList.includes(id);
  }

  function isSilent() {
    const role = readJson(rolePath);
    return String(role?.mode ?? '') === 'silent';
  }

  function blockReason(key) {
    if (!/^(group|private):\d+$/.test(String(key ?? ''))) return 'QQ 会话格式不对';
    if (!isAllowed(key)) return '这个会话不在 QQ 桥接的白名单里';
    if (isSilent() && key !== ownerKey()) return 'QQ 桥接当前是静默模式，不给群友发消息';
    return '';
  }

  /**
   * 最近活跃的 QQ 会话（按桥接 social-v2 状态里最近一条消息的时间判断）。
   * groupsOnly=true 时只在群里挑 —— 主动提醒不该打扰私聊。
   */
  function mostRecentSessionKey(groupsOnly = false) {
    const file = path.join(bridgeDir, 'state', 'social-v2.json');
    const data = readJson(file);
    const conversations = data?.conversations ?? data?.sessions ?? null;
    if (!conversations || typeof conversations !== 'object') return '';
    let best = { key: '', at: 0 };
    for (const [key, st] of Object.entries(conversations)) {
      if (groupsOnly && !key.startsWith('group:')) continue;
      if (!isAllowed(key)) continue;
      const messages = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
      const last = messages.length ? Date.parse(messages[messages.length - 1]?.time ?? '') : NaN;
      const at = Number.isFinite(last) ? last : Number(st?.lastMessageAt || st?.lastAiReplyAt || 0);
      if (at > best.at) best = { key, at };
    }
    return best.key;
  }

  function endpoint() {
    const snowluma = bridgeConfig().snowluma ?? {};
    const httpUrl = String(snowluma.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    return { httpUrl, accessToken: String(snowluma.accessToken || '') };
  }

  async function sendRich(key, { text = '', image = null } = {}) {
    const blocked = blockReason(key);
    if (blocked) throw new Error(blocked);
    const [kind, id] = key.split(':');
    const segments = [];
    if (text) segments.push({ type: 'text', data: { text } });
    if (image) segments.push({ type: 'image', data: { file: 'base64://' + Buffer.from(image).toString('base64') } });
    if (segments.length === 0) throw new Error('没有可发送的内容');
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const payload = kind === 'group'
      ? { group_id: Number(id), message: segments }
      : { user_id: Number(id), message: segments };
    const { httpUrl, accessToken } = endpoint();
    let res;
    try {
      res = await fetch(`${httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000)
      });
    } catch (error) {
      throw new Error(`连不上 SnowLuma 网关（${httpUrl}）：${error?.message ?? error}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
      throw new Error(`OneBot ${action} 失败：${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data?.message_id ?? null;
  }

  async function sendText(key, text) {
    return sendRich(key, { text });
  }

  return {
    bridgeConfig,
    ownerQQ,
    ownerKey,
    keyForSession,
    mostRecentSessionKey,
    isAllowed,
    isSilent,
    blockReason,
    sendRich,
    sendText
  };
}
