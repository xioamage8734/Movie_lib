'use strict';

/**
 * 兼容转发层。
 * 文件名清洗/解析的真实实现已移动到 ./parse.js，
 * 这里保留 ./clean 入口，避免旧引用失效。
 */

module.exports = require('./parse');
