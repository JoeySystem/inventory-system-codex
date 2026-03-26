/**
 * 拼音工具
 * 用于生成物料名称的全拼和首字母缩写，支持搜索
 */

const { pinyin } = require('pinyin-pro');

/**
 * 为中文文本生成拼音索引字段
 * @param {string} text - 中文文本
 * @returns {{ fullPinyin: string, abbr: string }}
 */
function generatePinyinFields(text) {
    if (!text) return { fullPinyin: '', abbr: '' };

    try {
        // 全拼（不带声调）: "信号增强器" -> "xinhaozengqiangqi"
        const fullPinyin = pinyin(text, {
            toneType: 'none',
            type: 'array',
            nonZh: 'consecutive'  // 非中文字符保持原样连续输出
        }).join('').toLowerCase();

        // 首字母缩写: "信号增强器" -> "xhzqq"
        const abbr = pinyin(text, {
            pattern: 'first',
            toneType: 'none',
            type: 'array',
            nonZh: 'consecutive'
        }).join('').toLowerCase();

        return { fullPinyin, abbr };
    } catch (err) {
        console.error('拼音生成失败:', err.message, '文本:', text);
        return { fullPinyin: '', abbr: '' };
    }
}

/**
 * 构建搜索 SQL 条件
 * 支持：中文名称、全拼、简拼、编码的模糊匹配（大小写不敏感）
 *
 * @param {string} keyword - 用户输入的搜索词
 * @param {object} options - 配置选项
 * @param {string} options.nameField - 名称字段名（默认 'name'）
 * @param {string} options.pinyinField - 全拼字段名（默认 'name_pinyin'）
 * @param {string} options.abbrField - 简拼字段名（默认 'name_pinyin_abbr'）
 * @param {string} options.codeField - 编码字段名（可选，默认 null）
 * @returns {{ where: string, params: string[] }}
 */
function buildSearchCondition(keyword, options = {}) {
    const {
        nameField = 'name',
        pinyinField = 'name_pinyin',
        abbrField = 'name_pinyin_abbr',
        codeField = null
    } = options;

    if (!keyword || !keyword.trim()) {
        return { where: '1=1', params: [] };
    }

    const term = `%${keyword.trim().toLowerCase()}%`;
    const conditions = [
        `LOWER(${nameField}) LIKE ?`,
        `${pinyinField} LIKE ?`,
        `${abbrField} LIKE ?`
    ];
    const params = [term, term, term];

    if (codeField) {
        conditions.push(`LOWER(${codeField}) LIKE ?`);
        params.push(term);
    }

    return {
        where: `(${conditions.join(' OR ')})`,
        params
    };
}

module.exports = { generatePinyinFields, buildSearchCondition };
