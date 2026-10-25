#!/usr/bin/env node
// 给 qq-bridge 的 QQ 工具白名单放行 qq_send_recharge_qr。
//
// 为什么需要：QQ 会话的 preset 用 qq-tool-restrict.mjs 做**执行期白名单**，
// 不在名单里的工具一调用就被拒（「不在 QQ 桥接白名单内」）。这一步改的是
// qq-agent-presets 插件（不是桥接核心），一行，幂等，带备份。
//
// 用法：node tools/patch-qq-allowlist.mjs [bridge目录]
//   默认读环境变量 QQ_BRIDGE_DIR，再默认 D:\qq-bridge
import fs from 'node:fs';
import path from 'node:path';

const bridgeDir = process.argv[2] || process.env.QQ_BRIDGE_DIR || 'D:\\qq-bridge';
const file = path.join(bridgeDir, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
const TOOL = 'qq_send_recharge_qr';

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!fs.existsSync(file)) {
  fail(`找不到 ${file}\n  请确认桥接目录正确，或先运行过 qq-bridge 的 setup-dsh（它会把 qq-agent-presets 装成 junction）。`);
}

const source = fs.readFileSync(file, 'utf8');
if (source.includes(`'${TOOL}'`) || source.includes(`"${TOOL}"`)) {
  console.log(`✓ 已经放行过了：${file}`);
  process.exit(0);
}

const start = source.indexOf('const SAFE_EXACT = new Set([');
if (start < 0) fail('这个版本的 qq-tool-restrict.mjs 里找不到 SAFE_EXACT，请手动把 \'' + TOOL + '\' 加进白名单。');
const end = source.indexOf('])', start);
if (end < 0) fail('SAFE_EXACT 结构不符合预期，请手动编辑。');

const insertAt = end;
const block = [
  '  // 投喂二维码（dsh-qq-recharge）：只往当前 QQ 会话发她**自己账号**的充值二维码；',
  '  // 钱只可能进她自己的 DeepSeek 余额（别人扫码付款），不读文件、不执行命令。',
  `  '${TOOL}',`,
  ''
].join('\n');

const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(file, backup);
const next = source.slice(0, insertAt) + block + source.slice(insertAt);
fs.writeFileSync(file, next, 'utf8');

const verify = fs.readFileSync(file, 'utf8');
if (!verify.includes(`'${TOOL}'`)) fail('写入后校验失败，请检查文件。');
console.log(`✓ 已放行 ${TOOL}`);
console.log(`  文件：${file}`);
console.log(`  备份：${backup}`);
console.log('  重启 DSH 后生效（QQ preset 在每个会话创建时读取白名单）。');
