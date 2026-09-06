import { db } from '../database/storage.js';
import { STOCKS, TOTAL_ROUNDS, DEFAULT_TRADING_DURATION_SECONDS } from '../config/marketData.js';
import { TeamService } from './teamService.js';

export function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export class GameEngine {
  static timer = null;

  static stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // 執行小隊買賣交易 (嚴格原子校驗)
  static executeTrade(teamId, type, stockId, shares) {
    const gameState = db.getGameState();

    // 檢查是否為投資交易時間
    if (gameState.stage !== 'TRADING') {
      throw new Error('【非交易時間】目前非投資交易階段，市場已休市！');
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

    const totalCost = roundCurrency(currentPrice * shares);
    const portfolio = { ...(team.portfolio || {}) };
    const currentHolding = portfolio[stockId] || 0;

    let newCash = team.cash;
    let newHolding = currentHolding;

    if (type === 'BUY') {
      if (team.cash < totalCost) {
        throw new Error(`【現金不足】購買 ${shares} 股 ${stock.name} 需要 $${totalCost.toLocaleString()}，您目前現金僅有 $${team.cash.toLocaleString()}。`);
      }
      newCash = roundCurrency(team.cash - totalCost);
      newHolding = currentHolding + shares;
      portfolio[stockId] = newHolding;
    } else if (type === 'SELL') {
      if (currentHolding < shares) {
        throw new Error(`【庫存不足】您目前僅持有 ${currentHolding} 股 ${stock.name}，無法賣出 ${shares} 股！`);
      }
      newCash = roundCurrency(team.cash + totalCost);
      newHolding = currentHolding - shares;
      if (newHolding === 0) {
        delete portfolio[stockId];
      } else {
        portfolio[stockId] = newHolding;
      }
    } else {
      throw new Error(`未知的交易類型：${type}`);
    }

    // 建立交易紀錄
    const tx = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      round,
      type,
      stockId,
      stockName: stock.name,
      shares,
      price: currentPrice,
      totalCost,
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
    if (currentState.stage === 'ENDED') {
      throw new Error('【狀態錯誤】遊戲已經結束，無法再切換至闖關解題階段！');
    }
    if (currentState.stage === 'TRADING') {
      throw new Error('【狀態錯誤】目前市場正處於投資交易階段，請先結算或暫停市場後再切換至解題闖關階段！');
    }

    let targetRound = round ?? currentState.round;
    // 若從上一期結算 (SETTLED) 推進且未手動指定期數，自動推進至下一期
    if (currentState.stage === 'SETTLED' && round === null) {
      targetRound = currentState.round + 1;
    }

    if (targetRound > TOTAL_ROUNDS) {
      throw new Error(`遊戲總共只有 ${TOTAL_ROUNDS} 期，請進行終局結算。`);
    }

    this.stopTimer();

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
    if (currentState.stage === 'ENDED') {
      throw new Error('【狀態錯誤】遊戲已經結束，無法再開啟投資交易！');
    }
    if (currentState.stage === 'TRADING') {
      throw new Error('【狀態錯誤】目前市場已在投資交易階段中，請勿重複開啟！');
    }

    let currentRound = currentState.round;
    // 若關主自 SETTLED 未經 QUIZ 直接開啟交易，自動進入下一期
    if (currentState.stage === 'SETTLED') {
      currentRound = currentState.round + 1;
    }

    if (currentRound > TOTAL_ROUNDS) {
      throw new Error('所有回合已完成！');
    }

    this.stopTimer();

    const endsAt = Date.now() + durationSeconds * 1000;
    db.updateGameState({
      round: currentRound,
      stage: 'TRADING',
      tradingEndsAt: endsAt
    });

    // 啟動倒數檢查器 (使用 Set 與閾值判定，杜絕 setInterval 飄移跳過提醒)
    const notifiedTicks = new Set();
    const checkpoints = [60, 30, 10];

    this.timer = setInterval(() => {
      const state = db.getGameState();
      // 若已非交易階段或回合已被切換，立即終止計時器
      if (state.stage !== 'TRADING' || state.round !== currentRound) {
        this.stopTimer();
        return;
      }

      const remainingMs = endsAt - Date.now();
      const remainingSec = Math.max(0, Math.floor(remainingMs / 1000));

      if (onTick) {
        for (const cp of checkpoints) {
          if (remainingSec <= cp && !notifiedTicks.has(cp)) {
            notifiedTicks.add(cp);
            onTick(cp);
          }
        }
      }

      if (remainingMs <= 0) {
        this.stopTimer();
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
    this.stopTimer();

    const state = db.getGameState();
    if (state.stage === 'ENDED') {
      throw new Error('【結算失敗】遊戲已經結束，無法重複進行終局結算！');
    }
    if (state.stage !== 'TRADING') {
      throw new Error(`【結算失敗】當前階段為「${state.stage}」，僅能在投資交易階段 (TRADING) 進行結算！`);
    }

    const round = state.round;
    if (db.getSettlement(round)) {
      throw new Error(`【結算失敗】第 ${round} 期已經完成結算，請勿重複結算！`);
    }

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

      // 更新隊伍本期紀錄 (autoSave = false 批次優化，避免連續 I/O 爆發)
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
      db.updateTeam(teamSummaries[i].teamId, { history }, false);
    }

    // 儲存結算歷史 (會原子存檔一次，同步持久化上方更新之隊伍歷史)
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
      round // 維持當前結算期數，待切換下一期解題或交易時再 +1，杜絕下一期股價提前洩露
    });

    return {
      round,
      isLastRound,
      settlementData,
      nextRound: isLastRound ? null : round + 1
    };
  }
}
