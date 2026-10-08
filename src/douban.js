'use strict';

/**
 * 豆瓣数据抓取模块（零依赖，使用 Node 18+ 内置 fetch）
 *
 * 本机实测：
 *   搜索： search.douban.com/movie/subject_search?search_text=<关键词>
 *          -> HTML，数据在 window.__DATA__ 里；被限流时 error_info 会写「搜索访问太频繁。」
 *   详情： m.douban.com/rexxar/api/v2/movie/<id>   -> JSON（稳定，几乎不限流）
 *   海报： imgX.doubanio.com/view/photo/...         （必须带 Referer，稳定）
 *   （movie.douban.com/j/subject_suggest 也会被限流，且限流时只返回空数组、无法区分，故不作为主搜索）
 *
 * 反爬对策：
 *   1. 搜索与其它请求分开限速（搜索慢、详情/海报快）
 *   2. 识别 error_info 里的「太频繁」→ 触发长冷却后退避重试
 *   3. 全局冷却（cooldownUntil）让所有请求一起等
 */

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let minIntervalMs = 1200;        // 详情 / 海报的间隔
let searchIntervalMs = 6000;     // 搜索的间隔（豆瓣对搜索最敏感）
let lastRequestAt = 0;
let lastSearchAt = 0;
let cooldownUntil = 0;

/**
 * 给间隔加 ±35% 的随机抖动。
 * 固定的请求节奏本身就是最容易识别的爬虫特征——真实用户不会每隔精确 1.800 秒
 * 点一次。抖动后实际间隔在 0.65x ~ 1.35x 之间浮动，平均值保持不变。
 */
function jitter(ms) {
  return Math.round(ms * (0.65 + Math.random() * 0.7));
}

