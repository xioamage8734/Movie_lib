'use strict';

/**
 * 扫描 movieDirs，解析出影片条目。
 *
 *   node src/scan.js                     命令行模式：扫描 + 写 data/preview.txt 与 scan-result.json
 *   const S = require('./scan')          网页模式：S.scanAll() 返回结果，由调用方决定是否落盘
 *
 * 注意：scanAll() 每次都会重新读 config.json，所以网页里改完目录后直接再调一次即可。
 */

const fs = require('fs');
const path = require('path');
const C = require('./parse');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function dataDirOf(cfg) {
  return path.join(ROOT, (cfg && cfg.dataDir) || 'data');
}

// ------------------------------------------------------------------ 小工具

function humanSize(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i < 2 ? n.toFixed(0) : n.toFixed(2)) + ' ' + u[i];
}
function baseName(p) { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function cleanVideoName(fn) {
  let n = fn.replace(/\.[^.]+$/, '');
  n = n.replace(/^\.syncthing\./i, '').replace(/^\.!ut\.?/i, '');
  return n;
}

function collectVideos(dirPath, depth = 0) {
  const out = [];
  let items;
  try { items = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const full = dirPath + '/' + it.name;
    if (it.isDirectory()) {
      if (depth < 3) out.push(...collectVideos(full, depth + 1));
    } else {
      if (C.isAdFile(it.name)) continue;
      if (C.isVideo(it.name)) out.push(full);
    }
  }
  return out;
}

// 解析质量排序：good > short > abbr
const QUAL_RANK = { good: 2, short: 1, abbr: 0 };

/**
 * 目录名与文件名各解析一次，取“更像片名”的那一份做主体，缺失字段用另一份补全。
 */
function buildRec(sourceDir, dirName, filePath) {
  const fn = baseName(filePath);
  const pFile = C.parseMovieName(cleanVideoName(fn));
  const pDir = C.parseMovieName(dirName);

  const fileWin = (QUAL_RANK[pFile.quality] || 0) >= (QUAL_RANK[pDir.quality] || 0);
  const primary = fileWin ? pFile : pDir;
  const other = fileWin ? pDir : pFile;

  const cn = primary.cn || other.cn;
  const en = primary.en || other.en;
  const year = primary.year || other.year;
  const res = primary.res || other.res;
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { /* ignore */ }

  return {
    sourceDir, dirName, file: filePath, fileName: fn, size,
    cn, en, year, res,
    quality: C.nameQuality(cn, en),
    key: C.normalizeKey(cn, en, year),
  };
}

// ------------------------------------------------------------------ 主流程

/**
 * 扫描全部配置目录
 * @param {(done:number,total:number,dir:string)=>void} [onProgress]
 * @returns {{config:object, merged:Array, excluded:object, perDir:object}}
 */
function scanAll(onProgress) {
  const CONFIG = loadConfig();
  const dirs = Array.isArray(CONFIG.movieDirs) ? CONFIG.movieDirs.filter(Boolean) : [];

  const records = [];
  const excluded = { episode: [], noise: [], empty: [] };
  const perDir = {};

  let doneDirs = 0;
  for (const dir of dirs) {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) {
      excluded.empty.push({ dir, name: '', reason: '无法读取: ' + e.message });
      doneDirs++;
      if (onProgress) onProgress(doneDirs, dirs.length, dir);
      continue;
    }

    for (const it of items) {
      const name = it.name;
      if (name.startsWith('$') || name === 'System Volume Information') continue;
      const full = dir + '/' + name;

      if (it.isDirectory()) {
        if ((CONFIG.excludeDirNameContains || []).some((k) => name.includes(k))) {
          excluded.episode.push({ dir, name, reason: '剧集目录(站点标记)', count: 0 });
          continue;
        }
        const vids = collectVideos(full);
        if (!vids.length) { excluded.empty.push({ dir, name, reason: '无视频文件' }); continue; }

        const epByFile = vids.filter((v) => C.isEpisodeName(baseName(v))).length;
        if (C.isEpisodeName(name) || (vids.length > 1 && epByFile >= Math.ceil(vids.length / 2))) {
          excluded.episode.push({ dir, name, reason: '剧集', count: vids.length });
          continue;
        }

        for (const v of vids) records.push(buildRec(dir, name, v));
      } else {
        if (C.isVideo(name)) records.push(buildRec(dir, cleanVideoName(name), full));
        else if (C.isNoiseExt(name)) excluded.noise.push({ dir, name, reason: '杂项文件' });
      }
    }

    perDir[dir] = { total: items.length };
    doneDirs++;
    if (onProgress) onProgress(doneDirs, dirs.length, dir);
  }

  // ---- 合并同一部片的不同版本 ----
  const minSize = (CONFIG.scan && CONFIG.scan.minVideoSizeMB || 0) * 1024 * 1024;
  const filtered = records.filter((r) => r.size >= minSize);

  const groups = new Map();
  for (const r of filtered) {
    if (!groups.has(r.key)) groups.set(r.key, []);
    groups.get(r.key).push(r);
  }

  const merged = [];
  for (const [, list] of groups) {
    list.sort((a, b) => b.size - a.size);
    const primary = list[0];
    merged.push({
      ...primary,
      versions: list.map((x) => ({ file: x.file, fileName: x.fileName, size: x.size, res: x.res })),
      versionCount: list.length,
    });
  }
  merged.sort((a, b) => (b.size - a.size));

  return { config: CONFIG, merged, excluded, perDir };
}

