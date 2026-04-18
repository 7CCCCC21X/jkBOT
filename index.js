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
  DEFAULT_THRESHOLD_24H_USD = '1000000',
  HISTORY_DAYS = '30',
  TIMEZONE = 'Asia/Shanghai'
} = process.env;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ 缺少必填环境变量: BOT_TOKEN / CHAT_ID');
  process.exit(1);
}

const CHAT_ID_STR = String(CHAT_ID);
const STATE_FILE = path.join(DATA_DIR, 'tokens.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const COOLDOWN_1H_MS = 30 * 60 * 1000;
const COOLDOWN_24H_MS = 6 * 60 * 60 * 1000;
const HISTORY_RETENTION_MS = Math.max(1, Number(HISTORY_DAYS)) * 24 * 60 * 60 * 1000;

let state = { tokens: [], lastAlertTs: {} };
let history = {};

// ========== 原子持久化 ==========
// 崩溃安全: 写 .tmp -> rename; 覆盖前备份 .bak
async function readJson(file, fallback) {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      const text = await fs.readFile(candidate, 'utf8');
      const parsed = JSON.parse(text);
      if (candidate !== file) console.warn(`主文件损坏, 已从 ${candidate} 恢复`);
      return parsed;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      console.error(`读取 ${candidate} 失败:`, err.message);
    }
  }
  return fallback;
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const bak = `${file}.bak`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  try { await fs.copyFile(file, bak); } catch (err) {
    if (err.code !== 'ENOENT') console.warn('备份失败:', err.message);
  }
  await fs.rename(tmp, file);
}

async function loadState() {
  state = { tokens: [], lastAlertTs: {}, ...(await readJson(STATE_FILE, {})) };
}

async function saveState() {
  try {
    await writeJson(STATE_FILE, state);
  } catch (err) {
    console.error('保存状态失败:', err.message);
  }
}

async function loadHistory() {
  history = await readJson(HISTORY_FILE, {});
}

async function saveHistory() {
  try {
    await writeJson(HISTORY_FILE, history);
  } catch (err) {
    console.error('保存历史失败:', err.message);
  }
}

