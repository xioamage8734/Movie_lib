'use strict';

/**
 * 文件名 / 目录名 清洗与解析模块（自包含版本）
 *
 * 目标：从下载站风格的目录名中提取出 { 中文名, 英文名, 年份, 分辨率 }
 */

// ---------------------------------------------------------------- 扩展名

const VIDEO_EXTS = [
  '.mkv', '.mp4', '.avi', '.rmvb', '.rm', '.ts', '.m2ts', '.mov',
  '.wmv', '.flv', '.m4v', '.mpg', '.mpeg', '.iso', '.3gp', '.vob',
];

const NOISE_EXTS = [
  '.torrent', '.srt', '.ass', '.ssa', '.sub', '.idx', '.sup',
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp',
  '.nfo', '.txt', '.db', '.ini', '.url', '.lnk', '.md5', '.sfv',
  '.bak', '.parts', '.part', '.downloading', '.!ut', '.ddp',
];

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

function isVideo(name) { return VIDEO_EXTS.includes(extOf(name)); }
function isNoiseExt(name) { return NOISE_EXTS.includes(extOf(name)); }

// ---------------------------------------------------------------- 广告文件

// 下载站塞在电影目录里的“广告片”特征词。
// 注意：[最新电影www.xxx.com] 这类是“真电影文件名上的水印”，不能当成广告片，
//        所以这里只保留纯广告片才有的措辞。
const AD_FILE_WORDS = [
  '更多蓝光', '更多无水印', '更多高清', '更多原盘', '注册会员',
  '更多资源', '下载多达', '无限制下载',
];

function isAdFile(name) {
  const low = name.toLowerCase();
  if (AD_FILE_WORDS.some((w) => low.includes(w.toLowerCase()))) return true;
  // 去掉所有括号内容与扩展名后什么都不剩 → 整个文件名就是个广告
  const stripped = name
    .replace(/[【\[]([^】\]]*)[】\]]/g, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[.\s_\-\u00b7]/g, '');
  return stripped.length === 0;
}

// ---------------------------------------------------------------- 剧集识别

const EP_RE = /S\d{1,2}\s*[._-]?\s*E\d{1,3}/i;         // S01E01
const EP_CN_1 = /第\s*\d+\s*[-~—至]?\s*\d*\s*集/;        // 第01-07集
const EP_CN_2 = /[共全总]\s*\d+\s*集/;                    // 全6集
const SEASON_CN = /第\s*[一二三四五六七八九十百\d]+\s*季/; // 第三季
const SEASON_EN = /\bSeason\s*\d+/i;                     // Season.1

function isEpisodeName(name) {
  return EP_RE.test(name) || EP_CN_1.test(name) || EP_CN_2.test(name)
      || SEASON_CN.test(name) || SEASON_EN.test(name);
}

// ---------------------------------------------------------------- 解析

// 出现在 【】/[]/() 内，说明该括号是广告或标签，不是片名
const BRACKET_NOISE = [
  'www', 'http://', 'https://', '.com', '.net', '.org', '.cn', '.me',
  '发布', '访问', '更多', '注册', '会员', '最新电影', '首发', '下载',
  '高清', '电影港', '6v电影', '迅雷', '磁力',
  '音轨', '字幕', '国粤', '国语', '粤语', '简繁', '中字', '国英', '双语', '多音轨',
  '蓝光', '无水印', '原盘', '压制', '修复', '帧', 'hevc', 'h265', 'x265',
  '合集', 'cmct', '收藏', '第', '集', '季', '部', '版',
];

