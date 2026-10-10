'use strict';

/**
 * 第 2 步：给扫描结果补上豆瓣元数据（评分/类型/国家/时长/简介/导演/演员）+ 本地海报
 *
 *   node src/fetch.js                    增量抓一遍（已成功的跳过，可随时中断续跑）
 *   node src/fetch.js --forever          常驻模式：一直重试直到全部抓完（推荐在豆瓣限流期间用）
 *   node src/fetch.js --retry-failed     把之前失败条目的重试次数清零，只给它们再来一次的机会
 *   node src/fetch.js --refresh          忽略缓存，全部重抓
 *   node src/fetch.js --limit 20         只处理前 20 部（调试）
 *
 * 常驻模式的行为：
 *   - 每轮遍历所有「未完成」条目；已成功的直接跳过
 *   - 单条最多尝试 maxTriesPerMovie 次，超过后标记为“放弃”（避免无限重试）
 *   - 如果一整轮毫无进展（说明还在被限流），就等待 retryWaitMs 再来一轮
 *   - 每抓完一条就落盘，随时中断都不丢进度
 *
 * 输入： data/scan-result.json  （第 1 步产物）
 * 输出： data/library.json      （影片库）
 *        data/posters/<id>.jpg  （海报缓存）
 *        data/fetch-log.txt     （逐条日志，UTF-8 可靠记录）
 */

const fs = require('fs');
const path = require('path');
const D = require('./douban');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const DATA_DIR = path.join(ROOT, CONFIG.dataDir || 'data');
const POSTER_DIR = path.join(DATA_DIR, 'posters');
const LIB_PATH = path.join(DATA_DIR, 'library.json');
const SCAN_PATH = path.join(DATA_DIR, 'scan-result.json');
const LOG_PATH = path.join(DATA_DIR, 'fetch-log.txt');

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const FOREVER = args.includes('--forever');
const RETRY_FAILED = args.includes('--retry-failed');
const REMATCH = args.includes('--rematch');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) || 0 : 0;
})();

const DB = CONFIG.douban || {};
const MAX_TRIES = Number(DB.maxTriesPerMovie) || 4;
const RETRY_WAIT_MS = Number(DB.retryWaitMs) || 30 * 60 * 1000;
const RETRY_WAIT_MAX_MS = Number(DB.retryWaitMaxMs) || 4 * 60 * 60 * 1000;
const IDLE_WAIT_MS = Number(DB.idleWaitMs) || 5000;