/** 生成可读的预览文本（给 data/preview.txt） */
function buildPreviewText(result) {
  const { config, merged, excluded, perDir } = result;
  const L = [];
  const line = (s = '') => L.push(s);
  const HR = '─'.repeat(90);

  line('='.repeat(90));
  line(' 电影库扫描 · 解析预览');
  line(' 生成时间: ' + new Date().toLocaleString('zh-CN'));
  line(' 扫描目录: ' + (config.movieDirs || []).join(' , '));
  line('='.repeat(90));
  line();

  const abbrList = merged.filter((r) => r.quality === 'abbr');
  const shortList = merged.filter((r) => r.quality === 'short');
  line('【汇总】');
  line('  解析出条目        : ' + merged.length + ' 部（合并前 ' + merged.reduce((s, m) => s + (m.versionCount || 1), 0) + ' 个视频文件）');
  line('  命名正常(good)    : ' + merged.filter((r) => r.quality === 'good').length);
  line('  命名偏短(short)   : ' + shortList.length);
  line('  疑似缩写(abbr)    : ' + abbrList.length + '   <- 需人工确认');
  line('  多版本合并组      : ' + merged.filter((r) => r.versionCount > 1).length);
  line('  剧集目录条数(排除): ' + excluded.episode.length);
  line('  空目录/杂项(忽略) : ' + excluded.empty.length + ' 空 , ' + excluded.noise.length + ' 杂项');
  line();

  for (const dir of (config.movieDirs || [])) {
    const info = perDir[dir];
    if (!info) continue;
    const recs = merged.filter((r) => r.sourceDir === dir);
    line(HR);
    line(' 目录 ' + dir + '  （顶层 ' + info.total + ' 项 -> 收录 ' + recs.length + ' 部）');
    line(HR);
    let idx = 0;
    for (const r of recs) {
      idx++;
      const tagMap = { good: 'ok  ', short: 'shrt', abbr: '????' };
      const tag = tagMap[r.quality] || 'ok  ';
      const title = [r.cn || '(无中文名)', r.en ? '/ ' + r.en : ''].join(' ').trim();
      const meta = [r.year || '----', r.res || '', r.versionCount > 1 ? ('x' + r.versionCount + '版本') : '']
        .filter(Boolean).join(' · ');
      line('');
      line(' [' + tag + '] ' + String(idx).padStart(3, ' ') + '. ' + title + '   [' + meta + ']');
      for (const v of r.versions) {
        line('            ' + humanSize(v.size).padStart(9, ' ') + '  ' + v.fileName);
      }
      if (r.quality === 'abbr') {
        line('            !! 疑似拼音缩写 / 无片名线索，需人工确认');
        line('            原始目录名: ' + r.dirName);
      }
    }
    line();
  }

  if (abbrList.length) {
    line(HR);
    line(' 需要人工确认的条目（' + abbrList.length + ' 部）');
    line(HR);
    for (const r of abbrList) line('   · ' + pad(r.cn || r.en, 16) + '  原始: ' + r.dirName);
    line();
  }

  if (excluded.episode.length) {
    line(HR);
    line(' 识别为剧集 / 已排除（' + excluded.episode.length + ' 项）');
    line(HR);
    for (const e of excluded.episode) {
      line('   · ' + pad((e.count ? (e.count + ' 个文件') : ''), 12) + ' ' + e.reason + '  ' + e.name.slice(0, 70));
    }
    line();
  }

  if (excluded.empty.length || excluded.noise.length) {
    line(HR);
    line(' 空目录 / 杂项文件（忽略，' + (excluded.empty.length + excluded.noise.length) + ' 项）');
    line(HR);
    for (const e of excluded.empty) line('   · [空] ' + (e.name || '(整个目录)') + '  ' + e.reason);
    for (const e of excluded.noise.slice(0, 40)) line('   · [杂] ' + e.name.slice(0, 70));
    if (excluded.noise.length > 40) line('   · ... 其余 ' + (excluded.noise.length - 40) + ' 个');
    line();
  }

  return L.join('\n');
}

