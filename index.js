import 'dotenv/config';
import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const {
  BOT_TOKEN,
  CHAT_ID,
  DATA_DIR = './data',
  SQLITE_PATH,
  DEFAULT_CHAIN = 'bsc',
  DEFAULT_THRESHOLD_USD = '100000',
  DEFAULT_THRESHOLD_24H_USD = '1000000',
  DEFAULT_PRICE_ALERT_PCT = '10',
  DEFAULT_LIQ_DROP_PCT = '30',
  DEFAULT_IMBALANCE_RATIO = '5',
  HISTORY_DAYS = '30',
  TIMEZONE = 'Asia/Shanghai'
} = process.env;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ 缺少必填环境变量: BOT_TOKEN / CHAT_ID');
  process.exit(1);
}

const CHAT_ID_STR = String(CHAT_ID);
const DB_PATH = SQLITE_PATH || path.join(DATA_DIR, 'bot.db');
const COOLDOWN_1H_MS = 30 * 60 * 1000;
const COOLDOWN_24H_MS = 6 * 60 * 60 * 1000;
const COOLDOWN_PRICE_MS = 30 * 60 * 1000;
const COOLDOWN_LIQ_MS = 30 * 60 * 1000;
const COOLDOWN_IMB_MS = 60 * 60 * 1000;
const LIQ_SNAPSHOT_STALE_MS = 2 * 60 * 60 * 1000;
const IMB_MIN_TXNS = 10;
const HISTORY_RETENTION_MS = Math.max(1, Number(HISTORY_DAYS)) * 24 * 60 * 60 * 1000;

