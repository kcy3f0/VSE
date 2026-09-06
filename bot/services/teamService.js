import { db } from '../database/storage.js';
import { STOCKS } from '../config/marketData.js';
import { HINTS } from '../config/hintsData.js';

export class TeamService {
  // 註冊或綁定小隊到文字頻道
  static bindTeamChannel(teamId, teamName, channelId) {
    const team = db.registerTeam(teamId, teamName, channelId);
    return team;
  }

  // 發放資金
  static addCash(teamId, amount, reason = '關主發放獎勵資金') {
    const team = db.getTeam(teamId);
    if (!team) throw new Error(`找不到小隊代碼：${teamId}`);
    if (typeof amount !== 'number' || isNaN(amount)) throw new Error('發放金額必須為有效數字');

    const newCash = Math.max(0, team.cash + amount);
    const tx = {
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      round: db.getGameState().round,
      type: 'CASH_GRANT',
      amount,
      balanceAfter: newCash,
      reason,
      timestamp: Date.now()
    };

    const transactions = [...(team.transactions || []), tx];
    db.updateTeam(teamId, { cash: newCash, transactions });

    return {
      team,
      previousCash: team.cash,
      newCash,
      amount,
      reason
    };
  }

  // 發放闖關提示
  static unlockHint(teamId, round, stockId) {
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
