'use strict';

/**
 * 首次配置向导：询问电影目录 → 写入 config.json → 立即扫描一遍
 *
 *   node src/setup.js
 *
 * 也可以在运行时把文件夹直接拖进命令行窗口（Windows 会自动补上引号和反斜杠，
 * 这里都会自动处理）。
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

let CONFIG = {};
try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 全新安装 */ }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

/** 归一化用户输入的目录：去引号、去尾部斜杠、统一正斜杠 */
function normalizeDir(s) {
  let t = String(s || '').trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (!t) return '';
  t = t.replace(/\\/g, '/').replace(/\/+$/, '');
  return t;
}

function dirInfo(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return { ok: false, reason: '这不是一个文件夹' };
    let n = 0;
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      if (it.isDirectory()) n++;
      if (n >= 5000) break;
    }
    return { ok: true, subs: n };
  } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? '路径不存在' : String(e.message) };
  }
}

(async () => {
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  电影库 · 首次配置向导');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
  console.log('  接下来请告诉我：你的电影都放在哪些目录里？');
  console.log('  一行填一个，全部填完后**直接回车**结束。');
  console.log('');
  console.log('  提示：');
  console.log('   · 可以直接从资源管理器把文件夹拖进这个窗口，会自动填好路径');
  console.log('   · 每个目录下面应该是一个个电影子文件夹（或视频文件）');
  console.log('   · 只填"电影库"的根目录，程序会自己往里面找视频');
  console.log('');

  const existing = Array.isArray(CONFIG.movieDirs) ? CONFIG.movieDirs.filter(Boolean) : [];
  if (existing.length) {
    console.log('  （当前已配置：' + existing.join('  ,  ') + '）');
    console.log('  （重新填写会覆盖上面的列表）');
    console.log('');
  }

  const dirs = [];
  for (;;) {
    const raw = await ask('  目录 ' + (dirs.length + 1) + '  > ');
    const dir = normalizeDir(raw);
    if (!dir) break;

    if (dirs.includes(dir)) { console.log('      · 已经加过了，跳过'); continue; }

    const info = dirInfo(dir);
    if (!info.ok) { console.log('      ✗ ' + info.reason + '：' + dir); continue; }

    dirs.push(dir);
    console.log('      ✓ 已添加（下面有 ' + info.subs + ' 个子文件夹）');
  }

  if (!dirs.length) {
    console.log('');
    console.log('  没有填写任何目录，配置未改动。');
    rl.close();
    return;
  }

  CONFIG.movieDirs = dirs;
  if (!CONFIG.dataDir) CONFIG.dataDir = 'data';
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2), 'utf8');

  console.log('');
  console.log('  已写入 config.json：');
  for (const d of dirs) console.log('    · ' + d);
  console.log('');
  console.log('  现在开始扫描这些目录（可能需要几十秒到几分钟）…');
  console.log('');

  rl.close();

  // 跑扫描
  try {
    const S = require('./scan');
    const t0 = Date.now();
    const result = S.scanAll((done, total, dir) => {
      process.stdout.write('    [' + done + '/' + total + '] 已扫描 ' + dir + '\n');
    });
    S.writeOutputs(result);
    const sum = S.summarize(result);
    console.log('');
    console.log('  扫描完成，用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
    console.log('    收录影片      : ' + sum.total + ' 部');
    console.log('    命名待确认    : ' + sum.abbr + ' 部');
    console.log('    多版本合并    : ' + sum.multiVersion + ' 组');
    console.log('    排除的剧集    : ' + sum.episodes + ' 个目录');
  } catch (e) {
    console.log('');
    console.log('  扫描出错：' + ((e && e.message) || e));
    console.log('  你可以稍后自己运行：  node src/scan.js');
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  配置完成！接下来：');
  console.log('');
  console.log('   1) 抓取豆瓣资料（海报 / 评分 / 简介）');
  console.log('      双击  fetch-auto.bat   或运行  node src/fetch.js --forever');
  console.log('');
  console.log('   2) 打开网页海报墙');
  console.log('      双击  启动.bat');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
})();