// ========== SQLite ==========
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    chain        TEXT NOT NULL,
    address      TEXT NOT NULL,
    threshold    REAL NOT NULL,
    threshold24h REAL NOT NULL DEFAULT 0,
    added_at     TEXT NOT NULL,
    PRIMARY KEY (chain, address)
  );
  CREATE TABLE IF NOT EXISTS alert_cooldowns (
    key     TEXT PRIMARY KEY,
    last_ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS history (
    chain         TEXT NOT NULL,
    address       TEXT NOT NULL,
    t             INTEGER NOT NULL,
    price_usd     REAL,
    vol_h1        REAL,
    vol_h24       REAL,
    liquidity_usd REAL,
    buys_h1       INTEGER,
    sells_h1      INTEGER,
    PRIMARY KEY (chain, address, t)
  );
  CREATE INDEX IF NOT EXISTS idx_history_key_t ON history (chain, address, t DESC);
`);

// 增量迁移: 给老数据补新列 (ALTER TABLE ADD COLUMN 会用 DEFAULT 回填)
const tokenCols = db.prepare('PRAGMA table_info(tokens)').all().map(r => r.name);
if (!tokenCols.includes('price_alert_pct')) {
  db.exec(`ALTER TABLE tokens ADD COLUMN price_alert_pct REAL NOT NULL DEFAULT ${Number(DEFAULT_PRICE_ALERT_PCT)}`);
}
if (!tokenCols.includes('liq_drop_pct')) {
  db.exec(`ALTER TABLE tokens ADD COLUMN liq_drop_pct REAL NOT NULL DEFAULT ${Number(DEFAULT_LIQ_DROP_PCT)}`);
}
if (!tokenCols.includes('imbalance_ratio')) {
  db.exec(`ALTER TABLE tokens ADD COLUMN imbalance_ratio REAL NOT NULL DEFAULT ${Number(DEFAULT_IMBALANCE_RATIO)}`);
}

const TOKEN_COLS =
  'chain, address, threshold, threshold24h, added_at AS addedAt, ' +
  'price_alert_pct AS priceAlertPct, liq_drop_pct AS liqDropPct, imbalance_ratio AS imbalanceRatio';

const q = {
  listTokens: db.prepare(
    `SELECT ${TOKEN_COLS} FROM tokens ORDER BY added_at ASC`
  ),
  findToken: db.prepare(
    `SELECT ${TOKEN_COLS} FROM tokens WHERE lower(address) = lower(?) LIMIT 1`
  ),
  insertToken: db.prepare(
    'INSERT INTO tokens (chain, address, threshold, threshold24h, added_at, ' +
    'price_alert_pct, liq_drop_pct, imbalance_ratio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  deleteToken: db.prepare('DELETE FROM tokens WHERE chain = ? AND address = ?'),
  setThreshold: db.prepare('UPDATE tokens SET threshold = ? WHERE chain = ? AND address = ?'),
  setThreshold24h: db.prepare('UPDATE tokens SET threshold24h = ? WHERE chain = ? AND address = ?'),
  setPriceAlert: db.prepare('UPDATE tokens SET price_alert_pct = ? WHERE chain = ? AND address = ?'),
  setLiqDrop: db.prepare('UPDATE tokens SET liq_drop_pct = ? WHERE chain = ? AND address = ?'),
  setImbalance: db.prepare('UPDATE tokens SET imbalance_ratio = ? WHERE chain = ? AND address = ?'),

  getCooldown: db.prepare('SELECT last_ts FROM alert_cooldowns WHERE key = ?'),
  setCooldown: db.prepare(
    'INSERT INTO alert_cooldowns (key, last_ts) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET last_ts = excluded.last_ts'
  ),
  deleteCooldownsLike: db.prepare('DELETE FROM alert_cooldowns WHERE key LIKE ?'),

  insertHistory: db.prepare(
    'INSERT OR REPLACE INTO history ' +
    '(chain, address, t, price_usd, vol_h1, vol_h24, liquidity_usd, buys_h1, sells_h1) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  historyRange: db.prepare(
    'SELECT t, price_usd AS priceUsd, vol_h1 AS volH1, vol_h24 AS volH24, ' +
    '       liquidity_usd AS liquidityUsd, buys_h1 AS buysH1, sells_h1 AS sellsH1 ' +
    'FROM history WHERE chain = ? AND address = ? AND t >= ? ORDER BY t ASC'
  ),
  lastSnapshot: db.prepare(
    'SELECT t, liquidity_usd AS liquidityUsd FROM history ' +
    'WHERE chain = ? AND address = ? ORDER BY t DESC LIMIT 1'
  ),
  countHistory: db.prepare('SELECT COUNT(*) AS n FROM history WHERE chain = ? AND address = ?'),
  deleteHistoryFor: db.prepare('DELETE FROM history WHERE chain = ? AND address = ?'),
  pruneHistory: db.prepare('DELETE FROM history WHERE t < ?')
};

// ========== 旧 JSON 自动迁移 ==========
function migrateFromJson() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM tokens').get().n;
  if (existing > 0) return;

  const tokensJson = path.join(DATA_DIR, 'tokens.json');
  const historyJson = path.join(DATA_DIR, 'history.json');
  let migrated = false;

  if (fs.existsSync(tokensJson)) {
    try {
      const raw = JSON.parse(fs.readFileSync(tokensJson, 'utf8'));
      const run = db.transaction(() => {
        for (const t of (raw.tokens || [])) {
          if (!t.address || !t.chain) continue;
          q.insertToken.run(
            String(t.chain).toLowerCase(),
            t.address,
            Number(t.threshold) || Number(DEFAULT_THRESHOLD_USD),
            Number(t.threshold24h) || 0,
            t.addedAt || new Date().toISOString(),
            Number(DEFAULT_PRICE_ALERT_PCT),
            Number(DEFAULT_LIQ_DROP_PCT),
            Number(DEFAULT_IMBALANCE_RATIO)
          );
        }
        for (const [key, ts] of Object.entries(raw.lastAlertTs || {})) {
          q.setCooldown.run(key, Number(ts) || 0);
        }
      });
      run();
      fs.renameSync(tokensJson, `${tokensJson}.migrated`);
      migrated = true;
      console.log('✅ 已从 tokens.json 迁移到 SQLite');
    } catch (err) {
      console.error('迁移 tokens.json 失败:', err.message);
    }
  }

  if (fs.existsSync(historyJson)) {
    try {
      const raw = JSON.parse(fs.readFileSync(historyJson, 'utf8'));
      const run = db.transaction(() => {
        for (const [key, list] of Object.entries(raw || {})) {
          const [chain, address] = key.split(':');
          if (!chain || !address) continue;
          for (const x of (list || [])) {
            if (!x || typeof x.t !== 'number') continue;
            q.insertHistory.run(
              chain, address, x.t,
              x.priceUsd ?? null, x.volH1 ?? null, x.volH24 ?? null,
              x.liquidityUsd ?? null, x.buysH1 ?? null, x.sellsH1 ?? null
            );
          }
        }
      });
      run();
      fs.renameSync(historyJson, `${historyJson}.migrated`);
      migrated = true;
      console.log('✅ 已从 history.json 迁移到 SQLite');
    } catch (err) {
      console.error('迁移 history.json 失败:', err.message);
    }
  }

  if (migrated) console.log('旧 JSON 已改名为 .migrated 备份保留');
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

async function sendMsg(text, chatId = CHAT_ID, reply_markup) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...(reply_markup ? { reply_markup } : {})
  });
}

async function editMsg(chatId, messageId, text, reply_markup) {
  return tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...(reply_markup ? { reply_markup } : {})
  });
}

async function ackCallback(id, text) {
  return tg('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
}

// ========== 按钮 ==========
// callback_data 格式: action|chain|address[|extra], <=64 字节
function tokenKeyboard(chain, address) {
  return {
    inline_keyboard: [[
      { text: '📊 查询', callback_data: `c|${chain}|${address}` },
      { text: '📈 24h 历史', callback_data: `h|${chain}|${address}|24` },
      { text: '🗑 删除', callback_data: `rm|${chain}|${address}` }
    ]]
  };
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📋 我的列表', callback_data: 'list' },
        { text: '🔄 全部刷新', callback_data: 'refresh' }
      ],
      [
        { text: '❓ 帮助', callback_data: 'help' }
      ]
    ]
  };
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
    fdv: Number(top.fdv || 0),
    marketCap: Number(top.marketCap || 0),
    pairCreatedAt: Number(top.pairCreatedAt || 0),
    pairCount: pairs.length,
    topDex: top.dexId,
    url: top.url
  };
}

function ageStr(ms) {
  if (!ms) return '';
  const diffDays = (Date.now() - ms) / (24 * 60 * 60 * 1000);
  if (diffDays < 1) {
    const hrs = Math.floor(diffDays * 24);
    return hrs <= 0 ? '< 1 小时' : `${hrs} 小时`;
  }
  if (diffDays < 30) return `${Math.floor(diffDays)} 天`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} 月`;
  return `${(diffDays / 365).toFixed(1)} 年`;
}

