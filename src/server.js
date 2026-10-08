'use strict';

/**
 * 本地 Web 服务：海报墙 + 多条件筛选 + 「待确认」手动绑定
 *   node src/server.js        然后浏览器打开 http://localhost:7777
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const D = require('./douban');
const SCAN = require('./scan');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULT_CONFIG = {
  movieDirs: [],
  dataDir: 'data',
  excludeDirNameContains: ['高清剧集网', 'BPHDTV', 'DDHDTV'],
  scan: { minVideoSizeMB: 50 },
  douban: { minIntervalMs: 1800, searchIntervalMs: 5000, maxTriesPerMovie: 4, retryWaitMs: 1800000 },
  server: { port: 7777 },
  player: { path: '', args: [] },
};

/** 读配置；文件缺失或损坏时回退到默认值（这样全新环境也能直接开网页配） */
function loadConfigFile() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!Array.isArray(c.movieDirs)) c.movieDirs = [];
    return c;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

let CONFIG = loadConfigFile();
const DATA_DIR = path.join(ROOT, CONFIG.dataDir || 'data');
const LIB_PATH = path.join(DATA_DIR, 'library.json');
const SCAN_PATH = path.join(DATA_DIR, 'scan-result.json');
const POSTER_DIR = path.join(DATA_DIR, 'posters');
const PUB_DIR = path.join(ROOT, 'public');
const PORT = (CONFIG.server && CONFIG.server.port) || 7777;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/** 视频容器的 MIME（用于网页内 <video> 播放） */
const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.rmvb': 'application/vnd.rn-realmedia-vbr',
};

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function readLib() {
  try { return JSON.parse(fs.readFileSync(LIB_PATH, 'utf8')); } catch { return { movies: [] }; }
}

/**
 * 给网页展示用的片库：以 library.json 为主，把扫描结果里「还没抓取过」的条目补进来。
 *
 * 为什么需要这层：扫描（scan.js）只产出 scan-result.json，而 library.json 是抓取
 * （fetch.js）的产物。所以刚扫完、抓取还没开始（或被豆瓣限流卡住）的那段时间里，
 * 网页读不到任何东西，会显示「片库还是空的」，让人以为扫描没生效。
 * 补上之后：扫完立刻就能看到自己的片子（只有片名和年份），抓到的海报评分再一条条贴上去。
 */
/**
 * 视图层合并：把「已在界面上确认要合并」的同一个豆瓣条目的多条记录拼成一条。
 *
 * 只影响返回给网页的数据，library.json 里的记录一条都不动 —— 这样可逆，
 * 也不会和抓取的增量逻辑打架（物理删掉某条记录，下次抓取扫描又会把它建回来）。
 */
function applyMerges(lib) {
  const ids = new Set((lib.mergedIds || []).map(String));
  if (!ids.size) return lib;
  const host = new Map();
  const out = [];
  for (const m of lib.movies) {
    const id = m.douban && m.douban.id ? String(m.douban.id) : '';
    if (!id || !ids.has(id)) { out.push(m); continue; }
    const first = host.get(id);
    if (!first) { host.set(id, m); out.push(m); continue; }
    // 后面的把文件并进第一条（详情页里就能看到所有版本）
    const seen = new Set((first.versions || []).map((v) => v && v.file));
    for (const v of (m.versions || [])) {
      if (v && v.file && !seen.has(v.file)) { seen.add(v.file); first.versions.push(v); }
    }
  }
  lib.movies = out;
  return lib;
}

function readLibForDisplay() {
  const lib = readLib();
  if (!lib || !Array.isArray(lib.movies)) return { movies: [] };
  try {
    const scan = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scan-result.json'), 'utf8'));
    const merged = Array.isArray(scan.merged) ? scan.merged : [];
    const known = new Set(lib.movies.map((m) => m && m.key));
    for (const m of merged) {
      if (m && m.key && !known.has(m.key)) {
        lib.movies.push(Object.assign({}, m, { douban: null, status: 'unmatched' }));
      }
    }
  } catch { /* 还没扫描过 */ }
  return applyMerges(lib);
}

function writeLib(lib) {
  lib.generatedAt = new Date().toISOString();
  lib.count = (lib.movies || []).length;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LIB_PATH, JSON.stringify(lib, null, 2), 'utf8');
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}