if (!fs.existsSync(SCAN_PATH)) {
  console.error('[error] 找不到 data/scan-result.json，请先运行:  node src/scan.js');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString('zh-CN');

// ---------------------------------------------------------------- 匹配

const norm = (s) =>
  String(s || '')
    .replace(/[\s·:：\-_.,，。、！？!?'"“”‘’()（）\[\]【】&]/g, '')
    .toLowerCase();

/** 更宽松的归一化：额外去掉虚词、把中文/罗马数字统一成阿拉伯数字 */
const ROMAN = [['iii', '3'], ['ii', '2'], ['iv', '4'], ['i', '1']];
function normLoose(s) {
  let t = norm(s)
    .replace(/[之的了个与和及]/g, '')
    .replace(/第(?=[0-9一二三四五六七八九十])/g, '');
  const cnNum = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
  t = t.replace(/[一二三四五六七八九十]/g, (c) => cnNum[c] || c);
  for (const [r, n] of ROMAN) t = t.replace(new RegExp(r, 'g'), n);
  return t;
}
/** 再去掉所有数字（用来对付「黄飞鸿之二」vs「黄飞鸿」这类） */
function normNoNum(s) { return normLoose(s).replace(/[0-9]/g, ''); }

/**
 * 从候选里挑最可能的一部
 * 计分：
 *   标题完全一致 +100；互相包含 +55；宽松（去虚词）一致/包含 +45；去数字后一致 +40
 *   年份一致 +45；年份 ±1 +12；类型是电影 +4
 * 阈值 50：>=100 high，50~99 medium
 */
function pickCandidate(candidates, cn, en, year) {
  const wantCn = norm(cn);
  const wantEn = norm(en);
  const wantCnL = normLoose(cn);
  const wantCnN = normNoNum(cn);
  const wantEnL = normLoose(en);
  const wantEnN = normNoNum(en);
  let best = null;

  for (const c of candidates) {
    const t = norm(c.title);
    const sub = norm(c.sub_title);
    const tL = normLoose(c.title);
    const subL = normLoose(c.sub_title);
    const tN = normNoNum(c.title);
    const subN = normNoNum(c.sub_title);
    const y = c.year || null;
    let score = 0;
    let exactTitle = false;        // 标题是否一字不差

    // ---- 标题匹配 ----
    if (wantCn && t === wantCn) { score += 100; exactTitle = true; }
    else if (wantEn && t === wantEn) { score += 100; exactTitle = true; }
    else if (wantCn && wantCn.length >= 2 && t && (t.includes(wantCn) || wantCn.includes(t))) score += 55;
    else if (wantEn && sub && sub === wantEn) score += 55;
    else if (wantEnL && wantEnL.length >= 3 && subL && (subL.includes(wantEnL) || wantEnL.includes(subL))) score += 45;
    else if (wantCnL && wantCnL.length >= 3 && tL && (tL === wantCnL || tL.includes(wantCnL) || wantCnL.includes(tL))) score += 45;
    else if (wantCnN && wantCnN.length >= 3 && tN === wantCnN) score += 40;
    else if (wantEnN && wantEnN.length >= 4 && subN === wantEnN) score += 40;

    // ---- 年份（让年份起决定性作用：一致 +60，差 1 年不加分，冲突则扣分）----
    let yearClash = false;
    if (year && y === year) score += 60;
    else if (year && y && Math.abs(y - year) > 1) { score -= 30; yearClash = true; }

    // ★ 最典型的错配陷阱：标题一字不差、年份却差好几年。
    //   实例：某系列片第 6 部（2009）搜不到，回退用系列中文名去搜，撞上 2004 的第一部 ——
    //   标题完全一致拿满 100 分，年份只扣 30，74 分照样越过 50 分阈值，被当 high 静默收下。
    //   所以这种情况强行压到阈值以下，降级成「待确认」交给人工裁决，不替用户做主。
    //   代价：本地年份被下载站乱标的片子（年份对但写错）也会落到待确认 —— 宁可多问一次。
    if (exactTitle && yearClash) score = Math.min(score, 40);

    if (c.type === 'movie') score += 4;

    if (!best || score > best.score) best = { c, score };
  }

  if (!best || best.score < 50) return null;
  return { id: best.c.id, confidence: best.score >= 100 ? 'high' : 'medium', picked: best.c, score: best.score };
}

// ---------------------------------------------------------------- 加载

const scan = JSON.parse(fs.readFileSync(SCAN_PATH, 'utf8'));
const all = Array.isArray(scan.merged) ? scan.merged : [];
const todo = LIMIT > 0 ? all.slice(0, LIMIT) : all;

let lib = { generatedAt: null, count: 0, movies: [] };
if (fs.existsSync(LIB_PATH) && !REFRESH) {
  try {
    const prev = JSON.parse(fs.readFileSync(LIB_PATH, 'utf8'));
    if (prev && Array.isArray(prev.movies)) lib = prev;
  } catch { /* 损坏则重建 */ }
}
if (REFRESH) lib = { generatedAt: null, count: 0, movies: [] };

const byKey = new Map(lib.movies.map((m) => [m.key, m]));

// --retry-failed：把之前失败的条目的重试次数清零，让它们有机会再来一次
// （已成功的 ok 条目不受影响）
if (RETRY_FAILED) {
  let reset = 0;
  for (const m of lib.movies) {
    if (m.status !== 'ok' && m.tries) { m.tries = 0; reset++; }
  }
  console.log('[retry-failed] 已重置 ' + reset + ' 条失败记录的重试次数');
}

// --rematch：揪出「错配」的记录并重置，让它们重新匹配
//   判定错配的两种情况：
//     a) 多个本地条目指向同一个豆瓣条目（典型：合集目录里几部片中文名相同）
//     b) 本地年份与豆瓣年份相差超过 1 年
if (REMATCH) {
  // ★ 手动绑定的条目（在网页上「手动搜索豆瓣条目」选定的）是人工确认过的结果，
  //   不能被自动判定推翻 —— 所以下面两条规则都把它排除在外。
  //   最容易误伤的是「年份差」那条：下载站的文件名年份经常是乱标的，
  //   用户手动绑对了，本地年份却和豆瓣差了好几年。
  const isManual = (m) => !!(m && (m.reason === 'manual'
    || (m.douban && m.douban.confidence === 'manual')));

  const suspects = new Set();
  const manualKept = new Set();
  const mark = (m) => { if (isManual(m)) manualKept.add(m); else suspects.add(m); };

  const byId = new Map();
  for (const m of lib.movies) {
    const id = m.douban && m.douban.id;
    if (!id || m.status !== 'ok') continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(m);
  }
  for (const [, list] of byId) {
    if (list.length > 1) for (const m of list) mark(m);
  }
  for (const m of lib.movies) {
    if (m.status !== 'ok' || !m.douban || !m.douban.year || !m.year) continue;
    if (Math.abs(m.douban.year - m.year) > 1) mark(m);
  }

  for (const m of suspects) {
    console.log('   重置 [' + (m.cn || m.en || '?') + ']  '
      + (m.versions && m.versions[0] ? m.versions[0].fileName.slice(0, 60) : '')
      + '   （原匹配：' + ((m.douban && m.douban.title) || '?') + ' ' + ((m.douban && m.douban.year) || '') + '）');
    m.tries = 0;
    m.status = 'unmatched';
    m.reason = 'rematch';
    m.douban = null;
  }
  console.log('[rematch] 共发现 ' + suspects.size + ' 条疑似错配，已重置，接下来会重新匹配');
  if (manualKept.size) {
    console.log('[rematch] 另有 ' + manualKept.size + ' 条命中了判定规则，'
      + '但属于你手动绑定的，已保留不动：');
    for (const m of manualKept) {
      console.log('   · ' + (m.cn || m.en || '?') + '  →  '
        + ((m.douban && m.douban.title) || '?') + ' ' + ((m.douban && m.douban.year) || ''));
    }
  }
}

D.setMinInterval(Number(DB.minIntervalMs) || 1500);
D.setSearchInterval(Number(DB.searchIntervalMs) || 3500);

// ---------------------------------------------------------------- 日志 / 落盘

const logs = [];
function log(s) {
  const line = '[' + stamp() + '] ' + s;
  logs.push(line);
  if (logs.length > 3000) logs.splice(0, logs.length - 1000);
  if (logs.length % 10 === 0) flushLog();
}
function flushLog() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOG_PATH, logs.join('\n'), 'utf8');
  } catch { /* ignore */ }
}