// 返回当前触发的告警列表 (按优先级排序: liq > price > 24h > 1h > imb)
function detectAlerts(s, token) {
  const alerts = [];

  // 流动性骤降: 对比最近一个历史快照
  if (token.liqDropPct > 0) {
    const snap = q.lastSnapshot.get(token.chain, token.address);
    if (snap && snap.liquidityUsd > 0 && (Date.now() - snap.t) <= LIQ_SNAPSHOT_STALE_MS) {
      const dropPct = ((snap.liquidityUsd - s.liquidityUsd) / snap.liquidityUsd) * 100;
      if (dropPct >= token.liqDropPct) {
        alerts.push({
          kind: 'liq',
          cooldown: COOLDOWN_LIQ_MS,
          extra: { prevLiq: snap.liquidityUsd, dropPct }
        });
      }
    }
  }

  // 价格异动
  if (token.priceAlertPct > 0 && Math.abs(s.priceChange1h) >= token.priceAlertPct) {
    alerts.push({ kind: 'price', cooldown: COOLDOWN_PRICE_MS });
  }

  // 24h 成交量
  if (token.threshold24h > 0 && s.volH24 >= token.threshold24h) {
    alerts.push({ kind: '24h', cooldown: COOLDOWN_24H_MS });
  }

  // 1h 成交量
  if (s.volH1 >= token.threshold) {
    alerts.push({ kind: '1h', cooldown: COOLDOWN_1H_MS });
  }

  // 买卖失衡 (至少 N 笔交易避免小样本噪声)
  const totalTxns = s.buysH1 + s.sellsH1;
  if (token.imbalanceRatio > 0 && totalTxns >= IMB_MIN_TXNS) {
    const buys = s.buysH1, sells = s.sellsH1;
    const ratio = sells > 0 ? buys / sells : Infinity;
    if (ratio >= token.imbalanceRatio || (buys > 0 && (1 / ratio) >= token.imbalanceRatio)) {
      alerts.push({
        kind: 'imb',
        cooldown: COOLDOWN_IMB_MS,
        extra: { buys, sells, ratio, side: ratio >= 1 ? 'buy' : 'sell' }
      });
    }
  }

  return alerts;
}

function fmt(n, d = 2) {
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: d, maximumFractionDigits: d
  });
}

function alertHeader(kind) {
  if (kind === '1h') return '🚨 *1h 交易量阈值告警*';
  if (kind === '24h') return '🚨 *24h 交易量阈值告警*';
  if (kind === 'price') return '📢 *价格异动告警*';
  if (kind === 'liq') return '🔥🔥 *流动性骤降告警*';
  if (kind === 'imb') return '⚖️ *买卖失衡告警*';
  return null;
}