function setMinInterval(ms) { minIntervalMs = Math.max(200, Number(ms) || 1200); }
function setSearchInterval(ms) { searchIntervalMs = Math.max(1000, Number(ms) || 6000); }
function cooldown(ms) { cooldownUntil = Math.max(cooldownUntil, Date.now() + ms); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitUntil(t) { const w = t - Date.now(); if (w > 0) await sleep(w); }

async function throttle() {
  await waitUntil(Math.max(lastRequestAt + jitter(minIntervalMs), cooldownUntil));
  lastRequestAt = Date.now();
}

async function searchThrottle() {
  await waitUntil(Math.max(
    lastSearchAt + jitter(searchIntervalMs),
    lastRequestAt + jitter(minIntervalMs),
    cooldownUntil,
  ));
  lastSearchAt = Date.now();
  lastRequestAt = Date.now();
}

// ---------------------------------------------------------------- 底层请求

async function rawFetch(url, referer, accept, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': accept,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': referer || 'https://movie.douban.com/',
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, referer, retry = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retry; attempt++) {
    await throttle();
    try {
      const res = await rawFetch(url, referer, 'application/json, text/plain, */*', 20000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retry) cooldown(2000 * attempt);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- 解析

/** 从 HTML 里按括号配平抠出一个 JSON 对象（字符串感知） */
function extractJson(s, from) {
  const i = s.indexOf('{', from);
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(i, j + 1); }
  }
  return null;
}

/** 搜索页标题形如“霸王别姬 ‎ (1993)” → 取出主标题 */
function cleanSearchTitle(t) {
  let s = String(t).replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, ' ').trim();
  s = s.replace(/\s*\(\d{4}\)\s*$/, '').trim();
  if (/^[\u4e00-\u9fff]/.test(s)) {
    const sp = s.search(/\s/);
    if (sp > 0) s = s.slice(0, sp);
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** 解析搜索页；返回 { items, error }，error 为豆瓣给出的提示（如“搜索访问太频繁。”） */
function parseSearchHtml(html) {
  const idx = html.indexOf('window.__DATA__');
  if (idx < 0) return { items: [], error: 'no-data-block' };
  const raw = extractJson(html, idx);
  if (!raw) return { items: [], error: 'extract-failed' };
  let data;
  try { data = JSON.parse(raw); } catch { return { items: [], error: 'json-failed' }; }
  const error = (data && data.error_info) ? String(data.error_info) : '';
  const arr = (data && Array.isArray(data.items)) ? data.items : [];
  const items = arr
    .filter((it) => it && it.id && it.title)
    .map((it) => {
      const m = String(it.title).match(/\((\d{4})\)\s*$/);
      return {
        id: String(it.id),
        title: cleanSearchTitle(it.title),
        rawTitle: String(it.title),
        year: m ? parseInt(m[1], 10) : null,
        sub_title: '',
        img: it.cover_url || '',
        type: 'movie',
        doubanScore: it.rating && it.rating.value ? Number(it.rating.value) : null,
      };
    });
  return { items, error };
}

/** 是否命中「访问太频繁」这类限流提示 */
function isRateLimited(err) {
  return !!err && /(太频繁|频繁|forbidden|denied)/i.test(err);
}

// ---------------------------------------------------------------- 搜索

/**
 * 搜索：search.douban.com 的 HTML 搜索页
 * @param {string} keyword
 * @param {number} tries 最多尝试次数（含退避重试）
 */
async function searchHtml(keyword, tries = 3) {
  const url = 'https://search.douban.com/movie/subject_search?search_text=' + encodeURIComponent(keyword);
  for (let t = 1; t <= tries; t++) {
    try {
      await searchThrottle();
      const res = await rawFetch(url, 'https://movie.douban.com/',
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 25000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      const { items, error } = parseSearchHtml(html);
      if (items.length) return items;
      if (isRateLimited(error)) {
        cooldown(40000 * t);          // 明确限流：40s / 80s / 120s 退避
      } else if (t < tries) {
        cooldown(4000 * t);
      }
    } catch {
      if (t < tries) cooldown(6000 * t);
    }
  }
  return [];
}

async function suggest(keyword) {
  if (!keyword) return [];
  // ① 主：subject_suggest —— 豆瓣真正的「搜索建议」接口
  const a = await suggestJson(keyword);
  if (a.length) return a;
  // ② 次：j/search_subjects（标签接口）—— 实测比 search.douban.com 宽松得多。
  //      注意它不回年份，只能靠标题匹配；但主接口被限流时它是个好兜底。
  const b = await searchSubjects(keyword);
  if (b.length) return b;
  // ③ 最后才动用最敏感的 search.douban.com HTML 搜索页
  return await searchHtml(keyword, 2);
}

/**
 * 主搜索接口： movie.douban.com/j/subject_suggest?q=<关键词>
 * 这是豆瓣真正的搜索建议接口，返回 { id, title, year, sub_title, img, type }。
 * 注意：批量请求时它会被限流（限流时只返回空数组，响应里看不出来），
 *      所以调用方必须配合冷却退避，失败时再回退到 searchHtml。
 */
async function suggestJson(keyword, tries = 2) {
  const url = 'https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(keyword);
  for (let t = 1; t <= tries; t++) {
    try {
      await searchThrottle();
      const res = await rawFetch(url, 'https://movie.douban.com/',
        'application/json, text/plain, */*', 20000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data
        .filter((d) => d && d.id)
        .map((d) => ({
          id: String(d.id),
          title: d.title || '',
          year: parseInt(d.year, 10) || null,
          sub_title: d.sub_title || '',
          img: d.img || '',
          type: d.type || '',
        }));
    } catch {
      if (t < tries) cooldown(5000);
    }
  }
  return [];
}

/**
 * 主搜索入口：豆瓣「分类/标签」接口，把它当关键词搜索用。
 * 实测  https://movie.douban.com/j/search_subjects?type=movie&tag=<关键词>
 * 会返回匹配影片（title / rate / cover / id），且比 search.douban.com 宽松得多，
 * 是目前最稳的搜索入口。注意它不回年份，年份由 detail() 补齐。
 */
async function searchSubjects(keyword, pageLimit = 20) {
  const url = 'https://movie.douban.com/j/search_subjects?type=movie&tag='
    + encodeURIComponent(keyword) + '&page_limit=' + pageLimit + '&page_start=0';
  for (let t = 1; t <= 2; t++) {
    try {
      await searchThrottle();
      const res = await rawFetch(url, 'https://movie.douban.com/',
        'application/json, text/plain, */*', 20000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const arr = (data && Array.isArray(data.subjects)) ? data.subjects : [];
      return arr
        .filter((s) => s && s.id)
        .map((s) => ({
          id: String(s.id),
          title: s.title || '',
          year: null,
          sub_title: '',
          img: s.cover || '',
          type: 'movie',
          doubanScore: s.rate ? Number(s.rate) : null,
        }));
    } catch {
      if (t < 2) cooldown(5000);
    }
  }
  return [];
}

// ---------------------------------------------------------------- 详情 / 海报

async function detail(id) {
  const url = 'https://m.douban.com/rexxar/api/v2/movie/' + id;
  const d = await fetchJson(url, 'https://m.douban.com/movie/subject/' + id + '/');
  const pic = d.pic || {};
  const rating = d.rating || {};
  return {
    id: String(d.id || id),
    title: d.title || '',
    year: parseInt(d.year, 10) || null,
    aka: Array.isArray(d.aka) ? d.aka : [],
    rating: rating.value ? Number(rating.value) : null,
    ratingCount: rating.count ? Number(rating.count) : null,
    genres: Array.isArray(d.genres) ? d.genres : [],
    countries: Array.isArray(d.countries) ? d.countries : [],
    durations: Array.isArray(d.durations) ? d.durations : [],
    intro: d.intro || '',
    directors: Array.isArray(d.directors) ? d.directors.map((x) => x && x.name).filter(Boolean) : [],
    actors: Array.isArray(d.actors) ? d.actors.map((x) => x && x.name).filter(Boolean) : [],
    posterUrl: pic.large || pic.normal || '',
  };
}

async function downloadPoster(url, dest, retry = 3) {
  if (!url) return false;
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return true;
  } catch { /* ignore */ }

  for (let attempt = 1; attempt <= retry; attempt++) {
    await throttle();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Referer': 'https://movie.douban.com/' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error('image too small');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return true;
    } catch {
      clearTimeout(timer);
      if (attempt < retry) await sleep(800 * attempt);
    }
  }
  return false;
}

module.exports = {
  setMinInterval, setSearchInterval, sleep, cooldown,
  suggest, suggestJson, searchHtml, searchSubjects, detail, downloadPoster,
};
