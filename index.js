import 'dotenv/config';
import cron from 'node-cron';
import fs from 'node:fs/promises';
import path from 'node:path';

const {
  BOT_TOKEN,
  CHAT_ID,
  DATA_DIR = './data',
  DEFAULT_CHAIN = 'bsc',
  DEFAULT_THRESHOLD_USD = '100000',
  TIMEZONE = 'Asia/Shanghai'
} = process.env;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ 缺少必填环境变量: BOT_TOKEN / CHAT_ID');
  process.exit(1);
}

const CHAT_ID_STR = String(CHAT_ID);
const DATA_FILE = path.join(DATA_DIR, 'tokens.json');
const COOLDOWN_MS = 30 * 60 * 1000;

let state = { tokens: [], lastAlertTs: {} };

// ========== 持久化 ==========
async function loadState() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const text = await fs.readFile(DATA_FILE, 'utf8');
    state = { tokens: [], lastAlertTs: {}, ...JSON.parse(text) };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('读取状态失败:', err.message);
  }
}

async function saveState() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('保存状态失败:', err.message);
  }
}

// ========== Telegram ==========
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) console.error('TG 失败:', method, data.description || res.status);
  return data;
}

async function sendMsg(text, chatId = CHAT_ID) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
}

// ========== DexScreener ==========
async function fetchTokenStats(address, chain) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const data = await res.json();
  const pairs = (data.pairs || []).filter(p => p.chainId === chain);
  if (pairs.length === 0) throw new Error(`${chain} 上找不到此代币`);

  const volH1 = pairs.reduce((s, p) => s + (p.volume?.h1 || 0), 0);
  const volH24 = pairs.reduce((s, p) => s + (p.volume?.h24 || 0), 0);
  const buysH1 = pairs.reduce((s, p) => s + (p.txns?.h1?.buys || 0), 0);
  const sellsH1 = pairs.reduce((s, p) => s + (p.txns?.h1?.sells || 0), 0);

  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const top = pairs[0];

  return {
    symbol: top.baseToken.symbol,
    name: top.baseToken.name,
    priceUsd: Number(top.priceUsd || 0),
    priceChange1h: top.priceChange?.h1 ?? 0,
    liquidityUsd: top.liquidity?.usd || 0,
    volH1, volH24, buysH1, sellsH1,
    pairCount: pairs.length,
    topDex: top.dexId,
    url: top.url
  };
}

function fmt(n, d = 2) {
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: d, maximumFractionDigits: d
  });
}

function buildMsg(s, token, { isAlert, isHourly }) {
  const header = isAlert ? '🚨 *交易量阈值告警*'
    : isHourly ? '⏰ *每小时交易量报告*'
    : '📊 *交易量快照*';
  const icon = s.priceChange1h >= 0 ? '📈' : '📉';
  const sign = s.priceChange1h >= 0 ? '+' : '';
  return [
    header, '',
    `*${s.name}* ($${s.symbol}) · ${token.chain}`,
    `💰 $${fmt(s.priceUsd, 6)}  ${icon} ${sign}${fmt(s.priceChange1h)}% (1h)`,
    '',
    `🔥 *1h 交易量: $${fmt(s.volH1, 0)}*`,
    `   买 ${s.buysH1} / 卖 ${s.sellsH1}`,
    `📦 24h: $${fmt(s.volH24, 0)}`,
    `💧 流动性: $${fmt(s.liquidityUsd, 0)}`,
    `🔗 ${s.pairCount} 对 (主: ${s.topDex})`,
    '',
    isAlert ? `⚠️ 已超阈值 $${fmt(token.threshold, 0)}` : '',
    `[DexScreener](${s.url})`
  ].filter(Boolean).join('\n');
}

// ========== 监控逻辑 ==========
async function checkToken(token, { force = false, isHourly = false } = {}) {
  const key = `${token.chain}:${token.address}`;
  try {
    const s = await fetchTokenStats(token.address, token.chain);
    const isAlert = s.volH1 >= token.threshold;

    if (isHourly) {
      if (isAlert) state.lastAlertTs[key] = Date.now();
      await sendMsg(buildMsg(s, token, { isAlert, isHourly: true }));
    } else if (force) {
      await sendMsg(buildMsg(s, token, { isAlert, isHourly: false }));
    } else if (isAlert) {
      const last = state.lastAlertTs[key] || 0;
      if (Date.now() - last < COOLDOWN_MS) return;
      state.lastAlertTs[key] = Date.now();
      await sendMsg(buildMsg(s, token, { isAlert: true, isHourly: false }));
      await saveState();
    }
  } catch (err) {
    if (force) await sendMsg(`❌ \`${token.address}\` 查询失败: ${err.message}`);
    console.error(`check ${key} 失败:`, err.message);
  }
}

async function hourlyReport() {
  if (state.tokens.length === 0) return;
  for (const token of state.tokens) {
    await checkToken(token, { isHourly: true });
    await new Promise(r => setTimeout(r, 500));
  }
  await saveState();
}

async function thresholdCheck() {
  if (new Date().getMinutes() === 0) return;
  for (const token of state.tokens) {
    await checkToken(token, { isHourly: false });
    await new Promise(r => setTimeout(r, 500));
  }
}