let saveTick = 0;
function save(force) {
  lib.generatedAt = new Date().toISOString();
  lib.count = lib.movies.length;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LIB_PATH, JSON.stringify(lib, null, 2), 'utf8');
}
function upsert(rec) {
  const idx = lib.movies.findIndex((x) => x.key === rec.key);
  if (idx >= 0) lib.movies[idx] = rec;
  else lib.movies.push(rec);
  byKey.set(rec.key, rec);
  if (++saveTick % 3 === 0) save();
}

// ---------------------------------------------------------------- 单条抓取

async function fetchOne(m) {
  const prev = byKey.get(m.key);
  const tries = ((prev && prev.tries) || 0) + 1;
  const label = (m.cn || m.en || '(无片名)').slice(0, 36);

  const rec = {
    key: m.key,
    cn: m.cn || '',
    en: m.en || '',
    year: m.year || null,
    res: m.res || '',
    sourceDir: m.sourceDir || '',
    dirName: m.dirName || '',
    quality: m.quality || '',
    versions: m.versions || [],
    douban: null,
    status: 'unmatched',
    tries,
  };

  // 拼音缩写（pdy / xt / dzd8 …）不做自动匹配，留给界面手动选
  if (m.quality === 'abbr') {
    rec.status = 'needsConfirm';
    rec.reason = 'abbr-name';
    return { rec, outcome: 'needsConfirm', label };
  }

  // 搜索：中英文名都搜一遍，候选合并去重
  //   （只搜中文名会出事：某个系列片的合集目录里，几部片子中文名完全一样，
  //     只靠中文名会全部命中同一部；用它们各自的英文名才能区分）
  const seen = new Set();
  let cands = [];
  const addCands = (list) => {
    for (const c of list) {
      if (!c || !c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      cands.push(c);
    }
  };
  if (m.cn) addCands(await D.suggest(m.cn));
  if (m.en) addCands(await D.suggest(m.en));

  const hit = pickCandidate(cands, m.cn, m.en, m.year);

  if (!hit) {
    rec.status = cands.length ? 'needsConfirm' : 'unmatched';
    rec.reason = cands.length ? 'low-confidence' : 'not-found';
    rec.candidates = cands.slice(0, 8);
    return { rec, outcome: rec.status, label };
  }

  try {
    const info = await D.detail(hit.id);
    const posterDest = path.join(POSTER_DIR, hit.id + '.jpg');
    const posterOk = await D.downloadPoster(info.posterUrl, posterDest);

    rec.douban = {
      id: info.id,
      title: info.title,
      year: info.year,
      rating: info.rating,
      ratingCount: info.ratingCount,
      genres: info.genres,
      countries: info.countries,
      durations: info.durations,
      intro: info.intro,
      directors: info.directors,
      actors: info.actors,
      aka: info.aka,
      confidence: hit.confidence,
      poster: posterOk ? ('posters/' + hit.id + '.jpg') : '',
    };
    rec.status = 'ok';
    return { rec, outcome: 'ok', label, info, confidence: hit.confidence };
  } catch (e) {
    rec.status = 'unmatched';
    rec.reason = 'detail-error';
    rec.error = String((e && e.message) || e);
    return { rec, outcome: 'error', label, error: rec.error };
  }
}

// ---------------------------------------------------------------- 一轮

async function runPass(passNo) {
  let attempted = 0, okCount = 0, i = 0;
  const total = todo.length;

  for (const m of todo) {
    i++;
    const prev = byKey.get(m.key);

    if (prev && prev.status === 'ok') continue;                       // 已完成
    if (prev && (prev.tries || 0) >= MAX_TRIES) continue;             // 试太多次，放弃

    attempted++;
    const r = await fetchOne(m);
    upsert(r.rec);

    if (r.outcome === 'ok') {
      okCount++;
      console.log('  ok  ' + r.info.title + (r.info.year ? ' (' + r.info.year + ')' : '')
        + '  评分 ' + (r.info.rating || '-') + '  ' + r.confidence);
      log('ok  ' + r.info.title + ' (' + (r.info.year || '') + ')  ' + (r.info.rating || '-'));
    } else if (r.outcome === 'error') {
      console.log('  ERR ' + r.label + ' : ' + r.error);
      log('ERR ' + r.label + ' : ' + r.error);
    } else {
      console.log('  ' + r.outcome + '  ' + r.label);
      log(r.outcome + '  ' + r.label);
    }
  }

  return { attempted, okCount, total };
}

// ---------------------------------------------------------------- 主循环

function progress() {
  const done = todo.filter((m) => { const r = byKey.get(m.key); return r && r.status === 'ok'; }).length;
  const exhausted = todo.filter((m) => {
    const r = byKey.get(m.key);
    return r && r.status !== 'ok' && (r.tries || 0) >= MAX_TRIES;
  }).length;
  const pending = todo.length - done - exhausted;
  return { done, exhausted, pending };
}

/**
 * 探针：用豆瓣上一定存在的片名试搜一次，用来区分
 * 「豆瓣限流」和「这批片子确实搜不到」。
 * 探针失败时整轮跳过，既不做无效请求，也不消耗条目的重试次数。
 */
const PROBE_KEYWORD = '霸王别姬';
async function probe() {
  try {
    const r = await D.suggestJson(PROBE_KEYWORD, 1);
    return Array.isArray(r) && r.length > 0;
  } catch {
    return false;
  }
}

(async () => {
  const t0 = Date.now();
  let passNo = 0;
  let retryWaitMs = RETRY_WAIT_MS;   // 逐轮翻倍，避免频繁试探让封禁一直续期

  for (;;) {
    passNo++;
    console.log('');
    console.log('════════ 第 ' + passNo + ' 轮开始  ' + stamp() + ' ════════');

    // 探针：先确认豆瓣搜索可用；不可用就直接等待，不白跑一轮、也不消耗重试次数
    if (!(await probe())) {
      const mins = Math.round(retryWaitMs / 60000);
      console.log('── 探针失败：豆瓣搜索暂不可用（限流中），' + mins + ' 分钟后再试…');
      console.log('   （不消耗重试次数；等待时间逐轮翻倍，最多 '
        + Math.round(RETRY_WAIT_MAX_MS / 3600000) + ' 小时。想停止按 Ctrl+C）');
      await sleep(retryWaitMs);
      retryWaitMs = Math.min(retryWaitMs * 2, RETRY_WAIT_MAX_MS);
      continue;
    }
    retryWaitMs = RETRY_WAIT_MS;

    const { attempted, okCount } = await runPass(passNo);

    // 清掉扫描结果里已不存在的键
    const valid = new Set(all.map((m) => m.key));
    lib.movies = lib.movies.filter((m) => valid.has(m.key));
    save();
    flushLog();

    const { done, exhausted, pending } = progress();
    console.log('── 本轮：尝试 ' + attempted + ' 条，成功 ' + okCount + ' 条');
    console.log('── 进度：已完成 ' + done + '/' + todo.length
      + '，待继续 ' + pending + '，已达重试上限 ' + exhausted);

    if (!FOREVER) break;
    if (pending === 0) { console.log('\n全部处理完毕。'); break; }

    if (okCount === 0) {
      const mins = Math.round(retryWaitMs / 60000);
      console.log('── 本轮无任何进展（豆瓣还在限流），' + mins + ' 分钟后再试…');
      console.log('   （等待时间会逐轮翻倍，最多 ' + Math.round(RETRY_WAIT_MAX_MS / 3600000) + ' 小时——');
      console.log('     请求越密封禁越久，所以宁可等得久一点。想停止按 Ctrl+C）');
      await sleep(retryWaitMs);
      retryWaitMs = Math.min(retryWaitMs * 2, RETRY_WAIT_MAX_MS);
    } else {
      retryWaitMs = RETRY_WAIT_MS;   // 有进展就恢复成初始等待
      await sleep(IDLE_WAIT_MS);
    }
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  console.log('');
  console.log('[douban] 结束，用时 ' + Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒');
  console.log('  library : ' + LIB_PATH);
  console.log('  log     : ' + LOG_PATH);
})();
