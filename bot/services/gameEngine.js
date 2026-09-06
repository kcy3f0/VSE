import { db } from '../database/storage.js';
import { STOCKS, TOTAL_ROUNDS, DEFAULT_TRADING_DURATION_SECONDS } from '../config/marketData.js';
import { TeamService } from './teamService.js';

export class GameEngine {
  static timer = null;

  // 執行買賣交易
  static executeTrade(teamId, type, stockId, shares) {
    const gameState = db.getGameState();
    if (gameState.stage !== 'TRADING') {
      throw new Error('目前非投資交易階段，市場已關閉！請在 5 分鐘投資時間內進行下單。');
    }

    // 檢查是否已逾 5 分鐘投資時間
    if (gameState.tradingEndsAt && Date.now() > gameState.tradingEndsAt) {
      throw new Error('【交易截止】5 分鐘投資交易時間已截止，市場關閉等候結算！');
    }

    const team = db.getTeam(teamId);
    if (!team) throw new Error(`找不到小隊：${teamId}`);

    const stock = STOCKS[stockId];
    if (!stock) throw new Error(`無效的股票代碼：${stockId}`);

    const round = gameState.round;
    const currentPrice = stock.prices[round];

    // 第四期下市處理 (H1: 禁止買入與賣出)
    if (stock.delistedInRound === round) {
      throw new Error(`【交易失敗】${stock.name} 在本期已下市，股票現值已歸零且無法進行任何買賣！`);
    }

    if (!Number.isInteger(shares) || shares <= 0) {
      throw new Error('交易股數必須為大於 0 的正整數！');
    }

    const totalCost = currentPrice * shares;
    const portfolio = { ...(team.portfolio || {}) };
    const currentHolding = portfolio[stockId] || 0;

    let newCash = team.cash;
    let newHolding = currentHolding;

    if (type === 'BUY') {
      if (team.cash < totalCost) {
        throw new Error(`【現金不足】購買 ${shares} 股 ${stock.name} 需要 $${totalCost.toLocaleString()}，您目前現金僅有 $${team.cash.toLocaleString()}。`);
      }
      newCash = team.cash - totalCost;
      newHolding = currentHolding + shares;
      portfolio[stockId] = newHolding;
    } else if (type === 'SELL') {
      if (currentHolding < shares) {
        throw new Error(`【庫存不足】您目前僅持有 ${currentHolding} 股 ${stock.name}，無法賣出 ${shares} 股！`);
      }
      newCash = team.cash + totalCost;
      newHolding = currentHolding - shares;
      if (newHolding === 0) {
        delete portfolio[stockId];
      } else {
        portfolio[stockId] = newHolding;
      }
    } else {
      throw new Error('無效的交易類型 (必須為 BUY 或 SELL)');
    }

    const tx = {
      id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      round,
      type,
      stockId,
      stockName: stock.name,
      shares,
      price: currentPrice,
      totalAmount: totalCost,
      cashAfter: newCash,
      timestamp: Date.now()
    };

    const transactions = [...(team.transactions || []), tx];
    db.updateTeam(teamId, {
      cash: newCash,
      portfolio,
      transactions
    });

    return {
      tx,
      team: db.getTeam(teamId),
      stock,
      currentPrice,
      shares,
      totalCost,
      newCash,
      newHolding
    };
  }

  // 推進至解題闖關階段
  static startQuizStage(round = null) {
    const currentState = db.getGameState();
    const targetRound = round ?? currentState.round;

    if (targetRound > TOTAL_ROUNDS) {
      throw new Error(`遊戲總共只有 ${TOTAL_ROUNDS} 期，請進行終局結算。`);
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    db.updateGameState({
      round: targetRound,
      stage: 'QUIZ',
      tradingEndsAt: null
    });

    return db.getGameState();
  }

  // 推進至投資交易階段
  static startTradingStage(durationSeconds = DEFAULT_TRADING_DURATION_SECONDS, onTick = null, onExpire = null) {
    const currentState = db.getGameState();
    if (currentState.round > TOTAL_ROUNDS) {
      throw new Error('所有回合已完成！');
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const currentRound = currentState.round;
    const endsAt = Date.now() + durationSeconds * 1000;
    db.updateGameState({
      stage: 'TRADING',
      tradingEndsAt: endsAt
    });

    // 啟動倒數檢查器 (綁定當前期數與狀態，解決 C5)
    this.timer = setInterval(() => {
      const state = db.getGameState();
      // 若已非交易階段或回合已被切換，立即終止計時器
      if (state.stage !== 'TRADING' || state.round !== currentRound) {
        clearInterval(this.timer);
        this.timer = null;
        return;
      }

      const remainingMs = endsAt - Date.now();
      const remainingSec = Math.ceil(remainingMs / 1000);

      if (onTick && (remainingSec === 60 || remainingSec === 30 || remainingSec === 10)) {
        onTick(remainingSec);
      }

      if (remainingMs <= 0) {
        clearInterval(this.timer);
        this.timer = null;
        if (onExpire) {
          onExpire();
        }
      }
    }, 1000);

    return {
      gameState: db.getGameState(),
      durationSeconds,
      endsAt
    };
  }

  // 結算當前分期
  static settleRound() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const state = db.getGameState();
    const round = state.round;
    const teams = db.getTeams();

    const teamSummaries = [];

    // 計算每隊資產
    for (const [teamId, team] of Object.entries(teams)) {
      const overview = TeamService.getPortfolioOverview(teamId, round);
      teamSummaries.push({
        teamId,
        teamName: team.name,
        channelId: team.channelId,
        cash: overview.cash,
        stockValue: overview.totalStockValue,
        totalAsset: overview.totalAsset,
        holdings: overview.holdings
      });
    }

    // 依總資產降序排序
    teamSummaries.sort((a, b) => b.totalAsset - a.totalAsset);

    // 計算名次 (處理同分同名次情況)
    let currentRank = 1;
    for (let i = 0; i < teamSummaries.length; i++) {
      if (i > 0 && teamSummaries[i].totalAsset < teamSummaries[i - 1].totalAsset) {
        currentRank = i + 1;
      }
      teamSummaries[i].rank = currentRank;

      // 更新隊伍本期紀錄
      const team = teams[teamSummaries[i].teamId];
      const history = [...(team.history || [])];
      history.push({
        round,
        cash: teamSummaries[i].cash,
        stockValue: teamSummaries[i].stockValue,
        totalAsset: teamSummaries[i].totalAsset,
        rank: currentRank,
        settledAt: Date.now()
      });
      db.updateTeam(teamSummaries[i].teamId, { history });
    }

    // 儲存結算歷史
    const settlementData = {
      round,
      timestamp: Date.now(),
      totalTeams: teamSummaries.length,
      rankings: teamSummaries
    };
    db.saveSettlement(round, settlementData);

    const isLastRound = round >= TOTAL_ROUNDS;
    db.updateGameState({
      stage: isLastRound ? 'ENDED' : 'SETTLED',
      tradingEndsAt: null,
      round: isLastRound ? round : round + 1
    });

    return {
      round,
      isLastRound,
      settlementData,
      nextRound: isLastRound ? null : round + 1
    };
  }
}