function alertLine(kind, s, token, extra) {
  if (kind === '1h') return `⚠️ 1h 交易量超阈值 $${fmt(token.threshold, 0)}`;
  if (kind === '24h') return `⚠️ 24h 交易量超阈值 $${fmt(token.threshold24h, 0)}`;
  if (kind === 'price') {
    const sign = s.priceChange1h >= 0 ? '+' : '';
    return `⚠️ 1h 价格 ${sign}${fmt(s.priceChange1h)}% 超阈值 ±${fmt(token.priceAlertPct, 1)}%`;
  }
  if (kind === 'liq' && extra) {
    return `⚠️ 流动性 $${fmt(extra.prevLiq, 0)} → $${fmt(s.liquidityUsd, 0)} (−${fmt(extra.dropPct, 1)}%)  警惕 rug`;
  }
  if (kind === 'imb' && extra) {
    const sideTxt = extra.side === 'buy' ? '买方强势' : '卖方强势';
    const ratioTxt = isFinite(extra.ratio) ? fmt(extra.ratio) : '∞';
    return `⚠️ ${sideTxt}  买/卖 = ${ratioTxt}x  (买 ${extra.buys} / 卖 ${extra.sells})`;
  }
  return '';
}

function buildMsg(s, token, { alertKind, isHourly, isDaily, extra } = {}) {
  const header = alertHeader(alertKind)
    || (isDaily ? '🌅 *每日交易量报告 (过去 24h)*'
      : isHourly ? '⏰ *每小时交易量报告*'
      : '📊 *交易量快照*');
  const icon1h = s.priceChange1h >= 0 ? '📈' : '📉';
  const sign1h = s.priceChange1h >= 0 ? '+' : '';
  const icon24h = s.priceChange24h >= 0 ? '📈' : '📉';
  const sign24h = s.priceChange24h >= 0 ? '+' : '';
  const avgH1 = (s.buysH1 + s.sellsH1) > 0 ? s.volH1 / (s.buysH1 + s.sellsH1) : 0;
  const avgH24 = (s.buysH24 + s.sellsH24) > 0 ? s.volH24 / (s.buysH24 + s.sellsH24) : 0;
  const bsRatioH1 = s.sellsH1 > 0 ? s.buysH1 / s.sellsH1 : (s.buysH1 > 0 ? Infinity : 1);
  const bsRatioStr = isFinite(bsRatioH1) ? fmt(bsRatioH1) + 'x' : '∞';

  return [
    header, '',
    `*${s.name}* ($${s.symbol}) · ${token.chain}`,
    `💰 $${fmt(s.priceUsd, 6)}`,
    `   ${icon1h} 1h ${sign1h}${fmt(s.priceChange1h)}%   ${icon24h} 24h ${sign24h}${fmt(s.priceChange24h)}%`,
    '',
    `🔥 1h: $${fmt(s.volH1, 0)}  买 ${s.buysH1}/卖 ${s.sellsH1} (${bsRatioStr})  均笔 $${fmt(avgH1, 0)}`,
    `📦 24h: $${fmt(s.volH24, 0)}  买 ${s.buysH24}/卖 ${s.sellsH24}  均笔 $${fmt(avgH24, 0)}`,
    `💧 流动性: $${fmt(s.liquidityUsd, 0)}`,
    s.marketCap > 0 ? `🏷 市值: $${fmt(s.marketCap, 0)}` : '',
    s.fdv > 0 && s.fdv !== s.marketCap ? `💎 FDV: $${fmt(s.fdv, 0)}` : '',
    s.pairCreatedAt > 0 ? `⏳ 上线: ${ageStr(s.pairCreatedAt)}` : '',
    `🔗 ${s.pairCount} 对 (主: ${s.topDex})`,
    '',
    alertLine(alertKind, s, token, extra),
    `[DexScreener](${s.url})`
  ].filter(Boolean).join('\n');
}