// 技术 / 语言 / 来源 标记：截断英文名时遇到就停
const TECH_RE = new RegExp(
  '^(?:' +
  [
    '\\d{3,4}p', '\\d{3,4}i', '4k', '8k', 'uhd', 'hd', 'sd',
    'blu-?ray', 'bd(?:rip|remux)?', 'web[-.]?dl', 'webrip', 'web', 'hdrip', 'dvdrip',
    'brrip', 'bdrip', 'hdtv', 'remux', 'dvd',
    'x26[45]', 'h[.\\s]?26[45]', 'hevc', 'avc', 'av1', 'mpeg\\d?', 'divx', 'xvid',
    'aac\\d*', 'ac3', 'eac3', 'dd[p+]?\\d*(?:\\.\\d)?', 'dts(?:-hd)?', 'dtsx', 'truehd',
    'flac', 'lpcm', 'pcm', 'atmos', 'thd', '\\d+bit', 'hdr\\d*', 'dv', 'sdr', 'imax',
    'proper', 'repack', 'internal', 'extended', 'uncut', 'remaster(?:ed)?', 'restored',
    'criterion', 'cc', 'collection', 'complete', 'trilogy',
    'chinese', 'english', 'japanese', 'korean', 'cantonese', 'mandarin', 'multi',
    'dual', '\\d+audio', '\\d+subs?', '\\d+\\s*\\d+',
    'nf', 'dsnp', 'itunes', 'amzn', 'catchplay', 'hmax', 'hulu', 'atvp', 'max', 'disney',
    'esub', 'cmct', 'zero', 'gpt',
  ].join('|') +
  ')(?:[-.][a-z0-9]+)*$', 'i',
);

function isTechTok(t) {
  if (/^(19|20)\d{2}$/.test(t)) return false; // 年份单独处理
  return TECH_RE.test(t);
}

// 语言 / 字幕 / 水印类标签：出现在片名后面时应当截断
//   （用「包含」判断，这样 “国粤双语”“HD中字无水印” 这类组合词也能识别）
const CN_LABEL_WORDS = [
  '国粤', '国语', '粤语', '双语', '多音轨', '国英', '中字', '中英',
  '简繁', '字幕', '配音', '原声', '无水印', '未删减',
];
function isCnLabel(t) { return CN_LABEL_WORDS.some((w) => t.includes(w)); }

/**
 * 解析一个目录名或文件名，返回 { cn, en, year, res, parts, quality }
 */
function parseMovieName(rawName) {
  let s = String(rawName);

  // 1) 合集数量： [共9部合集] / [全6集]
  let parts = null;
  const pm = s.match(/[共全总]\s*(\d+)\s*部?\s*合集/) || s.match(/[共全总]\s*(\d+)\s*集/);
  if (pm) parts = parseInt(pm[1], 10);

  // 2) 去掉噪音括号；保留可能是片名的括号
  s = s.replace(/【([^】]*)】|\[([^\]]*)\]|\(([^()]*)\)/g, (m, a, b, c) => {
    const inner = String(a ?? b ?? c ?? '').trim();
    if (!inner) return ' ';
    const low = inner.toLowerCase();
    if (BRACKET_NOISE.some((w) => low.includes(w.toLowerCase()))) return ' ';
    return ' ' + inner + ' ';
  });

  // 3) 去掉下载站尾巴
  s = s.replace(/[.\u00b7\u3002\u3001\s]*(6v电影|电影港|迅雷|磁力|高清影视|影视之家)[\s\S]*$/i, ' ');
  s = s.replace(/(地址发布页|收藏不迷路|最新电影|更多高清)[\s\S]*$/, ' ');
  s = s.replace(/[.\u00b7\s]*(https?:\/\/|\bwww\.)[\s\S]*$/i, ' ');

  // 4) 常见“片尾组名”： -MiniHD / ￡压制组名 / @站点域名.COM / 6.94GB
  s = s.replace(/[\s]*[￡@][^\s]*/g, ' ');
  s = s.replace(/\s*\d+(?:\.\d+)?\s*(?:GB|MB|GiB)\s*$/i, ' ');

  // 5) 归一：标点→空格（保留 · 和 - ）
  s = s.replace(/[《》“”‘’"'`]/g, ' ')
       .replace(/[._]/g, ' ')
       .replace(/\s+/g, ' ')
       .trim();

  const tokens = s.split(' ').filter(Boolean);

  let cn = '', en = '', year = null, res = null;

  // 中文名：开头连续的“含 CJK” token；遇到语言/字幕类标签就停下
  //   （例：久别·重逢1080p . 国粤双语 . HD中字无水印  →  只需要“久别·重逢”）
  let i = 0;
  const cnParts = [];
  while (i < tokens.length && /[\u4e00-\u9fff]/.test(tokens[i]) && !isTechTok(tokens[i])) {
    if (isCnLabel(tokens[i])) {
      if (cnParts.length) break;   // 已经拿到片名了 → 后面是标签，停
      i++;                          // 还没片名 → 这是开场标签，跳过
      continue;
    }
    cnParts.push(tokens[i]);
    i++;
  }
  cn = cnParts.join('');
  // 中文名尾部若粘连了技术标记（如“久别·重逢1080p”），剥掉
  cn = cn.replace(/(?:\d{3,4}[pi]|\d+bit|hd|bd)$/i, '').trim();

  // 英文名：直到遇到 年份 / 技术词
  const enParts = [];
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^(19|20)\d{2}$/.test(t)) { year = parseInt(t, 10); i++; break; }
    if (isTechTok(t)) { i++; break; }
    enParts.push(t);
  }
  en = enParts.join(' ').replace(/\s+/g, ' ').trim();

  // 年份兜底：整体再找一次
  if (year == null) {
    const m = (cn + ' ' + en).match(/\b(19\d{2}|20\d{2})\b/);
    if (m) year = parseInt(m[1], 10);
  }

  // 分辨率
  const whole = rawName + ' ' + s;
  const rm = whole.match(/\b(2160p|1080p|720p|480p|4K|UHD)\b/i);
  if (rm) res = rm[1].toUpperCase();

  return { cn: cn.trim(), en, year, res, parts, quality: nameQuality(cn, en) };
}

