# 分享 / 安装（给其他 DSH 用户）

给 QQ 里的大肥鱼加一张**即时充值二维码**：余额不足或群友想投喂时，用她自己账号下的
DeepSeek 支付订单生成二维码发到 QQ；谁扫码付款，钱直接进她自己的 DeepSeek 余额。

这个包不修改 qq-bridge 核心，只要求：

- DeepSeek Harness **0.2.x**（本包在 `0.2.1-rc.3` 上开发和测试）
- DSH 里**已登录 DeepSeek 账号**（插件复用这份登录凭据调平台接口，不另存密码）
- 已安装并在运行 **qq-bridge**（本包读它的 `config.json` / `state/sessions.json` 来定位 QQ 会话）
- SnowLuma 网关在线（消息直接走它的 OneBot HTTP 接口）

> 没有 QQ 桥接也能装，但工具会一直返回「这个会话没有绑定 QQ」。

---

## 方式 A：一个 tarball（最省事）

把这两个文件发给对方：

- `dsh-qq-recharge-1.0.0.tgz`
- 本说明（`SHARE.md`）

对方在 DSH 里执行：

```text
plugin_manager { action: "install_bundle", target: "C:\\path\\to\\dsh-qq-recharge-1.0.0.tgz" }
```

没网/不想走 pnpm 的话，把 tgz 解压成目录，`target` 填那个目录的绝对路径也行。

## 方式 B：目录 / Git

```text
plugin_manager { action: "install_bundle", target: "C:\\path\\to\\dsh-qq-recharge" }
# 或者
plugin_manager { action: "install_bundle", target: "github:<user>/<repo>" }
```

`plugin_manager` 会把包链接进当前 profile，并启用 bundle `dsh-qq-recharge`。
如果返回 `restart-required`，继续下一步，最后一起重启。

## 方式 C：发到 npm（可选）

```bash
npm publish --access public
# 对方：
plugin_manager { action: "install_bundle", target: "dsh-qq-recharge@1.0.0" }
```

`dsh-qq-recharge` 这个包名如果被占用，改成 `@你的名字/dsh-qq-recharge`，并同步改
`cordis.patch.yml` 里的 `name`。

---

## 必做：给 QQ 工具白名单放行

QQ 会话的 preset 有**执行期白名单**（`qq-agent-presets/qq-tool-restrict.mjs` 的 `SAFE_EXACT`）。
不放行的话，工具看得见、一调用就被拒（「不在 QQ 桥接白名单内」）。

包内带了幂等脚本，会把这一行加进去（自带 `.bak-时间戳` 备份）：

```bash
node <包目录>/tools/patch-qq-allowlist.mjs "D:\qq-bridge"
```

（`D:\qq-bridge` 换成对方的桥接目录；也可以设 `QQ_BRIDGE_DIR` 后不带参数。）
重复运行只会打印「已经放行过了」。

如果对方不想跑脚本，手动在 `SAFE_EXACT` 里加一行即可：

```js
  'qq_send_recharge_qr',
```

## 最后一步：重启 DSH

白名单在会话创建时读取，插件 row 也需要完整加载。重启后：

1. 在 QQ 群里对她说一句「给我发个充值码」；
2. 她调用 `qq_send_recharge_qr`，群里应该出现一句说明 + 一张二维码；
3. 扫码付款（建议先 ¥1 试），15 分钟内有效；
4. 付款成功后插件会自动在同一个群道谢，并显示新余额。

## 配置

配置在 profile 的 `cordis.patch.yml` 里 `qq-recharge` 这一条的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `bridgeDir` | `D:\qq-bridge` | 对方的桥接目录，**必改**如果不在默认位置 |
| `channel` | `wechat` | `wechat` / `alipay` / `unionpay` |
| `defaultAmount` / `minAmount` / `maxAmount` | `10` / `1` / `100` | 金额 |
| `cooldownMinutes` / `globalCooldownMinutes` / `dailyLimit` | `3` / `1` / `30` | 频率与日上限 |
| `autoOnQuota` | `true` | 余额耗尽自动补码 |
| `lowBalanceAutoSend` | `false` | 低余额主动发（默认关，避免主动要钱） |
| `caption` / `autoCaption` / `thankYou` | 内置 | 话术，支持 `{amount} {ttl} {channelHint} {balance}` |

## 隐私与安全（分享时请一并说明）

- 插件**只读** `~/.dsh/.credentials.yaml` 里 DSH 已存的平台登录凭据，用来调
  `platform.deepseek.com` 的下单/查单/余额接口；凭据不会发往任何其它地址，也不落盘到插件里。
- 发送前会校验 qq-bridge 的白名单与静默模式；有冷却、全局冷却、每日上限。
- 二维码只能**收钱进她自己的账号**，不存在扫码扣款的路径。
- 订单/冷却状态存在 `$DSH_HOME/qq-recharge/state.json`，不含任何凭据。

## 已知限制

- 平台接口 `/api/v1/payments` 是 DeepSeek 前端在用的内部接口，不是公开 API；平台改版可能失效（失效只记日志）。
- 二维码 15 分钟有效，过期要重新发。
- 支付宝码是一长串网关 URL（图更密），建议用支付宝扫。
- 付款人身份平台不可见，道谢只能说「有人充了」。
- 依赖 qq-bridge 的 `state/sessions.json` 形状；换别的桥接实现要改 `lib/qq.mjs`。

## 自检（可选）

```bash
node tests/smoke.mjs   # 会创建真实未支付订单，验证下单/二维码/冷却
node tests/paid.mjs    # 假平台，验证支付成功后的自动道谢
```
