#!/usr/bin/env node
/**
 * 批量标记知识星球话题质量（DRY/WATER）。
 * - 默认 dry-run：只输出建议，不写线上
 * - --apply：实际调用 POST /admin/zsxq/quality
 * - --pages=N：处理最近 N 页（默认 5）
 * - --size=N：每页条数（默认 30）
 * - --out=FILE：把拿不准的写入 JSONL（默认 /tmp/opencode/zsxq-uncertain.jsonl）
 *
 * 凭据：仓库根 online-token.txt（三行：baseURL, username, password）
 * 只标记高置信项；拿不准的跳过，必要时再用 AI 判断。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const has = (k) => args.includes(`--${k}`);
const pages = Math.max(1, Number(flag('pages', '5')));
const size = Math.max(1, Math.min(100, Number(flag('size', '30'))));
const apply = has('apply');
const outFile = flag('out', '/tmp/opencode/zsxq-uncertain.jsonl');
const root = process.env.JT_REPO_ROOT || process.cwd();
const credFile = path.join(root, 'online-token.txt');

let base, username, password;
try {
  [base, username, password] = fs.readFileSync(credFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
} catch {
  console.error('MISSING_CRED: online-token.txt not found or unreadable');
  process.exit(2);
}
if (!base || !username || !password) { console.error('MISSING_CRED: need base/username/password'); process.exit(2); }

function encodeWebPassword(raw) {
  const codes = [];
  for (let i = 0; i < raw.length; i++) codes.push(raw.codePointAt(i) + i + 2);
  return btoa(String.fromCodePoint(...codes));
}

async function api(p, {method='GET', cookie='', body} = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { ...(cookie ? {Cookie: cookie} : {}), ...(body ? {'Content-Type':'application/json'} : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = await r.json().catch(() => null);
  return {r, json};
}

const cookieFile = path.join(root, 'online-cookie.txt');
function loadCachedCookie() {
  try { const [b,c] = fs.readFileSync(cookieFile,'utf8').split(/\r?\n/).map(s=>s.trim()); if (b===base && c) return c; } catch {}
  return '';
}
function saveCachedCookie(c) { try { fs.writeFileSync(cookieFile, `${base}\n${c}\n`, 'utf8'); } catch {} }
async function checkCookie(cookie) {
  const {json, r} = await api('/admin/public/login-info', {headers:{Cookie:cookie}});
  return r.status===200 && (json?.code===0 || json?.code===200);
}
async function login() {
  const cached = loadCachedCookie();
  if (cached && await checkCookie(cached).catch(()=>false)) return cached;
  const {r, json} = await api('/admin/auth/login', {method:'POST', body:{username, password: encodeWebPassword(password)}});
  const cookie = (r.headers.getSetCookie?.() ?? []).map(s => s.split(';')[0]).filter(Boolean).join('; ');
  if (json?.success && cookie) { saveCachedCookie(cookie); return cookie; }
  // 账号已在别处登录时，尝试复用缓存 cookie（可能仍有效）
  if (cached && await checkCookie(cached).catch(()=>false)) return cached;
  throw new Error(`login failed: ${json?.message || r.status}`);
}

function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function plainText(t) {
  return norm(String(t || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&[a-z]+;/gi, ' '));
}

const WATER_RE = [
  /到期|续费|告别|再见|下车|留个纪念|感恩遇见|感谢陪伴|祝.{0,8}(早日康复|健康|顺遂|长虹|财源|安康|万事如意)/,
  /大奇迹日|奇迹日/,
  /建(个)?群|微信群|交流群/,
  /签到|打卡$/,
];
const WATER_SHORT_RE = /^[\s\p{P}\p{S}\p{Emoji_Presentation}\p{Extended_Pictographic}A-Za-z0-9😂🤣😭😅🙏👍👌💕❤️🔥💪😁😀🤝👏🥹😄😆😋😎😍😘]*$/u;
const INVEST_KW = /股票|股市|大盘|指数|仓位|调仓|补仓|加仓|减仓|估值|市盈|市净|股息|分红|回撤|周期|财报|营收|利润|现金流|负债|基本面|技术面|龙头|赛道|宏观|利率|通胀|债券|黄金|原油|汇率|港股|美股|A股|ETF|基金|持仓|止损|风控|资产配置|供需|产能|政策|行业|个股|买入|卖出/;

function classify(t) {
  const text = plainText((t.articleContent || '') || (t.digest || '') || (t.articleTitle || ''));
  const title = norm(t.articleTitle || '');
  const digest = norm(t.digest || '');
  const short = text.length <= 18;
  const veryShort = text.length <= 8;

  // High-confidence WATER
  if (veryShort) return {quality:'WATER', reason:'极短内容，无信息量'};
  if (WATER_RE.some(re => re.test(text)) && text.length < 120 && !INVEST_KW.test(text)) {
    return {quality:'WATER', reason:'告别/祝福/情绪类短帖'};
  }
  if (short && WATER_SHORT_RE.test(text) && !INVEST_KW.test(text)) {
    return {quality:'WATER', reason:'短情绪/表情帖'};
  }
  if (short && !INVEST_KW.test(text) && /哈哈|呵呵|[流泪][大哭][呲牙][捂脸]|牛啊|厉害了|太好了|完了|惨了/.test(text)) {
    return {quality:'WATER', reason:'短情绪帖'};
  }

  // High-confidence DRY: only very clear cases. Be conservative.
  // Owner long-form post with investment content is often DRY, but still be careful.
  const owner = t.author === '陈泽鑫';
  if (owner && text.length >= 80 && INVEST_KW.test(text)) {
    return {quality:'DRY', reason:'星主较长投资内容'};
  }
  if (text.length >= 180 && (INVEST_KW.test(text) || /分析|逻辑|策略|风险|机会|结论/.test(text))) {
    // Long content with investment keywords - likely useful, but not 100%. Keep conservative: require 2+ signals.
    const signals = [INVEST_KW.test(text), /分析|逻辑|策略|风险|机会|结论|复盘|数据/.test(text), /因为|所以|如果|但是|不过|因此/.test(text)].filter(Boolean).length;
    if (signals >= 2) return {quality:'DRY', reason:'较长且含投资分析信号'};
  }

  return {quality:null, reason:'uncertain'};
}

const cookie = await login();
console.log(`LOGIN_OK base=${base} apply=${apply} pages=${pages} size=${size}`);

fs.mkdirSync(path.dirname(outFile), {recursive: true});
const uncertain = fs.createWriteStream(outFile, {flags:'a'});

let stats = {seen:0, unmarked:0, dry:0, water:0, skip:0, applied:0, failed:0};
for (let page=0; page<pages; page++) {
  const q = new URLSearchParams({page:String(page), size:String(size), sort:'sourceCreateTime', direction:'DESC'});
  const {json} = await api('/admin/zsxq/page?' + q.toString(), {method:'POST', cookie});
  const list = json?.data?.content || [];
  if (!list.length) break;
  for (const t of list) {
    stats.seen++;
    if (t.quality) continue;
    stats.unmarked++;
    const text = plainText((t.articleContent || '') || (t.digest || '') || (t.articleTitle || ''));
    const c = classify(t);
    const rec = {id: t.id, topicId: t.topicId, author: t.author, time: t.sourceCreateTime, quality: c.quality, reason: c.reason, title: norm(t.articleTitle||''), digest: norm(t.digest||'').slice(0,160)};
    if (!c.quality) {
      stats.skip++;
      uncertain.write(JSON.stringify(rec) + '\n');
      console.log(`SKIP\t${t.id}\t${t.author}\t${norm(t.digest||'').slice(0,60)}`);
      continue;
    }
    if (c.quality === 'DRY') stats.dry++; else stats.water++;
    if (apply) {
      const {json: jr} = await api('/admin/zsxq/quality', {method:'POST', cookie, body:{id:t.id, quality:c.quality}});
      if (jr?.success) { stats.applied++; console.log(`APPLY\t${c.quality}\t${t.id}\t${t.author}\t${c.reason}`); }
      else { stats.failed++; console.log(`FAIL\t${c.quality}\t${t.id}\t${jr?.message || jr?.code || 'unknown'}`); }
      await new Promise(r => setTimeout(r, 120));
    } else {
      console.log(`DRYRUN\t${c.quality}\t${t.id}\t${t.author}\t${c.reason}\t${norm(t.digest||'').slice(0,50)}`);
    }
  }
  console.log(`PAGE_DONE\t${page}\tseen=${stats.seen}\tunmarked=${stats.unmarked}\tdry=${stats.dry}\twater=${stats.water}\tskip=${stats.skip}\tapplied=${stats.applied}\tfailed=${stats.failed}`);
  await new Promise(r => setTimeout(r, 150));
}
uncertain.end();
console.log('SUMMARY', JSON.stringify(stats));