// ========== 命令处理 ==========
const HELP = `*🤖 代币交易量监控*

/list - 查看监控列表
/add <地址> [阈值USD] [链] - 添加代币
/remove <地址> - 删除代币
/threshold <地址> <阈值USD> - 修改阈值
/check <地址> [链] - 立即查询一次
/help - 显示帮助

支持的链: bsc / ethereum / base / solana / polygon / arbitrum
默认链: \`${DEFAULT_CHAIN}\`  默认阈值: \`$${fmt(Number(DEFAULT_THRESHOLD_USD), 0)}\`

示例:
\`/add 0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82\`
\`/add 0xabc... 50000 ethereum\`
\`/threshold 0xabc... 200000\``;

function findToken(addr) {
  if (!addr) return null;
  const a = addr.toLowerCase();
  return state.tokens.find(t => t.address.toLowerCase() === a);
}

async function handleCmd(text, chatId) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  const command = cmd.split('@')[0].toLowerCase();

  if (command === '/start' || command === '/help') {
    return sendMsg(HELP, chatId);
  }

  if (command === '/list') {
    if (state.tokens.length === 0) {
      return sendMsg('📭 还没有监控任何代币\n用 `/add <地址>` 添加', chatId);
    }
    const lines = [`*📋 监控中 ${state.tokens.length} 个代币*`, ''];
    for (const t of state.tokens) {
      lines.push(`• \`${t.address}\``);
      lines.push(`  ${t.chain} · 阈值 $${fmt(t.threshold, 0)}`);
    }
    return sendMsg(lines.join('\n'), chatId);
  }

  if (command === '/add') {
    const [address, thresholdStr, chainArg] = args;
    if (!address) return sendMsg('用法: `/add <地址> [阈值USD] [链]`', chatId);
    if (findToken(address)) return sendMsg('⚠️ 该代币已在列表中', chatId);
    const threshold = Number(thresholdStr) || Number(DEFAULT_THRESHOLD_USD);
    const chain = (chainArg || DEFAULT_CHAIN).toLowerCase();
    try {
      const s = await fetchTokenStats(address, chain);
      state.tokens.push({ address, chain, threshold, addedAt: new Date().toISOString() });
      await saveState();
      return sendMsg(
        `✅ 已添加 *${s.name}* ($${s.symbol})\n` +
        `链: ${chain}\n` +
        `阈值: $${fmt(threshold, 0)}\n` +
        `当前 1h 交易量: $${fmt(s.volH1, 0)}`,
        chatId
      );
    } catch (err) {
      return sendMsg(`❌ 添加失败: ${err.message}`, chatId);
    }
  }

  if (command === '/remove') {
    const [address] = args;
    if (!address) return sendMsg('用法: `/remove <地址>`', chatId);
    const idx = state.tokens.findIndex(t => t.address.toLowerCase() === address.toLowerCase());
    if (idx === -1) return sendMsg('❌ 列表中没有这个代币', chatId);
    const removed = state.tokens.splice(idx, 1)[0];
    delete state.lastAlertTs[`${removed.chain}:${removed.address}`];
    await saveState();
    return sendMsg(`🗑 已删除 \`${removed.address}\``, chatId);
  }

  if (command === '/threshold') {
    const [address, thresholdStr] = args;
    const token = findToken(address);
    if (!token) return sendMsg('❌ 列表中没有这个代币', chatId);
    const threshold = Number(thresholdStr);
    if (!threshold || threshold <= 0) return sendMsg('用法: `/threshold <地址> <阈值USD>`', chatId);
    const old = token.threshold;
    token.threshold = threshold;
    await saveState();
    return sendMsg(`✅ 阈值 $${fmt(old, 0)} → $${fmt(threshold, 0)}`, chatId);
  }

  if (command === '/check') {
    const [address, chainArg] = args;
    if (!address) return sendMsg('用法: `/check <地址> [链]`', chatId);
    const token = findToken(address) || {
      address,
      chain: (chainArg || DEFAULT_CHAIN).toLowerCase(),
      threshold: Number(DEFAULT_THRESHOLD_USD)
    };
    return checkToken(token, { force: true });
  }

  return sendMsg('❓ 未知命令，发 /help 查看用法', chatId);
}

// ========== Long polling ==========
let updateOffset = 0;
async function pollUpdates() {
  try {
    const data = await tg('getUpdates', { offset: updateOffset, timeout: 25 });
    for (const upd of data.result || []) {
      updateOffset = upd.update_id + 1;
      const msg = upd.message;
      if (!msg || !msg.text) continue;
      const chatId = String(msg.chat.id);
      if (chatId !== CHAT_ID_STR) {
        console.log('忽略未授权消息 from', chatId);
        continue;
      }
      if (msg.text.startsWith('/')) {
        handleCmd(msg.text, chatId).catch(err => console.error('命令错误:', err));
      }
    }
  } catch (err) {
    console.error('轮询错误:', err.message);
    await new Promise(r => setTimeout(r, 3000));
  }
  setImmediate(pollUpdates);
}

// ========== 启动 ==========
(async () => {
  await loadState();
  console.log('🤖 监控启动');
  console.log(`   监控中: ${state.tokens.length} 个代币`);
  console.log(`   时区: ${TIMEZONE}`);
  console.log(`   数据目录: ${DATA_DIR}`);

  await sendMsg(
    `🤖 *监控已启动*\n` +
    `当前监控 ${state.tokens.length} 个代币\n` +
    `发 /help 查看命令`
  );

  cron.schedule('0 * * * *', hourlyReport, { timezone: TIMEZONE });
  cron.schedule('*/5 * * * *', thresholdCheck, { timezone: TIMEZONE });

  pollUpdates();
})();