// ========== 监控逻辑 ==========
async function checkToken(token, { force = false, isHourly = false, isDaily = false } = {}) {
  const key = `${token.chain}:${token.address}`;
  try {
    const s = await fetchTokenStats(token.address, token.chain);
    // detectAlerts 要先跑 (依赖 lastSnapshot), 然后再插入新快照
    const alerts = detectAlerts(s, token);

    if (isHourly) {
      q.insertHistory.run(
        token.chain, token.address, Date.now(),
        s.priceUsd, s.volH1, s.volH24,
        s.liquidityUsd, s.buysH1, s.sellsH1
      );
    }

    if (isDaily) {
      await sendMsg(buildMsg(s, token, { isDaily: true }));
      return;
    }
    if (isHourly) {
      // 小时报告只发 1 条, 带首个命中的告警类型, 同时刷新所有命中的冷却
      const now = Date.now();
      for (const a of alerts) q.setCooldown.run(`${key}:${a.kind}`, now);
      const primary = alerts[0];
      await sendMsg(buildMsg(s, token, {
        alertKind: primary?.kind,
        extra: primary?.extra,
        isHourly: true
      }));
      return;
    }
    if (force) {
      const primary = alerts[0];
      await sendMsg(buildMsg(s, token, {
        alertKind: primary?.kind,
        extra: primary?.extra
      }));
      return;
    }

    // 常规 5 分钟巡检: 每种告警独立冷却, 分别推送
    const now = Date.now();
    for (const a of alerts) {
      const last = q.getCooldown.get(`${key}:${a.kind}`)?.last_ts || 0;
      if (now - last >= a.cooldown) {
        q.setCooldown.run(`${key}:${a.kind}`, now);
        await sendMsg(buildMsg(s, token, { alertKind: a.kind, extra: a.extra }));
      }
    }
  } catch (err) {
    if (force) await sendMsg(`❌ \`${token.address}\` 查询失败: ${err.message}`);
    console.error(`check ${key} 失败:`, err.message);
  }
}

async function hourlyReport() {
  const tokens = q.listTokens.all();
  if (tokens.length === 0) return;
  for (const token of tokens) {
    await checkToken(token, { isHourly: true });
    await new Promise(r => setTimeout(r, 500));
  }
}

async function dailyReport() {
  const tokens = q.listTokens.all();
  if (tokens.length === 0) return;
  for (const token of tokens) {
    await checkToken(token, { isDaily: true });
    await new Promise(r => setTimeout(r, 500));
  }
  // 日报时顺便清理过期历史
  const removed = q.pruneHistory.run(Date.now() - HISTORY_RETENTION_MS).changes;
  if (removed > 0) console.log(`清理过期历史 ${removed} 条`);
}

async function thresholdCheck() {
  if (new Date().getMinutes() === 0) return;
  const tokens = q.listTokens.all();
  for (const token of tokens) {
    await checkToken(token, {});
    await new Promise(r => setTimeout(r, 500));
  }
}

// ========== 命令处理 ==========
const HELP = `*🤖 代币链上监控*

/menu - 打开主菜单
/list - 查看监控列表 (带操作按钮)
/add <地址> [阈值1h] [阈值24h] [链] - 添加代币
/remove <地址> - 删除代币
/check <地址> [链] - 立即查询一次
/history <地址> [小时数] - 查看历史趋势

*告警阈值* (0 = 关闭)
/threshold <地址> <USD> - 1h 成交量
/threshold24h <地址> <USD> - 24h 成交量
/pricealert <地址> <百分比> - 1h 价格异动 (±)
/liqalert <地址> <百分比> - 流动性骤降 (防 rug)
/imbalance <地址> <比例> - 买卖失衡 (常用 3-10)

支持链: bsc / ethereum / base / solana / polygon / arbitrum
默认链: \`${DEFAULT_CHAIN}\`
默认 1h 阈值: \`$${fmt(Number(DEFAULT_THRESHOLD_USD), 0)}\`
默认 24h 阈值: \`$${fmt(Number(DEFAULT_THRESHOLD_24H_USD), 0)}\`
默认价格告警: \`±${fmt(Number(DEFAULT_PRICE_ALERT_PCT), 1)}%\`
默认液降告警: \`${fmt(Number(DEFAULT_LIQ_DROP_PCT), 0)}%\`
默认失衡阈值: \`${fmt(Number(DEFAULT_IMBALANCE_RATIO), 1)}x\`
历史保留: ${HISTORY_DAYS} 天`;

// 用于 Telegram "/" 自动补全菜单
const BOT_COMMANDS = [
  { command: 'menu', description: '打开主菜单' },
  { command: 'list', description: '查看监控列表' },
  { command: 'add', description: '添加代币监控' },
  { command: 'remove', description: '删除代币' },
  { command: 'check', description: '立即查询代币' },
  { command: 'history', description: '查看历史趋势' },
  { command: 'threshold', description: '1h 成交量阈值' },
  { command: 'threshold24h', description: '24h 成交量阈值' },
  { command: 'pricealert', description: '价格异动告警阈值' },
  { command: 'liqalert', description: '流动性骤降告警' },
  { command: 'imbalance', description: '买卖失衡告警' },
  { command: 'help', description: '使用帮助' }
];

function findToken(addr) {
  if (!addr) return null;
  return q.findToken.get(addr) || null;
}