/**
 * 判断提取出的片名是否“像个真片名”
 *   good  : 可用
 *   short : 太短，可能不准
 *   abbr  : 疑似拼音缩写 / 无意义（需人工确认）
 */
function nameQuality(cn, en) {
  const cjk = (cn.match(/[\u4e00-\u9fff]/g) || []).length;
  const cnHasLatin = /[A-Za-z]/.test(cn);

  // 中文名里混了拉丁字母（gcz道 / zlj：重生 / 分sq单）→ 疑似缩写
  if (cn && cnHasLatin && cjk <= 3) return 'abbr';
  if (!cn) {
    const words = en.split(/\s+/).filter(Boolean);
    if (words.length === 0) return 'abbr';
    // 多词英文名，且像正常片名大小写
    if (words.length >= 2 && /^[A-Z]/.test(words[0])) return 'good';
    // 单个英文单词：首字母大写、其余小写（Saw / Interstellar）
    const w = words[0];
    if (/^[A-Z][a-z]{2,}$/.test(w)) return 'good';
    return 'abbr';
  }
  return cjk >= 2 ? 'good' : 'short';
}

/**
 * 用于判断「同一部片的不同版本」的归一化 key。
 *
 * ★ 有个坑必须避开：片名**彻底解析不出来**时（目录名全是一堆广告词或符号），
 *   base 会是空字符串，于是 key 变成 "|" —— 两部毫不相干的片子只要都解析不出名字、
 *   年份又恰好相同，就会被并成同一条，而用户还没法分别手动匹配。
 *   所以这种情况下改用 extra（目录 + 文件名）当依据：每个文件各算一条。
 *   宁可多出几条让用户自己合并，也绝不能把不同的片子混在一起。
 */
function normalizeKey(cn, en, year, extra) {
  const base = (cn && cn.length ? cn : en).toLowerCase().replace(/[\s.·:：\-_]/g, '');
  if (!base) {
    return '?' + String(extra || '').toLowerCase().replace(/\\/g, '/') + '|' + (year || '');
  }
  return base + '|' + (year || '');
}

module.exports = {
  VIDEO_EXTS, NOISE_EXTS,
  extOf, isVideo, isNoiseExt, isAdFile,
  isEpisodeName,
  parseMovieName, nameQuality, normalizeKey,
  isTechTok,
};