/** 校验路径确实位于配置的电影目录内（防止任意文件被打开） */
function isAllowedPath(file) {
  let norm;
  try { norm = path.resolve(file).toLowerCase(); } catch { return false; }
  return (CONFIG.movieDirs || []).some((d) => {
    try { return norm.startsWith(path.resolve(d).toLowerCase()); } catch { return false; }
  });
}

/** 用播放器打开文件；未配置播放器时用系统默认关联程序 */
function openWithPlayer(file) {
  const player = String((CONFIG.player && CONFIG.player.path) || '').trim();
  try {
    if (player && fs.existsSync(player)) {
      let args = Array.isArray(CONFIG.player.args) ? CONFIG.player.args.slice() : [];
      if (!args.length) args = ['{file}'];
      args = args.map((a) => String(a).replace(/\{file\}/g, file));
      spawn(player, args, { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Windows：交给文件关联的默认播放器
      spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

/** 在资源管理器里选中该文件 */
function revealInExplorer(file) {
  try {
    spawn('explorer', ['/select,' + path.resolve(file)], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

/** 把内部记录裁剪成前端需要的形状 */
function toClient(m) {
  const d = m.douban || {};
  const versions = (m.versions || []).map((v) => ({
    file: v.file, fileName: v.fileName, size: v.size, res: v.res,
  }));
  return {
    key: m.key,
    cn: m.cn || '', en: m.en || '',
    year: d.year || m.year || null,
    res: m.res || '',
    status: m.status || 'unmatched',
    reason: m.reason || '',
    dirName: m.dirName || '',
    size: versions.length ? versions[0].size : 0,
    versions,
    title: d.title || m.cn || m.en || '(未知)',
    rating: d.rating == null ? null : d.rating,
    ratingCount: d.ratingCount || null,
    genres: d.genres || [],
    countries: d.countries || [],
    durations: d.durations || [],
    intro: d.intro || '',
    directors: d.directors || [],
    actors: d.actors || [],
    poster: d.poster || '',
    confidence: d.confidence || '',
    candidates: (m.candidates || []).slice(0, 8).map((c) => ({
      id: c.id, title: c.title, year: c.year, img: c.img,
    })),
  };
}

function buildFacets(movies) {
  const genres = {}, countries = {};
  for (const m of movies) {
    for (const g of m.genres) genres[g] = (genres[g] || 0) + 1;
    for (const c of m.countries) countries[c] = (countries[c] || 0) + 1;
  }
  const sortDesc = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, count: v }));
  return { genres: sortDesc(genres), countries: sortDesc(countries) };
}

// ---------------------------------------------------------------- 扫描状态

const scanState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  progress: '',
  error: null,
  summary: null,
};

function startScan() {
  scanState.running = true;
  scanState.startedAt = Date.now();
  scanState.finishedAt = null;
  scanState.error = null;
  scanState.summary = null;
  scanState.progress = '准备中…';

  setImmediate(() => {
    try {
      const t0 = Date.now();
      const result = SCAN.scanAll((done, total) => {
        scanState.progress = '正在扫描目录 ' + done + '/' + total;
      });
      SCAN.writeOutputs(result);
      const sum = SCAN.summarize(result);
      sum.seconds = Math.round((Date.now() - t0) / 1000);
      scanState.summary = sum;
      // 目录可能变了，重新载入内存中的配置
      CONFIG = loadConfigFile();
      pruneLibraryByScan();          // 把片库里已经不存在的条目清掉
      console.log('[server] 扫描完成：' + sum.total + ' 部（用时 ' + sum.seconds + 's）');
    } catch (e) {
      scanState.error = String((e && e.message) || e);
      console.log('[server] 扫描失败：' + scanState.error);
    } finally {
      scanState.running = false;
      scanState.finishedAt = Date.now();
      scanState.progress = '';
    }
  });
}

/** 检查一个目录是否可用 */
function checkDir(d) {
  try {
    if (!fs.statSync(d).isDirectory()) return { exists: false, entries: 0, why: '不是文件夹' };
    let n = 0;
    try { n = fs.readdirSync(d).length; } catch { /* ignore */ }
    return { exists: true, entries: n, why: '' };
  } catch {
    return { exists: false, entries: 0, why: '路径不存在' };
  }
}

// ---------------------------------------------------------------- 抓取状态（子进程）

const fetchState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  error: null,
  lines: [],
};
let fetchChild = null;

function pushFetchLines(buf) {
  const text = String(buf);
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    fetchState.lines.push(ln);
    if (fetchState.lines.length > 400) fetchState.lines.splice(0, fetchState.lines.length - 400);
  }
}

/** 用子进程启动抓取，不阻塞网页服务 */
function startFetch(extraArgs) {
  if (fetchChild) return false;
  const args = [path.join(__dirname, 'fetch.js'), '--forever'].concat(extraArgs || []);
  fetchChild = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });

  fetchState.running = true;
  fetchState.startedAt = Date.now();
  fetchState.finishedAt = null;
  fetchState.exitCode = null;
  fetchState.error = null;
  fetchState.lines = [];

  fetchChild.stdout.on('data', pushFetchLines);
  fetchChild.stderr.on('data', pushFetchLines);
  fetchChild.on('error', (e) => {
    fetchState.error = String((e && e.message) || e);
    fetchState.running = false;
    fetchChild = null;
  });
  fetchChild.on('exit', (code) => {
    fetchState.running = false;
    fetchState.finishedAt = Date.now();
    fetchState.exitCode = code;
    fetchChild = null;
    console.log('[server] 抓取进程已退出，code=' + code);
  });

  console.log('[server] 已启动抓取子进程');
  return true;
}