function tokenEntryText(t) {
  const t24 = t.threshold24h > 0 ? `$${fmt(t.threshold24h, 0)}` : '关闭';
  const pa = t.priceAlertPct > 0 ? `±${fmt(t.priceAlertPct, 1)}%` : '关';
  const ld = t.liqDropPct > 0 ? `${fmt(t.liqDropPct, 0)}%` : '关';
  const ib = t.imbalanceRatio > 0 ? `${fmt(t.imbalanceRatio, 1)}x` : '关';
  const hist = q.countHistory.get(t.chain, t.address).n;
  return [
    `\`${t.address}\``,
    `${t.chain} · 1h $${fmt(t.threshold, 0)} · 24h ${t24} · 历史 ${hist} 条`,
    `⚙️ 价格 ${pa} · 液降 ${ld} · 失衡 ${ib}`
  ].join('\n');
}

async function sendTokenList(chatId) {
  const tokens = q.listTokens.all();
  if (tokens.length === 0) {
    return sendMsg(
      '📭 还没有监控任何代币\n\n发 `/add <地址>` 添加, 或点下方按钮查看帮助',
      chatId,
      { inline_keyboard: [[{ text: '❓ 帮助', callback_data: 'help' }]] }
    );
  }
  await sendMsg(`*📋 监控中 ${tokens.length} 个代币*`, chatId);
  // 逐条发送, 每条自带按钮, 便于点击操作
  const MAX = 30;
  for (const t of tokens.slice(0, MAX)) {
    await sendMsg(tokenEntryText(t), chatId, tokenKeyboard(t.chain, t.address));
    await new Promise(r => setTimeout(r, 100));
  }
  if (tokens.length > MAX) {
    await sendMsg(`...还有 ${tokens.length - MAX} 个未显示, 过多时建议精简`, chatId);
  }
}

async function sendHistorySummary(token, hours, chatId) {
  const h = historySummary(token, hours);
  if (!h) return sendMsg(`📭 最近 ${hours}h 还没有历史数据\n(每小时自动记录, 新添加的代币需等待)`, chatId);
  const priceIcon = h.priceChange >= 0 ? '📈' : '📉';
  const priceSign = h.priceChange >= 0 ? '+' : '';
  const liqDelta = h.liqStart > 0 ? ((h.liqEnd - h.liqStart) / h.liqStart) * 100 : 0;
  const kb = {
    inline_keyboard: [[
      { text: '24h', callback_data: `h|${token.chain}|${token.address}|24` },
      { text: '72h', callback_data: `h|${token.chain}|${token.address}|72` },
      { text: '7d', callback_data: `h|${token.chain}|${token.address}|168` }
    ]]
  };
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
  ].join('\n'), chatId, kb);
}