function pushHistory(token, snapshot) {
  const key = `${token.chain}:${token.address}`;
  const list = history[key] || (history[key] = []);
  list.push(snapshot);
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  while (list.length && list[0].t < cutoff) list.shift();
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
  const buysH24 = pairs.reduce((s, p) => s + (p.txns?.h24?.buys || 0), 0);
  const sellsH24 = pairs.reduce((s, p) => s + (p.txns?.h24?.sells || 0), 0);

  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const top = pairs[0];

  return {
    symbol: top.baseToken.symbol,
    name: top.baseToken.name,
    priceUsd: Number(top.priceUsd || 0),
    priceChange1h: top.priceChange?.h1 ?? 0,
    priceChange24h: top.priceChange?.h24 ?? 0,
    liquidityUsd: top.liquidity?.usd || 0,
    volH1, volH24, buysH1, sellsH1, buysH24, sellsH24,
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

function buildMsg(s, token, { alertKind, isHourly, isDaily }) {
  const header = alertKind === '1h' ? '🚨 *1h 交易量阈值告警*'
    : alertKind === '24h' ? '🚨 *24h 交易量阈值告警*'
    : isDaily ? '🌅 *每日交易量报告 (过去 24h)*'
    : isHourly ? '⏰ *每小时交易量报告*'
    : '📊 *交易量快照*';
  const icon1h = s.priceChange1h >= 0 ? '📈' : '📉';
  const sign1h = s.priceChange1h >= 0 ? '+' : '';
  const icon24h = s.priceChange24h >= 0 ? '📈' : '📉';
  const sign24h = s.priceChange24h >= 0 ? '+' : '';
  return [
    header, '',
    `*${s.name}* ($${s.symbol}) · ${token.chain}`,
    `💰 $${fmt(s.priceUsd, 6)}`,
    `   ${icon1h} 1h ${sign1h}${fmt(s.priceChange1h)}%   ${icon24h} 24h ${sign24h}${fmt(s.priceChange24h)}%`,
    '',
    `🔥 1h 交易量: $${fmt(s.volH1, 0)}  (买 ${s.buysH1} / 卖 ${s.sellsH1})`,
    `📦 24h 交易量: $${fmt(s.volH24, 0)}  (买 ${s.buysH24} / 卖 ${s.sellsH24})`,
    `💧 流动性: $${fmt(s.liquidityUsd, 0)}`,
    `🔗 ${s.pairCount} 对 (主: ${s.topDex})`,
    '',
    alertKind === '1h' ? `⚠️ 1h 交易量超阈值 $${fmt(token.threshold, 0)}` : '',
    alertKind === '24h' ? `⚠️ 24h 交易量超阈值 $${fmt(token.threshold24h, 0)}` : '',
    `[DexScreener](${s.url})`
  ].filter(Boolean).join('\n');
}

// ========== 监控逻辑 ==========
async function checkToken(token, { force = false, isHourly = false, isDaily = false } = {}) {
  const key = `${token.chain}:${token.address}`;
  try {
    const s = await fetchTokenStats(token.address, token.chain);
    const breach1h = s.volH1 >= token.threshold;
    const breach24h = token.threshold24h > 0 && s.volH24 >= token.threshold24h;

    // 小时级定时任务顺带记录历史快照
    if (isHourly) {
      pushHistory(token, {
        t: Date.now(),
        priceUsd: s.priceUsd,
        volH1: s.volH1,
        volH24: s.volH24,
        liquidityUsd: s.liquidityUsd,
        buysH1: s.buysH1,
        sellsH1: s.sellsH1
      });
    }

    if (isDaily) {
      await sendMsg(buildMsg(s, token, { isDaily: true }));
      return;
    }
    if (isHourly) {
      if (breach1h) state.lastAlertTs[`${key}:1h`] = Date.now();
      if (breach24h) state.lastAlertTs[`${key}:24h`] = Date.now();
      await sendMsg(buildMsg(s, token, {
        alertKind: breach1h ? '1h' : breach24h ? '24h' : null,
        isHourly: true
      }));
      return;
    }
    if (force) {
      await sendMsg(buildMsg(s, token, {
        alertKind: breach1h ? '1h' : breach24h ? '24h' : null
      }));
      return;
    }

    const now = Date.now();
    if (breach1h) {
      const last = state.lastAlertTs[`${key}:1h`] || 0;
      if (now - last >= COOLDOWN_1H_MS) {
        state.lastAlertTs[`${key}:1h`] = now;
        await sendMsg(buildMsg(s, token, { alertKind: '1h' }));
        await saveState();
      }
    }
    if (breach24h) {
      const last = state.lastAlertTs[`${key}:24h`] || 0;
      if (now - last >= COOLDOWN_24H_MS) {
        state.lastAlertTs[`${key}:24h`] = now;
        await sendMsg(buildMsg(s, token, { alertKind: '24h' }));
        await saveState();
      }
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
  await saveHistory();
}

async function dailyReport() {
  if (state.tokens.length === 0) return;
  for (const token of state.tokens) {
    await checkToken(token, { isDaily: true });
    await new Promise(r => setTimeout(r, 500));
  }
}

async function thresholdCheck() {
  if (new Date().getMinutes() === 0) return;
  for (const token of state.tokens) {
    await checkToken(token, {});
    await new Promise(r => setTimeout(r, 500));
  }
}

// ========== 命令处理 ==========
const HELP = `*🤖 代币交易量监控*

/list - 查看监控列表
/add <地址> [阈值1h] [阈值24h] [链] - 添加代币
/remove <地址> - 删除代币
/threshold <地址> <阈值USD> - 修改 1h 阈值
/threshold24h <地址> <阈值USD> - 修改 24h 阈值 (0=关闭)
/check <地址> [链] - 立即查询一次
/history <地址> [小时数] - 查看历史趋势 (默认 24h)
/help - 显示帮助

支持的链: bsc / ethereum / base / solana / polygon / arbitrum
默认链: \`${DEFAULT_CHAIN}\`
默认 1h 阈值: \`$${fmt(Number(DEFAULT_THRESHOLD_USD), 0)}\`
默认 24h 阈值: \`$${fmt(Number(DEFAULT_THRESHOLD_24H_USD), 0)}\`
历史保留: ${HISTORY_DAYS} 天

示例:
\`/add 0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82\`
\`/add 0xabc... 50000 500000 ethereum\`
\`/history 0xabc... 72\``;

function findToken(addr) {
  if (!addr) return null;
  const a = addr.toLowerCase();
  return state.tokens.find(t => t.address.toLowerCase() === a);
}

function sparkline(values) {
  if (values.length === 0) return '';
  const bars = '▁▂▃▄▅▆▇█';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map(v => bars[Math.floor(((v - min) / range) * (bars.length - 1))]).join('');
}

function historySummary(token, hours) {
  const key = `${token.chain}:${token.address}`;
  const list = history[key] || [];
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const recent = list.filter(x => x.t >= cutoff);
  if (recent.length === 0) return null;

  const vols = recent.map(x => x.volH1);
  const prices = recent.map(x => x.priceUsd);
  const liqs = recent.map(x => x.liquidityUsd);
  const totalBuys = recent.reduce((s, x) => s + (x.buysH1 || 0), 0);
  const totalSells = recent.reduce((s, x) => s + (x.sellsH1 || 0), 0);
  const volTotal = vols.reduce((s, v) => s + v, 0);
  const volAvg = volTotal / vols.length;
  const priceStart = prices[0];
  const priceEnd = prices[prices.length - 1];
  const priceChange = priceStart > 0 ? ((priceEnd - priceStart) / priceStart) * 100 : 0;

  return {
    count: recent.length,
    volAvg, volMax: Math.max(...vols), volMin: Math.min(...vols), volTotal,
    priceStart, priceEnd, priceChange,
    liqStart: liqs[0], liqEnd: liqs[liqs.length - 1],
    totalBuys, totalSells,
    volSpark: sparkline(vols),
    priceSpark: sparkline(prices)
  };
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
      const t24 = t.threshold24h > 0 ? `$${fmt(t.threshold24h, 0)}` : '关闭';
      const hist = history[`${t.chain}:${t.address}`]?.length || 0;
      lines.push(`• \`${t.address}\``);
      lines.push(`  ${t.chain} · 1h $${fmt(t.threshold, 0)} · 24h ${t24} · 历史 ${hist} 条`);
    }
    return sendMsg(lines.join('\n'), chatId);
  }

  if (command === '/add') {
    const [address, thresholdStr, threshold24hStr, chainArg] = args;
    if (!address) return sendMsg('用法: `/add <地址> [阈值1h] [阈值24h] [链]`', chatId);
    if (findToken(address)) return sendMsg('⚠️ 该代币已在列表中', chatId);
    const threshold = Number(thresholdStr) || Number(DEFAULT_THRESHOLD_USD);
    const threshold24h = threshold24hStr !== undefined
      ? Number(threshold24hStr)
      : Number(DEFAULT_THRESHOLD_24H_USD);
    const chain = (chainArg || DEFAULT_CHAIN).toLowerCase();
    try {
      const s = await fetchTokenStats(address, chain);
      state.tokens.push({
        address,
        chain,
        threshold,
        threshold24h,
        addedAt: new Date().toISOString()
      });
      await saveState();
      const t24Line = threshold24h > 0
        ? `24h 阈值: $${fmt(threshold24h, 0)}`
        : '24h 阈值: 关闭';
      return sendMsg(
        `✅ 已添加 *${s.name}* ($${s.symbol})\n` +
        `链: ${chain}\n` +
        `1h 阈值: $${fmt(threshold, 0)}\n` +
        `${t24Line}\n` +
        `当前 1h 交易量: $${fmt(s.volH1, 0)}\n` +
        `当前 24h 交易量: $${fmt(s.volH24, 0)}`,
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
    delete state.lastAlertTs[`${removed.chain}:${removed.address}:1h`];
    delete state.lastAlertTs[`${removed.chain}:${removed.address}:24h`];
    delete history[`${removed.chain}:${removed.address}`];
    await saveState();
    await saveHistory();
    return sendMsg(`🗑 已删除 \`${removed.address}\` (含历史)`, chatId);
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
    return sendMsg(`✅ 1h 阈值 $${fmt(old, 0)} → $${fmt(threshold, 0)}`, chatId);
  }

  if (command === '/threshold24h') {
    const [address, thresholdStr] = args;
    const token = findToken(address);
    if (!token) return sendMsg('❌ 列表中没有这个代币', chatId);
    if (thresholdStr === undefined) {
      return sendMsg('用法: `/threshold24h <地址> <阈值USD>` (0=关闭)', chatId);
    }
    const threshold = Number(thresholdStr);
    if (Number.isNaN(threshold) || threshold < 0) {
      return sendMsg('❌ 阈值必须是 >=0 的数字 (0=关闭)', chatId);
    }
    const old = token.threshold24h || 0;
    token.threshold24h = threshold;
    await saveState();
    const oldStr = old > 0 ? `$${fmt(old, 0)}` : '关闭';
    const newStr = threshold > 0 ? `$${fmt(threshold, 0)}` : '关闭';
    return sendMsg(`✅ 24h 阈值 ${oldStr} → ${newStr}`, chatId);
  }

  if (command === '/check') {
    const [address, chainArg] = args;
    if (!address) return sendMsg('用法: `/check <地址> [链]`', chatId);
    const token = findToken(address) || {
      address,
      chain: (chainArg || DEFAULT_CHAIN).toLowerCase(),
      threshold: Number(DEFAULT_THRESHOLD_USD),
      threshold24h: Number(DEFAULT_THRESHOLD_24H_USD)
    };
    return checkToken(token, { force: true });
  }

  if (command === '/history') {
    const [address, hoursStr] = args;
    if (!address) return sendMsg('用法: `/history <地址> [小时数]`', chatId);
    const token = findToken(address);
    if (!token) return sendMsg('❌ 列表中没有这个代币, 请先 /add', chatId);
    const hours = Math.max(1, Math.min(Number(hoursStr) || 24, HISTORY_DAYS * 24));
    const h = historySummary(token, hours);
    if (!h) return sendMsg(`📭 最近 ${hours}h 还没有历史数据\n(每小时自动记录, 新添加的代币需等待)`, chatId);
    const priceIcon = h.priceChange >= 0 ? '📈' : '📉';
    const priceSign = h.priceChange >= 0 ? '+' : '';
    const liqDelta = h.liqStart > 0 ? ((h.liqEnd - h.liqStart) / h.liqStart) * 100 : 0;
    return sendMsg([
      `📈 *历史趋势 · 过去 ${hours}h*`,
      '',
      `\`${token.address}\``,
      `${token.chain} · ${h.count} 个快照`,
      '',
      `💰 价格: $${fmt(h.priceStart, 6)} → $${fmt(h.priceEnd, 6)}`,
      `   ${priceIcon} ${priceSign}${fmt(h.priceChange)}%`,
      `   \`${h.priceSpark}\``,
      '',
      `🔥 1h 交易量趋势:`,
      `   均值 $${fmt(h.volAvg, 0)} · 峰值 $${fmt(h.volMax, 0)}`,
      `   累计 $${fmt(h.volTotal, 0)}`,
      `   \`${h.volSpark}\``,
      '',
      `🧾 累计笔数: 买 ${h.totalBuys} / 卖 ${h.totalSells}`,
      `💧 流动性变化: ${liqDelta >= 0 ? '+' : ''}${fmt(liqDelta)}%`
    ].join('\n'), chatId);
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
  await loadHistory();
  // 历史数据兼容: 为旧代币补 threshold24h 字段
  for (const t of state.tokens) {
    if (t.threshold24h === undefined) {
      t.threshold24h = Number(DEFAULT_THRESHOLD_24H_USD);
    }
  }

  // 启动时清理一次过期历史
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  for (const key of Object.keys(history)) {
    history[key] = history[key].filter(x => x.t >= cutoff);
    if (history[key].length === 0) delete history[key];
  }

  console.log('🤖 监控启动');
  console.log(`   监控中: ${state.tokens.length} 个代币`);
  console.log(`   历史条目: ${Object.values(history).reduce((s, l) => s + l.length, 0)}`);
  console.log(`   时区: ${TIMEZONE}`);
  console.log(`   数据目录: ${DATA_DIR}`);

  await sendMsg(
    `🤖 *监控已启动*\n` +
    `当前监控 ${state.tokens.length} 个代币\n` +
    `历史保留 ${HISTORY_DAYS} 天\n` +
    `发 /help 查看命令`
  );

  cron.schedule('0 * * * *', hourlyReport, { timezone: TIMEZONE });
  cron.schedule('0 0 * * *', dailyReport, { timezone: TIMEZONE });
  cron.schedule('*/5 * * * *', thresholdCheck, { timezone: TIMEZONE });

  // 进程退出时最后保存一次, 避免丢失最近的内存变更
  const shutdown = async (sig) => {
    console.log(`收到 ${sig}, 正在保存并退出...`);
    try { await saveState(); await saveHistory(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  pollUpdates();
})();