function stopFetch() {
  if (!fetchChild) return false;
  try { fetchChild.kill(); } catch { /* ignore */ }
  fetchChild = null;
  fetchState.running = false;
  fetchState.finishedAt = Date.now();
  return true;
}

/**
 * 把文件移出电影目录，但不永久删除。
 *
 * 做法：**同盘改名**到该盘根目录下的 `_movie-lib_deleted\` 里（保留原来的相对路径）。
 *   - 同盘 rename 是瞬间完成的，不占额外空间
 *   - 文件从电影库消失（因为不在 movieDirs 下），片库扫描会忽略它
 *   - 想还原：把 `_movie-lib_deleted` 里的东西拷回原位即可
 *   - 想真删：直接删掉 `_movie-lib_deleted` 整个文件夹
 *
 * （不用 Windows 回收站：在磁盘吃紧/回收站被禁用时，它会**静默地永久删除**，太危险。）
 */
function moveToDeleted(file) {
  return new Promise((resolve, reject) => {
    try {
      const abs = path.resolve(file);
      const root = path.parse(abs).root;                 // 例如 "M:\"
      const rel = path.relative(root, abs);
      const dest = path.join(root, '_movie-lib_deleted', rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(abs, dest);
      resolve(dest);
    } catch (e) {
      reject(new Error(String((e && e.message) || e)));
    }
  });
}

/** 配置的电影目录涉及哪些盘（用来定位各盘根上的 _movie-lib_deleted） */
function trashDirs() {
  const roots = new Set();
  for (const d of (CONFIG.movieDirs || [])) {
    try { roots.add(path.parse(path.resolve(d)).root); } catch { /* ignore */ }
  }
  return [...roots].map((r) => path.join(r, '_movie-lib_deleted'));
}

/** 递归收集目录下的所有文件（统计回收区占用用） */
function walkFiles(dir, out) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walkFiles(full, out);
    else if (it.isFile()) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* ignore */ }
      out.push({ file: full, size });
    }
  }
}

/**
 * 把一个文件从 library.json / scan-result.json 里摘掉（条目一个文件都不剩就整条删）。
 *
 * 删除文件后**必须**做这一步：网页读的是 library.json，而扫描只更新 scan-result.json，
 * 少了它就会出现「文件明明删了、列表里还在」。
 */
function dropFileFromStores(file) {
  const target = String(file || '').toLowerCase();
  if (!target) return;
  for (const p of [LIB_PATH, SCAN_PATH]) {
    let data;
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const arr = Array.isArray(data.movies) ? data.movies
      : (Array.isArray(data.merged) ? data.merged : null);
    if (!arr) continue;
    let changed = false;
    for (let i = arr.length - 1; i >= 0; i--) {
      const rec = arr[i];
      if (!rec || !Array.isArray(rec.versions)) continue;
      const kept = rec.versions.filter((v) => String((v && v.file) || '').toLowerCase() !== target);
      if (kept.length !== rec.versions.length) {
        rec.versions = kept;
        rec.versionCount = kept.length;
        changed = true;
      }
      if (!rec.versions.length) { arr.splice(i, 1); changed = true; }
    }
    if (changed) {
      if (Array.isArray(data.movies)) data.count = data.movies.length;
      try { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); } catch { /* ignore */ }
    }
  }
}

