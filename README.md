# dsh-qq-recharge · QQ 投喂二维码

给 QQ 里的大肥鱼一张**即时充值二维码**：余额不足、或群友主动想投喂时，用她自己账号下的
DeepSeek 支付订单生成二维码发到 QQ。**谁扫码付款，钱都直接充进她自己的 DeepSeek 余额**，
不经过收款码、不需要她先收钱再手动充，也没有任何中转。

> 这是 DSH 插件，不修改 qq-bridge 一行核心代码。它只读桥接的 `config.json` / `state/*.json`
> 来决定「发到哪个群、允不允许发」，发消息走 SnowLuma 的 OneBot HTTP 接口。

## 安装（一行链接）

```text
plugin_manager { action: "install_bundle", target: "https://github.com/<your-name>/dsh-qq-recharge/releases/download/v1.0.0/dsh-qq-recharge-1.0.0.tgz" }
```

然后放行 QQ 工具白名单、重启 DSH：

```bash
node "%DSH_PROFILE_DIR%\node_modules\dsh-qq-recharge\tools\patch-qq-allowlist.mjs" "D:\qq-bridge"
```

完整前置条件、配置和排错见 [SHARE.md](SHARE.md)。

## 三个入口

| 入口 | 触发 | 说明 |
| --- | --- | --- |
| 工具 `qq_send_recharge_qr` | 她自己在会话里调用 | 被问起「你是不是没钱了 / 怎么给你充」、或她想开口时；受冷却与日限额约束 |
| 余额耗尽兜底 | DSH 回合以 `QUOTA` / `ACCOUNT_QUOTA` 收尾 | 这时她根本跑不了模型，只有插件能替她说话；自动补一张码 |
| 低余额提醒（默认关） | 余额低于 `lowBalanceThreshold` | 往最近活跃的群发一张，最长每 `lowBalanceCooldownHours` 小时一次 |

付款成功后，插件会轮询 `capture`：订单变 `SUCCESS` 时自动在同一个会话里道谢，并刷新余额。
所以她**发完码不要自己宣布「到账了」**。

## 工作原理（钱怎么走）

平台的充值二维码本质是**账号下的一张支付订单**：

- 微信：`POST /api/v1/payments` 返回 `weixin://wxpay/bizpayurl?pr=...` —— 微信扫码就是付款页
- 支付宝：返回 `openapi.alipay.com/gateway.do?...` 的支付链接（也能做成二维码，但内容较长）
- 云闪付 / 招行聚合：返回 `qr.95516.com/...` 的银联二维码

订单挂在**主人自己的 DeepSeek 账号**下，任何人扫码付款都会充进同一个账号的余额。
二维码 15 分钟有效；订单未支付不会扣任何钱。

## 安装 / 卸载

已在当前 profile 安装（bundle `dsh-qq-recharge`，entry `qq-recharge`）。

```text
plugin_manager { action: "install_bundle", target: "<这个目录的绝对路径>" }
```

卸载：`plugin_manager { action: "remove_bundle", target: "dsh-qq-recharge" }`。

安装/替换后如果提示 `restart-required`，重启 DSH 即可。QQ 会话的工具白名单在
`D:\qq-bridge\plugins\qq-agent-presets\qq-tool-restrict.mjs` 的 `SAFE_EXACT` 里放行
`qq_send_recharge_qr`（已加好，一行；重启后生效）。

## 配置

配置在 profile 的 `cordis.patch.yml` 里这条 entry 的 `config`（装好后也可以从插件管理页改）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `bridgeDir` | `D:\qq-bridge` | 只读它的 config/state |
| `channel` | `wechat` | `wechat` / `alipay` / `unionpay` |
| `defaultAmount` | `10` | 默认金额（元） |
| `minAmount` / `maxAmount` | `1` / `100` | 允许的金额范围 |
| `cooldownMinutes` | `3` | 同一会话两次发码的最小间隔 |
| `globalCooldownMinutes` | `1` | 全局最小间隔，防止多个群同时刷码 |
| `dailyLimit` | `30` | 每天最多创建多少张码 |
| `autoOnQuota` | `true` | 余额耗尽自动补码 |
| `lowBalanceAutoSend` | `false` | 低余额主动发码（默认关，避免主动要钱） |
| `lowBalanceThreshold` | `5` | 低余额阈值（元） |
| `lowBalanceCooldownHours` | `12` | 低余额提醒的最小间隔（小时） |
| `pollSeconds` | `5` | 支付结果轮询间隔 |
| `caption` / `autoCaption` / `thankYou` | 见 `index.js` | 话术模板，支持 `{amount} {ttl} {channelHint} {balance}` |

## 安全边界

- **凭据**：只读 `~/.dsh/.credentials.yaml` 里 DSH 已存的平台登录凭据（`x-dsh-auth-token`），
  与 DSH 账号页/余额接口同一条通道；插件不保存密码、不接触支付账户、不读取支付密码。
- **QQ 边界**：发送前校验桥接白名单（`allow`/`deny`）、静默模式（静默时除主人私聊外不发）。
- **量**：每会话冷却、全局冷却、每日上限；订单 15 分钟过期；同一条码不会重复创建（除非冷却结束）。
- **方向**：二维码只能**收钱进她的账号**，不存在「扫码扣钱」的路径。
- **状态**：`$DSH_HOME/qq-recharge/state.json` 只存订单号、金额、状态、冷却时间，不存任何凭据。

## 已知限制

1. 平台接口是前端在用的内部接口（`/api/v1/payments`），**不属于公开 API**，平台改版可能失效；
   失效时插件只记日志，不影响正常聊天。
2. 二维码 15 分钟有效；过期后需要重新发（冷却结束后可以再发）。
3. 支付宝二维码是一长串网关 URL，模块多、图更密；扫码建议用支付宝，不要用微信扫。
4. 付款人身份对平台不可见，所以道谢只能说「有人充了」，不能点名是谁付的。
5. 余额查询/下单都需要 DSH 里登录着 DeepSeek 账号；退出登录后会返回 401。

## 排错

| 现象 | 可能原因 |
| --- | --- |
| 工具返回「这个会话没有绑定 QQ」 | 当前 DSH 会话不是 QQ 会话；去 QQ 群/私聊里用 |
| 「不在白名单」 | 群/好友不在 `qq-bridge/config.json` 的 `allow` 里 |
| 「平台登录凭据已失效」 | 在 DSH 里重新登录 DeepSeek 账号 |
| OneBot 426 | `config.json` 的 `snowluma.httpUrl` 指到了 WS 端口 |
| 发不出图、但文字到了 | SnowLuma 网关的图片发送失败；查看桥接日志 |
| 重启后工具消失 | bundle 未启用，或 profile 回滚；`plugin_manager list_plugins` 确认 |

## 测试

```bash
node tests/smoke.mjs   # 真实下单 + 二维码解码回读 + 冷却 + 白名单（会创建真实未支付订单）
node tests/paid.mjs    # 假平台：支付成功 → 自动道谢（不产生真实订单）
```
