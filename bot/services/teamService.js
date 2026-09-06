import { db } from '../database/storage.js';
import { STOCKS } from '../config/marketData.js';
import { HINTS } from '../config/hintsData.js';
import { sanitizeText } from '../utils/security.js';

export class TeamService {
  // 註冊或綁定小隊到文字頻道
  static bindTeamChannel(teamId, teamName, channelId) {
    const team = db.registerTeam(teamId, teamName, channelId);
    return team;
  }

  // 發放或扣除資金 (支援負數校正與餘額防呆)
  static addCash(teamId, amount, reason = null) {
    const team = db.getTeam(teamId);
    if (!team) throw new Error(`找不到小隊代碼：${teamId}`);
    if (typeof amount !== 'number' || isNaN(amount)) throw new Error('發放或扣除金額必須為有效數字');
    if (amount === 0) throw new Error('調整金額不可為 0！');

    // 負數扣款防呆：若餘額不足以扣除，拒絕操作以防靜默歸零 (H2 防呆)
    if (amount < 0 && team.cash + amount < 0) {
      throw new Error(`【扣款失敗】${team.name} 目前現金僅有 $${team.cash.toLocaleString()}，不足以扣除 $${Math.abs(amount).toLocaleString()}！`);
    }

    const defaultReason = amount >= 0 ? '關主發放獎勵資金' : '關主扣除校正資金';
    const cleanReason = sanitizeText(reason || defaultReason, 100);
    const newCash = team.cash + amount;

    const tx = {
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      round: db.getGameState().round,
      type: amount >= 0 ? 'CASH_GRANT' : 'CASH_DEDUCT',
      amount,
      balanceAfter: newCash,
      reason: cleanReason,
      timestamp: Date.now()
    };

    const transactions = [...(team.transactions || []), tx];
    db.updateTeam(teamId, { cash: newCash, transactions });

    return {
      team: db.getTeam(teamId),
      previousCash: team.cash,
      newCash,
      amount,
      reason: cleanReason
    };
  }

  // 發放闖關提示 (限制僅能在 QUIZ 階段發放，解決 H4)
  static unlockHint(teamId, round, stockId) {
    const gameState = db.getGameState();
    if (gameState.stage !== 'QUIZ') {
      throw new Error('市場情報僅能在「闖關解題階段 (QUIZ)」發放！');
    }

    const team = db.getTeam(teamId);
    if (!team) throw new Error(`找不到小隊代碼：${teamId}`);

    const stock = STOCKS[stockId];
    if (!stock) throw new Error(`無效的公司代碼：${stockId}，可用代碼：${Object.keys(STOCKS).join(', ')}`);

    const roundHints = HINTS[round];
    if (!roundHints || !roundHints[stockId]) {
      throw new Error(`找不到第 ${round} 期 ${stock.name} 的提示`);
    }

    const hintData = roundHints[stockId];
    const unlockedHints = team.unlockedHints || [];

    // 檢查是否已解鎖過
    const alreadyUnlocked = unlockedHints.some(h => h.round === round && h.stockId === stockId);
    if (alreadyUnlocked) {
      return {
        alreadyHad: true,
        hint: hintData,
        round,
        stock
      };
    }

    const newHintRecord = {
      round,
      stockId,
      stockName: stock.name,
      content: hintData.content,
      unlockedAt: Date.now()
    };

    db.updateTeam(teamId, {
      unlockedHints: [...unlockedHints, newHintRecord]
    });

    return {
      alreadyHad: false,
      hint: hintData,
      round,
      stock
    };
  }

  // 取得小隊所有已獲得的提示
  static getUnlockedHints(teamId) {
    const team = db.getTeam(teamId);
    if (!team) return [];
    return team.unlockedHints || [];
  }

  // 取得小隊當前持股與總市值
  static getPortfolioOverview(teamId, targetRound = null) {
    const team = db.getTeam(teamId);
    if (!team) throw new Error(`找不到小隊代碼：${teamId}`);

    const round = targetRound || db.getGameState().round;
    const portfolio = team.portfolio || {};

    let totalStockValue = 0;
    const holdings = [];

    for (const [stockId, shares] of Object.entries(portfolio)) {
      if (shares <= 0) continue;
      const stock = STOCKS[stockId];
      if (!stock) continue;

      const price = stock.prices[round] ?? 0;
      const value = price * shares;
      totalStockValue += value;

      holdings.push({
        stockId,
        name: stock.name,
        sector: stock.sector,
        shares,
        currentPrice: price,
        totalValue: value,
        isDelisted: round === stock.delistedInRound
      });
    }

    const totalAsset = team.cash + totalStockValue;

    return {
      teamId: team.id,
      teamName: team.name,
      round,
      cash: team.cash,
      totalStockValue,
      totalAsset,
      holdings
    };
  }
}