/**
 * 以扫描结果为准，把 library.json 里已经不存在的条目清掉。
 * 扫描完成后调用 —— 这样文件就算是被别的途径删的（或在这次改动之前删的），也能对上。
 */
function pruneLibraryByScan() {
  let scan, lib;
  try { scan = JSON.parse(fs.readFileSync(SCAN_PATH, 'utf8')); } catch { return 0; }
  try { lib = JSON.parse(fs.readFileSync(LIB_PATH, 'utf8')); } catch { return 0; }
  if (!Array.isArray(lib.movies) || !Array.isArray(scan.merged)) return 0;
  const valid = new Set(scan.merged.map((m) => m && m.key));
  const before = lib.movies.length;
  lib.movies = lib.movies.filter((m) => m && valid.has(m.key));
  const removed = before - lib.movies.length;
  if (removed) {
    lib.count = lib.movies.length;
    lib.generatedAt = new Date().toISOString();
    try { fs.writeFileSync(LIB_PATH, JSON.stringify(lib, null, 2), 'utf8'); } catch { /* ignore */ }
    console.log('[server] 片库清理：移除了 ' + removed + ' 条已不存在的记录');
  }
  return removed;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);

  try {
    // ------------------------------------------------ API

    if (p === '/api/library') {
      const lib = readLibForDisplay();
      const movies = (lib.movies || []).map(toClient);
      return sendJson(res, {
        generatedAt: lib.generatedAt || null,
        count: movies.length,
        movies,
        facets: buildFacets(movies),
      });
    }

    if (p === '/api/search') {
      const q = u.searchParams.get('q') || '';
      const items = q ? await D.suggest(q) : [];
      return sendJson(res, { q, items: items.slice(0, 10) });
    }

    // ---- 目录配置 ----
    if (p === '/api/config' && req.method === 'GET') {
      const dirs = (CONFIG.movieDirs || []).map((d) => {
        const c = checkDir(d);
        return { path: d, exists: c.exists, entries: c.entries, why: c.why };
      });
      return sendJson(res, { movieDirs: CONFIG.movieDirs || [], dirs, port: PORT });
    }

    if (p === '/api/config/dirs' && req.method === 'POST') {
      let payload = {};
      try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      if (!Array.isArray(payload.movieDirs)) return sendJson(res, { error: 'movieDirs 必须是数组' }, 400);

      const cleaned = [];
      const problems = [];
      for (const raw of payload.movieDirs) {
        const d = String(raw || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
        if (!d || cleaned.includes(d)) continue;
        const c = checkDir(d);
        if (c.exists) cleaned.push(d);
        else problems.push({ path: d, why: c.why });
      }
      if (!cleaned.length) return sendJson(res, { error: '没有可用的目录（都不可读）', problems }, 400);

      CONFIG = loadConfigFile();
      CONFIG.movieDirs = cleaned;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2), 'utf8');

      const dirs = cleaned.map((d) => {
        const c = checkDir(d);
        return { path: d, exists: c.exists, entries: c.entries, why: c.why };
      });
      return sendJson(res, { ok: true, movieDirs: cleaned, dirs, problems });
    }

    // ---- 扫描 ----
    if (p === '/api/scan' && req.method === 'POST') {
      if (scanState.running) return sendJson(res, { ok: false, error: '正在扫描中，请稍候' }, 409);
      startScan();
      return sendJson(res, { ok: true, started: true });
    }

    if (p === '/api/scan/status' && req.method === 'GET') {
      return sendJson(res, scanState);
    }

    if (p === '/api/scan/preview' && req.method === 'GET') {
      try {
        const txt = fs.readFileSync(path.join(DATA_DIR, 'preview.txt'), 'utf8');
        return sendJson(res, { ok: true, text: txt });
      } catch (e) {
        return sendJson(res, { ok: false, error: '还没有扫描结果' }, 404);
      }
    }

    // ---- 抓取豆瓣资料 ----
    if (p === '/api/fetch' && req.method === 'POST') {
      if (fetchChild) return sendJson(res, { ok: false, error: '抓取已经在运行中了' }, 409);
      let payload = {};
      try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const extra = [];
      if (payload.rematch) extra.push('--rematch');
      if (payload.retryFailed) extra.push('--retry-failed');
      const ok = startFetch(extra);
      return sendJson(res, { ok, started: ok });
    }

    if (p === '/api/fetch/status' && req.method === 'GET') {
      const lib = readLib();
      const m = lib.movies || [];
      return sendJson(res, {
        running: fetchState.running,
        startedAt: fetchState.startedAt,
        finishedAt: fetchState.finishedAt,
        exitCode: fetchState.exitCode,
        error: fetchState.error,
        tail: fetchState.lines.slice(-30),
        progress: {
          total: m.length,
          ok: m.filter((x) => x.status === 'ok').length,
          needsConfirm: m.filter((x) => x.status === 'needsConfirm').length,
          unmatched: m.filter((x) => x.status === 'unmatched').length,
        },
      });
    }

    if (p === '/api/fetch/stop' && req.method === 'POST') {
      const ok = stopFetch();
      return sendJson(res, ok ? { ok: true } : { ok: false, error: '当前没有在运行的抓取' }, ok ? 200 : 400);
    }

    if (p === '/api/detail') {
      const id = u.searchParams.get('id');
      if (!id || !/^\d+$/.test(id)) return sendJson(res, { error: 'invalid id' }, 400);
      const info = await D.detail(id);
      return sendJson(res, info);
    }

    // ---------- 重复文件 ----------
    if (p === '/api/duplicates' && req.method === 'GET') {
      let scan = {};
      try { scan = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scan-result.json'), 'utf8')); } catch { /* ignore */ }
      const merged = Array.isArray(scan.merged) ? scan.merged : [];
      const groups = merged
        .filter((m) => (m.versionCount || 1) > 1)
        .map((m, i) => ({
          idx: i + 1,
          key: m.key,
          title: m.cn || m.en || '(未知)',
          cn: m.cn || '', en: m.en || '', year: m.year || null,
          files: (m.versions || []).map((v) => {
            let exists = false;
            let size = v.size || 0;
            try { const st = fs.statSync(v.file); exists = st.isFile(); size = st.size; } catch { /* ignore */ }
            return { file: v.file, fileName: v.fileName, size, res: v.res || '', exists };
          }).sort((a, b) => b.size - a.size),
        }));
      return sendJson(res, { ok: true, count: groups.length, groups });
    }

    // ---------- 同一部片的多条记录（都指向同一个豆瓣条目，但扫描时没合并成一条） ----------
    if (p === '/api/merges' && req.method === 'GET') {
      const lib = readLib();
      const confirmed = new Set((lib.mergedIds || []).map(String));
      const byId = new Map();
      for (const m of (lib.movies || [])) {
        const id = m.douban && m.douban.id ? String(m.douban.id) : '';
        if (!id || m.status !== 'ok') continue;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(m);
      }
      const groups = [];
      for (const [id, list] of byId) {
        if (list.length < 2) continue;
        const d0 = list[0].douban || {};
        groups.push({
          id,
          merged: confirmed.has(id),
          title: d0.title || list[0].cn || list[0].en || '(未知)',
          year: d0.year || null,
          records: list.map((m) => ({
            key: m.key,
            cn: m.cn || '', en: m.en || '', year: m.year || null,
            manual: m.reason === 'manual' || !!(m.douban && m.douban.confidence === 'manual'),
            files: (m.versions || []).map((v) => {
              let exists = false;
              let size = v.size || 0;
              try { const st = fs.statSync(v.file); exists = st.isFile(); size = st.size; } catch { /* ignore */ }
              return { file: v.file, fileName: v.fileName, size, res: v.res || '', exists };
            }).sort((a, b) => b.size - a.size),
          })),
        });
      }
      groups.sort((a, b) => b.records.length - a.records.length);
      return sendJson(res, { ok: true, count: groups.length, groups });
    }

    if (p === '/api/merge' && req.method === 'POST') {
      let payload = {};
      try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const id = String(payload.id || '');
      if (!/^\d+$/.test(id)) return sendJson(res, { error: 'id 必须是豆瓣条目的数字 id' }, 400);
      const on = payload.merge !== false;             // 不传就是合并；传 merge:false 表示取消

      const lib = readLib();
      const ids = new Set((lib.mergedIds || []).map(String));
      if (on) ids.add(id); else ids.delete(id);
      lib.mergedIds = [...ids];
      writeLib(lib);                                  // 只多写一个 mergedIds，movies 原样不动
      return sendJson(res, { ok: true, id, merged: on, total: lib.mergedIds.length });
    }

    if (p === '/api/delete' && req.method === 'POST') {
      let payload = {};
      try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const files = Array.isArray(payload.files) ? payload.files : [];
      if (!files.length) return sendJson(res, { error: '没有指定要删除的文件' }, 400);

      const deleted = [];
      const failed = [];
      for (const f of files) {
        const file = String(f || '');
        if (!file) continue;
        if (!isAllowedPath(file)) { failed.push({ file, error: '不在配置的电影目录内，已拒绝' }); continue; }
        let st;
        try { st = fs.statSync(file); } catch {
          // 文件本来就不在了 —— 多半是之前删过、片库列表没跟上。顺手把记录清掉，也算删除成功。
          dropFileFromStores(file);
          deleted.push({ file, size: 0, movedTo: '(文件已不在，只清理了片库记录)' });
          continue;
        }
        if (!st.isFile()) { failed.push({ file, error: '不是一个文件' }); continue; }
        try {
          const dest = await moveToDeleted(file);
          dropFileFromStores(file);       // ★ 顺手从片库数据里摘掉，否则「删了还在列表里」
          deleted.push({ file, size: st.size, movedTo: dest });
        } catch (e) {
          failed.push({ file, error: String((e && e.message) || e) });
        }
      }
      return sendJson(res, { ok: failed.length === 0, deleted, failed });
    }

    // ---------- 文件回收区（删掉的电影先挪到这里；确认不要了再清空，那时才真正释放空间） ----------
    if (p === '/api/trash' && req.method === 'GET') {
      const dirs = [];
      for (const dir of trashDirs()) {
        if (!fs.existsSync(dir)) continue;
        const files = [];
        walkFiles(dir, files);
        files.sort((a, b) => b.size - a.size);
        dirs.push({
          dir,
          count: files.length,
          bytes: files.reduce((s, f) => s + f.size, 0),
          files: files.slice(0, 200),
        });
      }
      return sendJson(res, {
        ok: true,
        count: dirs.reduce((s, d) => s + d.count, 0),
        bytes: dirs.reduce((s, d) => s + d.bytes, 0),
        dirs,
      });
    }

    if (p === '/api/purge' && req.method === 'POST') {
      const removed = [];
      const failed = [];
      for (const dir of trashDirs()) {
        if (!fs.existsSync(dir)) continue;
        const files = [];
        walkFiles(dir, files);
        const count = files.length;
        const bytes = files.reduce((s, f) => s + f.size, 0);
        try {
          fs.rmSync(dir, { recursive: true, force: true });   // ← 真删，不可恢复
          removed.push({ dir, count, bytes });
          console.log('[server] 已清空回收区 ' + dir
            + '（' + count + ' 个文件，' + Math.round(bytes / 1048576) + ' MB）');
        } catch (e) {
          failed.push({ dir, error: String((e && e.message) || e) });
        }
      }
      return sendJson(res, { ok: failed.length === 0, removed, failed });
    }

    // 手动把一个条目绑定到豆瓣 subject
    if (p === '/api/bind' && req.method === 'POST') {
      let payload = {};
      try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const { key, doubanId } = payload;
      if (!key || !doubanId || !/^\d+$/.test(String(doubanId))) {
        return sendJson(res, { error: 'key 与 doubanId 必填，且 doubanId 必须是数字' }, 400);
      }
      const lib = readLib();
      const idx = lib.movies.findIndex((m) => m.key === key);
      if (idx < 0) return sendJson(res, { error: '找不到该条目' }, 404);

      const info = await D.detail(String(doubanId));
      const posterName = String(doubanId) + '.jpg';
      const okPoster = await D.downloadPoster(info.posterUrl, path.join(POSTER_DIR, posterName));

      lib.movies[idx].douban = {
        id: info.id, title: info.title, year: info.year,
        rating: info.rating, ratingCount: info.ratingCount,
        genres: info.genres, countries: info.countries, durations: info.durations,
        intro: info.intro, directors: info.directors, actors: info.actors, aka: info.aka,
        confidence: 'manual',
        poster: okPoster ? ('posters/' + posterName) : '',
      };
      lib.movies[idx].status = 'ok';
      lib.movies[idx].reason = 'manual';
      writeLib(lib);
      return sendJson(res, { ok: true, movie: toClient(lib.movies[idx]) });
    }

    // 播放 / 在资源管理器定位文件
    if ((p === '/api/play' || p === '/api/reveal') && req.method === 'POST') {
      let payload = {};
      try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const file = String(payload.file || '');
      if (!file) return sendJson(res, { error: '缺少 file 参数' }, 400);
      if (!isAllowedPath(file)) return sendJson(res, { error: '该文件不在配置的电影目录内，已拒绝执行' }, 403);
      if (!fs.existsSync(file)) return sendJson(res, { error: '文件不存在：' + file }, 404);
      if (p === '/api/reveal') return sendJson(res, { ok: revealInExplorer(file) });
      const ok = openWithPlayer(file);
      return sendJson(res, ok ? { ok: true, file } : { ok: false, error: '启动播放器失败' }, ok ? 200 : 500);
    }

    // 网页内播放：带 HTTP Range 支持的视频流（手机 / 电视浏览器用）
    if (p === '/api/stream') {
      const file = u.searchParams.get('file') || '';
      if (!file) return sendJson(res, { error: '缺少 file 参数' }, 400);
      if (!isAllowedPath(file)) return sendJson(res, { error: '该文件不在配置的电影目录内，已拒绝执行' }, 403);

      let stat;
      try { stat = fs.statSync(file); } catch { return sendJson(res, { error: '文件不存在：' + file }, 404); }
      const total = stat.size;
      const mime = VIDEO_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.range;

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= total) end = total - 1;
        if (start > end) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + total });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': 'no-store',
        });
        const rs = fs.createReadStream(file, { start, end });
        rs.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
        rs.pipe(res);
        return;
      }

      res.writeHead(200, {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Content-Length': total,
        'Cache-Control': 'no-store',
      });
      const rs = fs.createReadStream(file);
      rs.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
      rs.pipe(res);
      return;
    }

    // ------------------------------------------------ 静态

    if (p.startsWith('/posters/')) {
      return sendFile(res, path.join(POSTER_DIR, path.basename(p)));
    }

    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.resolve(PUB_DIR, rel);
    if (!file.startsWith(PUB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    return sendFile(res, file);

  } catch (e) {
    return sendJson(res, { error: String((e && e.message) || e) }, 500);
  }
});

