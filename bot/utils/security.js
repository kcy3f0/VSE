/**
 * 安全性與消毒工具模組
 */

/**
 * 消毒輸入字串，防止 Discord Mention 標籤注入與 Markdown 破壞
 * @param {string} text - 輸入字串
 * @param {number} maxLength - 最大長度限制
 * @returns {string} - 消毒後字串
 */
export function sanitizeText(text, maxLength = 200) {
  if (typeof text !== 'string') return '';
  
  let cleaned = text.trim();
  if (maxLength && cleaned.length > maxLength) {
    cleaned = cleaned.substring(0, maxLength);
  }

  // 插入零寬空格 (Zero-width space \u200B) 打破 Discord 標記
  cleaned = cleaned
    .replace(/@everyone/gi, '@\u200Beveryone')
    .replace(/@here/gi, '@\u200Bhere')
    .replace(/<@&/g, '<@\u200B&')
    .replace(/<@!/g, '<@\u200B!')
    .replace(/<@/g, '<@\u200B');

  return cleaned;
}

/**
 * 小隊非同步互斥鎖佇列 (Async Mutex Queue)
 * 確保同一個小隊的多個交易或資金操作依序執行，防止競態條件 (Race Condition)
 */
class TeamMutex {
  constructor() {
    this.queues = new Map();
  }

  /**
   * 鎖定指定 teamId 執行非同步函式
   * @param {string} teamId 
   * @param {Function} fn 
   */
  async runExclusive(teamId, fn) {
    const previousPromise = this.queues.get(teamId) || Promise.resolve();
    let release;
    const taskPromise = new Promise(resolve => {
      release = resolve;
    });

    this.queues.set(teamId, previousPromise.then(() => taskPromise));

    try {
      await previousPromise;
      return await fn();
    } finally {
      release();
      if (this.queues.get(teamId) === taskPromise) {
        this.queues.delete(teamId);
      }
    }
  }
}

export const teamMutex = new TeamMutex();