async function refreshAll(chatId) {
  const tokens = q.listTokens.all();
  if (tokens.length === 0) return sendMsg('📭 没有监控的代币', chatId);
  await sendMsg(`🔄 正在刷新 ${tokens.length} 个代币...`, chatId);
  for (const token of tokens) {
    await checkToken(token, { force: true });
    await new Promise(r => setTimeout(r, 500));
  }
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
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const recent = q.historyRange.all(token.chain, token.address, cutoff);
  if (recent.length === 0) return null;

  const vols = recent.map(x => x.volH1 || 0);
  const prices = recent.map(x => x.priceUsd || 0);
  const liqs = recent.map(x => x.liquidityUsd || 0);
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
    return sendMsg(HELP, chatId, mainMenuKeyboard());
  }

  if (command === '/menu') {
    return sendMsg('*🤖 主菜单*\n选择操作或发送命令:', chatId, mainMenuKeyboard());
  }

  if (command === '/list') {
    return sendTokenList(chatId);
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
      q.insertToken.run(
        chain, address, threshold, threshold24h, new Date().toISOString(),
        Number(DEFAULT_PRICE_ALERT_PCT),
        Number(DEFAULT_LIQ_DROP_PCT),
        Number(DEFAULT_IMBALANCE_RATIO)
      );
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
    const token = findToken(address);
    if (!token) return sendMsg('❌ 列表中没有这个代币', chatId);
    const txn = db.transaction(() => {
      q.deleteToken.run(token.chain, token.address);
      q.deleteCooldownsLike.run(`${token.chain}:${token.address}:%`);
      q.deleteHistoryFor.run(token.chain, token.address);
    });
    txn();
    return sendMsg(`🗑 已删除 \`${token.address}\` (含历史)`, chatId);
  }

  if (command === '/threshold') {
    const [address, thresholdStr] = args;
    const token = findToken(address);
    if (!token) return sendMsg('❌ 列表中没有这个代币', chatId);
    const threshold = Number(thresholdStr);
    if (!threshold || threshold <= 0) return sendMsg('用法: `/threshold <地址> <阈值USD>`', chatId);
    q.setThreshold.run(threshold, token.chain, token.address);
    return sendMsg(`✅ 1h 阈值 $${fmt(token.threshold, 0)} → $${fmt(threshold, 0)}`, chatId);
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
    q.setThreshold24h.run(threshold, token.chain, token.address);
    const oldStr = token.threshold24h > 0 ? `$${fmt(token.threshold24h, 0)}` : '关闭';
    const newStr = threshold > 0 ? `$${fmt(threshold, 0)}` : '关闭';
    return sendMsg(`✅ 24h 阈值 ${oldStr} → ${newStr}`, chatId);
  }

  if (command === '/pricealert') {
    const [address, pctStr] = args;
    const token = findToken(address);
    if (!token) return sendMsg('❌ 列表中没有这个代币', chatId);
    if (pctStr === undefined) return sendMsg('用法: `/pricealert <地址> <百分比>` (0=关闭)', chatId);
    const pct = Number(pctStr);
    if (Number.isNaN(pct) || pct < 0) return sendMsg('❌ 百分比必须 >=0 (0=关闭)', chatId);
    q.setPriceAlert.run(pct, token.chain, token.address);
    const oldStr = token.priceAlertPct > 0 ? `±${fmt(token.priceAlertPct, 1)}%` : '关闭';
    const newStr = pct > 0 ? `±${fmt(pct, 1)}%` : '关闭';
    return sendMsg(`✅ 价格告警阈值 ${oldStr} → ${newStr}`, chatId);
  }

  if (command === '/liqalert') {
    const [address, pctStr] = args;
    const token = findToken(address);
    if (!token) return sendMsg('❌ 列表中没有这个代币', chatId);
    if (pctStr === undefined) return sendMsg('用法: `/liqalert <地址> <百分比>` (0=关闭)', chatId);
    const pct = Number(pctStr);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) return sendMsg('❌ 百分比必须在 0-100 之间 (0=关闭)', chatId);
    q.setLiqDrop.run(pct, token.chain, token.address);
    const oldStr = token.liqDropPct > 0 ? `${fmt(token.liqDropPct, 0)}%` : '关闭';
    const newStr = pct > 0 ? `${fmt(pct, 0)}%` : '关闭';
    return sendMsg(`✅ 流动性骤降阈值 ${oldStr} → ${newStr}`, chatId);
  }

  if (command === '/imbalance') {
    const [address, ratioStr] = args;
    const token = findToken(address);
    if (!token) return sendMsg('❌ 列表中没有这个代币', chatId);
    if (ratioStr === undefined) return sendMsg('用法: `/imbalance <地址> <比例>` (0=关闭, 常用 3-10)', chatId);
    const ratio = Number(ratioStr);
    if (Number.isNaN(ratio) || ratio < 0) return sendMsg('❌ 比例必须 >=0 (0=关闭)', chatId);
    q.setImbalance.run(ratio, token.chain, token.address);
    const oldStr = token.imbalanceRatio > 0 ? `${fmt(token.imbalanceRatio, 1)}x` : '关闭';
    const newStr = ratio > 0 ? `${fmt(ratio, 1)}x` : '关闭';
    return sendMsg(`✅ 买卖失衡阈值 ${oldStr} → ${newStr}`, chatId);
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
    const maxHours = Math.max(1, Number(HISTORY_DAYS)) * 24;
    const hours = Math.max(1, Math.min(Number(hoursStr) || 24, maxHours));
    return sendHistorySummary(token, hours, chatId);
  }

  return sendMsg('❓ 未知命令，发 /help 查看用法', chatId);
}

