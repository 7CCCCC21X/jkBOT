import 'dotenv/config';
import cron from 'node-cron';

const {
  BOT_TOKEN,
  CHAT_ID,
  TOKEN_ADDRESS,
  VOLUME_THRESHOLD_USD = '100000',
  CHAIN = 'bsc',
  TIMEZONE = 'Asia/Shanghai'
} = process.env;

if (!BOT_TOKEN || !CHAT_ID || !TOKEN_ADDRESS) {
  console.error('❌ 缺少必填环境变量: BOT_TOKEN / CHAT_ID / TOKEN_ADDRESS');
  process.exit(1);
}

const threshold = Number(VOLUME_THRESHOLD_USD);
const COOLDOWN_MS = 30 * 60 * 1000;
let lastAlertTs = 0;

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    })
  });
  if (!res.ok) {
    console.error('Telegram 发送失败:', res.status, await res.text());
  }
}

async function fetchTokenStats() {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_ADDRESS}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener 请求失败: ${res.status}`);
  const data = await res.json();

  const pairs = (data.pairs || []).filter(p => p.chainId === CHAIN);
  if (pairs.length === 0) {
    throw new Error(`在 ${CHAIN} 链上找不到该代币的交易对`);
  }

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

function fmt(n, digits = 2) {
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function buildMessage(s, { isAlert, isHourly }) {
  const header = isAlert
    ? '🚨 *交易量阈值告警*'
    : isHourly
      ? '⏰ *每小时交易量报告*'
      : '📊 *交易量快照*';
  const icon = s.priceChange1h >= 0 ? '📈' : '📉';
  const sign = s.priceChange1h >= 0 ? '+' : '';

  return [
    header, '',
    `*${s.name}* ($${s.symbol})`,
    `💰 价格: $${fmt(s.priceUsd, 6)}`,
    `${icon} 1h 涨跌: ${sign}${fmt(s.priceChange1h)}%`,
    '',
    `🔥 *1h 交易量: $${fmt(s.volH1, 0)}*`,
    `   买入 ${s.buysH1} 笔 / 卖出 ${s.sellsH1} 笔`,
    `📦 24h 交易量: $${fmt(s.volH24, 0)}`,
    `💧 流动性: $${fmt(s.liquidityUsd, 0)}`,
    `🔗 交易对: ${s.pairCount} 个 (主: ${s.topDex})`,
    '',
    isAlert ? `⚠️ 已超过阈值 $${fmt(threshold, 0)}` : '',
    `[DexScreener 详情](${s.url})`
  ].filter(Boolean).join('\n');
}

async function hourlyReport() {
  try {
    const s = await fetchTokenStats();
    const isAlert = s.volH1 >= threshold;
    if (isAlert) lastAlertTs = Date.now();
    await sendTelegram(buildMessage(s, { isAlert, isHourly: true }));
    console.log(new Date().toISOString(), '✅ 整点推送, 1h vol =', s.volH1);
  } catch (err) {
    console.error('整点任务失败:', err.message);
    await sendTelegram(`❌ 监控出错: ${err.message}`).catch(() => {});
  }
}

async function thresholdCheck() {
  try {
    const now = new Date();
    if (now.getMinutes() === 0) return;
    if (Date.now() - lastAlertTs < COOLDOWN_MS) return;

    const s = await fetchTokenStats();
    if (s.volH1 < threshold) return;

    lastAlertTs = Date.now();
    await sendTelegram(buildMessage(s, { isAlert: true, isHourly: false }));
    console.log(new Date().toISOString(), '🚨 阈值告警, 1h vol =', s.volH1);
  } catch (err) {
    console.error('阈值检查失败:', err.message);
  }
}

console.log('🤖 BNB Chain 代币交易量监控启动');
console.log('   代币:', TOKEN_ADDRESS);
console.log('   阈值: $' + fmt(threshold, 0));
console.log('   时区:', TIMEZONE);

hourlyReport();
cron.schedule('0 * * * *', hourlyReport, { timezone: TIMEZONE });
cron.schedule('*/5 * * * *', thresholdCheck, { timezone: TIMEZONE });