/** 本机所有局域网 IPv4 地址（供手机 / 电视访问） */
function lanAddresses() {
  const out = [];
  try {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni && ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
      }
    }
  } catch { /* ignore */ }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  电影库已启动');
  console.log('  本机浏览器  :  http://localhost:' + PORT);

  // 没配置目录（或配置的目录都不存在）时给出提示
  const dirs = Array.isArray(CONFIG.movieDirs) ? CONFIG.movieDirs.filter(Boolean) : [];
  const alive = dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  if (!dirs.length) {
    console.log('');
    console.log('  ⚠ 还没有配置电影目录。请在浏览器页面上点「⚙ 管理电影目录」添加。');
  } else if (!alive.length) {
    console.log('');
    console.log('  ⚠ 配置里的目录都不存在了：' + dirs.join(' , '));
    console.log('    请在浏览器页面上点「⚙ 管理电影目录」重新指定。');
  } else if (alive.length < dirs.length) {
    const dead = dirs.filter((d) => !alive.includes(d));
    console.log('');
    console.log('  ⚠ 有 ' + dead.length + ' 个目录不存在，已忽略：' + dead.join(' , '));
  }

  const ips = lanAddresses();
  if (ips.length) {
    console.log('  手机 / 电视  :  （需连同一个 WiFi）');
    for (const ip of ips) console.log('                 http://' + ip + ':' + PORT);
  } else {
    console.log('  手机 / 电视  :  未检测到局域网地址，请确认已联网');
  }
  console.log('');
  console.log('  提示：首次启动若 Windows 防火墙弹窗，请勾选「专用网络」并允许访问，');
  console.log('        否则手机 / 电视会连不上。');
  console.log('  停止：关闭本窗口或按 Ctrl+C');
  console.log('');
});