// ========== 按钮回调 ==========
async function handleCallback(cb) {
  const chatId = String(cb.message?.chat?.id || '');
  const messageId = cb.message?.message_id;
  if (chatId !== CHAT_ID_STR) {
    await ackCallback(cb.id, '未授权');
    return;
  }
  // 立即 ack, 消除按钮 loading 态; 具体动作异步
  ackCallback(cb.id).catch(() => {});

  const parts = (cb.data || '').split('|');
  const action = parts[0];

  try {
    if (action === 'list') return sendTokenList(chatId);
    if (action === 'help') return sendMsg(HELP, chatId, mainMenuKeyboard());
    if (action === 'menu') return sendMsg('*🤖 主菜单*', chatId, mainMenuKeyboard());
    if (action === 'refresh') return refreshAll(chatId);

    if (action === 'c') {
      const [, chain, address] = parts;
      const token = findToken(address) || {
        address, chain,
        threshold: Number(DEFAULT_THRESHOLD_USD),
        threshold24h: Number(DEFAULT_THRESHOLD_24H_USD)
      };
      return checkToken(token, { force: true });
    }

    if (action === 'h') {
      const [, chain, address, hoursStr] = parts;
      const token = findToken(address);
      if (!token) return sendMsg('❌ 代币已不在列表中', chatId);
      const maxHours = Math.max(1, Number(HISTORY_DAYS)) * 24;
      const hours = Math.max(1, Math.min(Number(hoursStr) || 24, maxHours));
      return sendHistorySummary(token, hours, chatId);
    }

    if (action === 'rm') {
      const [, chain, address] = parts;
      const token = findToken(address);
      if (!token) {
        return editMsg(chatId, messageId, '❌ 代币已不存在');
      }
      return editMsg(
        chatId, messageId,
        [
          '⚠️ *确认删除?*',
          '',
          `\`${token.address}\``,
          `${token.chain} · 含全部历史数据`
        ].join('\n'),
        {
          inline_keyboard: [[
            { text: '✅ 确认', callback_data: `rmy|${token.chain}|${token.address}` },
            { text: '❌ 取消', callback_data: `rmn|${token.chain}|${token.address}` }
          ]]
        }
      );
    }

    if (action === 'rmy') {
      const [, chain, address] = parts;
      const token = findToken(address);
      if (!token) return editMsg(chatId, messageId, '❌ 代币已不存在');
      db.transaction(() => {
        q.deleteToken.run(token.chain, token.address);
        q.deleteCooldownsLike.run(`${token.chain}:${token.address}:%`);
        q.deleteHistoryFor.run(token.chain, token.address);
      })();
      return editMsg(chatId, messageId, `🗑 已删除\n\`${token.address}\``);
    }

    if (action === 'rmn') {
      const [, chain, address] = parts;
      const token = findToken(address);
      if (!token) return editMsg(chatId, messageId, '❌ 代币已不存在');
      return editMsg(chatId, messageId, tokenEntryText(token), tokenKeyboard(token.chain, token.address));
    }
  } catch (err) {
    console.error('回调错误:', err.message);
  }
}

// ========== Long polling ==========
let updateOffset = 0;
async function pollUpdates() {
  try {
    const data = await tg('getUpdates', {
      offset: updateOffset,
      timeout: 25,
      allowed_updates: ['message', 'callback_query']
    });
    for (const upd of data.result || []) {
      updateOffset = upd.update_id + 1;

      if (upd.callback_query) {
        handleCallback(upd.callback_query).catch(err => console.error('回调错误:', err));
        continue;
      }

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
  migrateFromJson();

  // 启动时清理过期历史
  const removed = q.pruneHistory.run(Date.now() - HISTORY_RETENTION_MS).changes;
  if (removed > 0) console.log(`启动清理过期历史 ${removed} 条`);

  const tokenCount = q.listTokens.all().length;
  const historyCount = db.prepare('SELECT COUNT(*) AS n FROM history').get().n;

  console.log('🤖 监控启动');
  console.log(`   SQLite: ${DB_PATH}`);
  console.log(`   监控中: ${tokenCount} 个代币`);
  console.log(`   历史条目: ${historyCount}`);
  console.log(`   时区: ${TIMEZONE}`);

  // 注册 Telegram "/" 自动补全菜单
  await tg('setMyCommands', { commands: BOT_COMMANDS });

  await sendMsg(
    `🤖 *监控已启动*\n` +
    `当前监控 ${tokenCount} 个代币\n` +
    `历史保留 ${HISTORY_DAYS} 天\n` +
    `点击下方按钮或发 /menu`,
    CHAT_ID,
    mainMenuKeyboard()
  );

  cron.schedule('0 * * * *', hourlyReport, { timezone: TIMEZONE });
  cron.schedule('0 0 * * *', dailyReport, { timezone: TIMEZONE });
  cron.schedule('*/5 * * * *', thresholdCheck, { timezone: TIMEZONE });

  // 优雅退出: 关闭 WAL 检查点
  const shutdown = (sig) => {
    console.log(`收到 ${sig}, 关闭数据库...`);
    try { db.close(); } catch (err) { console.error('关闭失败:', err.message); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  pollUpdates();
})();