/** 把扫描结果落盘 */
function writeOutputs(result) {
  const dir = dataDirOf(result.config);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'preview.txt'), buildPreviewText(result), 'utf8');
  fs.writeFileSync(path.join(dir, 'scan-result.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      config: result.config,
      merged: result.merged,
      excluded: result.excluded,
    }, null, 2), 'utf8');
}

/** 汇总信息（给网页显示） */
function summarize(result) {
  const merged = result.merged || [];
  const excluded = result.excluded || { episode: [], noise: [], empty: [] };
  return {
    total: merged.length,
    files: merged.reduce((s, m) => s + (m.versionCount || 1), 0),
    good: merged.filter((r) => r.quality === 'good').length,
    short: merged.filter((r) => r.quality === 'short').length,
    abbr: merged.filter((r) => r.quality === 'abbr').length,
    multiVersion: merged.filter((r) => r.versionCount > 1).length,
    episodes: (excluded.episode || []).length,
    empty: (excluded.empty || []).length,
    noise: (excluded.noise || []).length,
    dirs: ((result.config && result.config.movieDirs) || []).map((d) => ({
      dir: d,
      topLevel: (result.perDir && result.perDir[d] && result.perDir[d].total) || 0,
      got: merged.filter((r) => r.sourceDir === d).length,
    })),
  };
}

module.exports = { scanAll, writeOutputs, buildPreviewText, summarize, loadConfig, dataDirOf, CONFIG_PATH };

// ------------------------------------------------------------------ 命令行模式
if (require.main === module) {
  const t0 = Date.now();
  const result = scanAll();
  writeOutputs(result);
  const s = summarize(result);
  console.log('[scan] done in ' + Math.round((Date.now() - t0) / 1000) + 's');
  console.log('  entries      : ' + s.total);
  console.log('  needs-review : ' + s.abbr);
  console.log('  episodes     : ' + s.episodes);
  console.log('  empty/noise  : ' + s.empty + '/' + s.noise);
  console.log('  preview      : ' + path.join(dataDirOf(result.config), 'preview.txt'));
}
