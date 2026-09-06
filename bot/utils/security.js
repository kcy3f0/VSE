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

  // 過濾 ASCII 控制字元 (保留換行與 Tab)
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // 插入零寬空格 (Zero-width space \u200B) 打破 Discord 標記與提及，並過濾反引號防破版
  cleaned = cleaned
    .replace(/@everyone/gi, '@\u200Beveryone')
    .replace(/@here/gi, '@\u200Bhere')
    .replace(/<@&/g, '<@\u200B&')
    .replace(/<@!/g, '<@\u200B!')
    .replace(/<@/g, '<@\u200B')
    .replace(/<#/g, '<#\u200B')
    .replace(/`/g, '＇');

  return cleaned;
}

/**
 * 小隊非同步互斥鎖佇列 (Async Mutex Queue)
 * 確保同一個小隊的多個交易或資金操作依序執行，防止競態條件 (Race Condition)
 * 實作前序 Promise 自動捕獲屏障，免疫拒絕污染 (Rejection Contamination)
 */
export class TeamMutex {
  constructor() {
    this.queues = new Map();
    this.globalBarrier = Promise.resolve();
  }

  /**
   * 鎖定指定 teamId 執行非同步函式
   * @param {string} teamId 
   * @param {Function} fn 
   */
  async runExclusive(teamId, fn) {
    const globalWait = this.globalBarrier;
    const prev = this.queues.get(teamId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => {
      release = resolve;
    });

    this.queues.set(teamId, current);

    try {
      await globalWait.catch(() => {});
      await prev.catch(() => {});
      return await fn();
    } finally {
      release();
      if (this.queues.get(teamId) === current) {
        this.queues.delete(teamId);
      }
    }
  }

  /**
   * 全域互斥鎖：鎖定全場所有小隊佇列（用於回合結算、資料庫重設等重大全域操作）
   * @param {Function} fn 
   */
  async runGlobal(fn) {
    const existingQueues = Array.from(this.queues.values());
    const prevGlobal = this.globalBarrier;

    let release;
    const currentGlobal = new Promise(resolve => {
      release = resolve;
    });

    this.globalBarrier = currentGlobal;

    try {
      await prevGlobal.catch(() => {});
      await Promise.all(existingQueues.map(p => p.catch(() => {})));
      return await fn();
    } finally {
      release();
    }
  }
}

export const teamMutex = new TeamMutex();
