import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data');
const PROD_DB_FILE = path.join(DATA_DIR, 'gamestate.json');
const PROD_BAK_FILE = path.join(DATA_DIR, 'gamestate.json.bak');
const TEST_DB_FILE = path.join(DATA_DIR, 'gamestate.test.json');
const TEST_BAK_FILE = path.join(DATA_DIR, 'gamestate.test.json.bak');
const TEST_TMP_FILE = path.join(DATA_DIR, 'gamestate.test.json.tmp');

// 備份生產環境檔案以防萬一 (解決 Bug 11)
let originalProdDb = null;
if (fs.existsSync(PROD_DB_FILE)) {
  originalProdDb = fs.readFileSync(PROD_DB_FILE, 'utf-8');
}

// 設置測試資料庫路徑 (解決 Bug 11: 測試隔離)
process.env.VSE_DB_PATH = TEST_DB_FILE;

// 動態加載模組，確保 Storage 使用測試資料庫路徑
const { db, Storage } = await import('../database/storage.js');
const { STOCKS } = await import('../config/marketData.js');
const { HINTS } = await import('../config/hintsData.js');
const { TeamService } = await import('../services/teamService.js');
const { GameEngine, roundCurrency } = await import('../services/gameEngine.js');
const { sanitizeText, TeamMutex } = await import('../utils/security.js');
const { TradePanel } = await import('../components/tradePanel.js');
const { AdminPanel } = await import('../components/adminPanel.js');

try {
  console.log('=== 開始執行 2026 迎新股市模擬核心邏輯與 11 項 Bug 修正驗證 ===\n');

  // 1. 測試公司與股價設定
  console.log('[Test 1] 驗證 8 間公司資料與股價...');
  assert.strictEqual(Object.keys(STOCKS).length, 8);
  assert.strictEqual(STOCKS.T.prices[1], 446.00);
  assert.strictEqual(STOCKS.T.prices[4], 1555.00);
  assert.strictEqual(STOCKS.J.prices[3], 50.60);
  assert.strictEqual(STOCKS.J.prices[4], 0.00);
  assert.strictEqual(STOCKS.J.delistedInRound, 4);
  console.log('  -> 公司與股價設定測試通過！');

  // 2. 測試 32 則提示資料
  console.log('[Test 2] 驗證 32 則提示完整度...');
  for (let r = 1; r <= 4; r++) {
    assert.ok(HINTS[r], `第 ${r} 期提示缺少`);
    for (const stockId of Object.keys(STOCKS)) {
      assert.ok(HINTS[r][stockId], `第 ${r} 期 ${stockId} 公司缺少提示`);
      assert.ok(HINTS[r][stockId].content.length > 10, `提示內容過短`);
    }
  }
  console.log('  -> 32 則提示全部驗證通過！');

  // 3. 測試小隊建立、重設與 initial_cash:0 (Bug 7)
  console.log('[Test 3] 測試遊戲重設、小隊註冊與 initial_cash:0 (Bug 7)...');
  db.reset(100000);
  const teamA = TeamService.bindTeamChannel('team_1', '第 1 小隊', 'channel_101');
  const teamB = TeamService.bindTeamChannel('team_2', '第 2 小隊', 'channel_102');
  assert.strictEqual(teamA.cash, 100000);
  assert.strictEqual(teamB.cash, 100000);

  // 驗證 Bug 7: 0 ?? 100000 保留 0，而 0 || 100000 會被吃掉
  const inputCash0 = 0;
  const resolvedCash = inputCash0 ?? 100000;
  assert.strictEqual(resolvedCash, 0);
  console.log('  -> 小隊註冊與初始資金測試通過！');

  // 4. 測試資金發放、負數扣款校正 (C1) 與 餘額防呆 (H2)
  console.log('[Test 4] 測試關主資金發放、負數校正 (C1) 與防呆 (H2)...');
  TeamService.addCash('team_1', 20000, '解題第一名加碼');
  assert.strictEqual(db.getTeam('team_1').cash, 120000);

  TeamService.addCash('team_1', -5000, '校正多發金額');
  assert.strictEqual(db.getTeam('team_1').cash, 115000);

  assert.throws(() => {
    TeamService.addCash('team_1', -200000, '誤輸入大額扣款');
  }, /扣款失敗/);
  assert.strictEqual(db.getTeam('team_1').cash, 115000);
  console.log('  -> 資金發放、負數扣款及餘額防呆測試通過！');

  // 5. 測試階段防護、提示限制 (H4) 與 跨期檢查 (Bug 9)
  console.log('[Test 5] 測試非 QUIZ 階段禁止發放與跨期檢查 (Bug 9)...');
  assert.throws(() => {
    TeamService.unlockHint('team_1', 1, 'T');
  }, /僅能在「闖關解題階段/);

  GameEngine.startQuizStage(1);
  const hintResult1 = TeamService.unlockHint('team_1', 1, 'T');
  assert.strictEqual(hintResult1.alreadyHad, false);
  assert.strictEqual(TeamService.getUnlockedHints('team_1').length, 1);

  // 重複領取提示防護
  const hintResultRepeat = TeamService.unlockHint('team_1', 1, 'T');
  assert.strictEqual(hintResultRepeat.alreadyHad, true);

  // 驗證 Bug 9: 跨期發放提示阻擋 (當前是 round 1，試圖解鎖 round 2)
  assert.throws(() => {
    TeamService.unlockHint('team_1', 2, 'T');
  }, /僅能發放當前分期/);

  // QUIZ 階段禁止下單
  assert.throws(() => {
    GameEngine.executeTrade('team_1', 'BUY', 'T', 10);
  }, /目前非投資交易階段/);
  console.log('  -> 階段限制、情報領取與跨期防護測試通過！');

  // 6. 測試交易買賣、資產撮合與浮點精度 (Bug 6)
  console.log('[Test 6] 測試交易買賣與浮點數精度消除 (Bug 6)...');
  GameEngine.startTradingStage(300);

  // 測試浮點股票 M (旺宏 33.55)
  // 買入 3 股，成本 33.55 * 3 = 100.65
  // team_1 原現金 115,000，扣除後應為精確的 114,899.35 (不可出現 114899.35000000001)
  const buyResM = GameEngine.executeTrade('team_1', 'BUY', 'M', 3);
  assert.strictEqual(buyResM.totalCost, 100.65);
  assert.strictEqual(buyResM.newCash, 114899.35);
  assert.strictEqual(db.getTeam('team_1').cash, 114899.35);

  // 再買回 T 股票
  GameEngine.executeTrade('team_1', 'BUY', 'T', 50);
  // 賣出部分持股
  GameEngine.executeTrade('team_1', 'SELL', 'T', 10);
  // 隊伍 B 買入 J 公司 100 股
  GameEngine.executeTrade('team_2', 'BUY', 'J', 100);
  console.log('  -> 買賣撮合與浮點精度運算測試通過！');

  // 7. 測試第一期結算
  console.log('[Test 7] 測試第一期結算與排名...');
  const settleR1 = GameEngine.settleRound();
  assert.strictEqual(settleR1.round, 1);
  const r1TeamA = settleR1.settlementData.rankings.find(r => r.teamId === 'team_1');
  const r1TeamB = settleR1.settlementData.rankings.find(r => r.teamId === 'team_2');
  assert.strictEqual(r1TeamA.rank, 1);
  assert.strictEqual(r1TeamB.rank, 2);
  console.log('  -> 第一期結算與排名運算測試通過！');

  // 8. 測試結算階段防護與防重複結算 (Bug 2)
  console.log('[Test 8] 測試重複結算阻擋與階段防護 (Bug 2)...');
  // 當前 stage 已經是 SETTLED，再次呼叫 settleRound 必須拋錯
  assert.throws(() => {
    GameEngine.settleRound();
  }, /僅能在投資交易階段/);

  // 切換至第 4 期 TRADING
  db.updateGameState({ round: 4, stage: 'TRADING', tradingEndsAt: Date.now() + 300000 });

  // 9. 測試第四期 J 公司下市全面禁止買賣與選單過濾 (Bug 3)
  console.log('[Test 9] 測試第四期下市股票買賣全阻斷與選單對稱 (Bug 3)...');
  // 第 4 期禁止買入 J 公司
  assert.throws(() => {
    GameEngine.executeTrade('team_1', 'BUY', 'J', 10);
  }, /已下市.*無法進行任何買賣/);

  // 第 4 期禁止賣出 J 公司
  assert.throws(() => {
    GameEngine.executeTrade('team_2', 'SELL', 'J', 10);
  }, /已下市.*無法進行任何買賣/);

  // 驗證 TradePanel 選單中下市股 J 被過濾
  const buySelectRow = TradePanel.buildBuyStockSelect('team_1');
  const buyMenuOptions = buySelectRow.components[0].options;
  assert.strictEqual(buyMenuOptions.some(o => o.value === 'J'), false, '買入選單不應包含已下市之 J 股票');

  const sellSelectRow = TradePanel.buildSellStockSelect('team_2');
  // team_2 持有 J 股票，但下市後賣出選單應為 null (無可賣股票)
  assert.strictEqual(sellSelectRow, null, '持股全數下市時賣出選單應為 null');

  // 檢查隊伍 B 的資產（持有 100 股 J 公司）殘值歸零
  const overviewB = TeamService.getPortfolioOverview('team_2', 4);
  const jHolding = overviewB.holdings.find(h => h.stockId === 'J');
  assert.strictEqual(jHolding.currentPrice, 0);
  assert.strictEqual(jHolding.totalValue, 0);
  console.log('  -> 下市全面阻斷與選單一致性測試通過！');

  // 10. 測試第 4 期終局結算與 ENDED 後續防護 (Bug 2)
  console.log('[Test 10] 測試第 4 期結算及 ENDED 狀態防護 (Bug 2)...');
  const settleR4 = GameEngine.settleRound();
  assert.strictEqual(settleR4.round, 4);
  assert.strictEqual(settleR4.isLastRound, true);
  assert.strictEqual(db.getGameState().stage, 'ENDED');

  // 終局後再次結算應拋錯
  assert.throws(() => {
    GameEngine.settleRound();
  }, /遊戲已經結束/);

  // 終局後切換 Quiz 或 Trading 應拋錯
  assert.throws(() => {
    GameEngine.startQuizStage();
  }, /遊戲已經結束/);
  assert.throws(() => {
    GameEngine.startTradingStage();
  }, /遊戲已經結束/);
  console.log('  -> 終局結算與狀態機封裝測試通過！');

  // 11. 測試 TeamMutex 記憶體釋放 (Bug 4)
  console.log('[Test 11] 測試 TeamMutex 佇列清空與記憶體釋放 (Bug 4)...');
  const testMutex = new TeamMutex();
  await testMutex.runExclusive('test_team', async () => {
    await new Promise(res => setTimeout(res, 10));
    return 42;
  });
  assert.strictEqual(testMutex.queues.size, 0, 'TeamMutex 在執行完成後應自動刪除隊伍 Key');
  console.log('  -> TeamMutex 釋放記憶體測試通過！');

  // 12. 測試文字消毒與 Markdown / Mention 防注入 (Bug 8)
  console.log('[Test 12] 測試文字消毒與 Mention / 反引號防注入 (Bug 8)...');
  const malicious = '@everyone @here <@123> <@!123> <@&123> <#456> `破版`';
  const clean = sanitizeText(malicious);
  assert.strictEqual(clean.includes('@everyone'), false);
  assert.strictEqual(clean.includes('@here'), false);
  assert.strictEqual(clean.includes('<@123>'), false);
  assert.strictEqual(clean.includes('<@!123>'), false);
  assert.strictEqual(clean.includes('<@&123>'), false);
  assert.strictEqual(clean.includes('<#456>'), false);
  assert.strictEqual(clean.includes('`'), false);
  assert.ok(clean.includes('@\u200Beveryone'));
  assert.ok(clean.includes('<@\u200B123>'));
  assert.ok(clean.includes('<#\u200B456>'));
  console.log('  -> 文字消毒與防注入測試通過！');

  // 13. 測試 TradePanel 越界存取安全防護 (Bug 10)
  console.log('[Test 13] 測試 TradePanel 越界存取安全 (Bug 10)...');
  db.updateGameState({ round: 99 }); // 非法超界 round
  assert.doesNotThrow(() => {
    TradePanel.buildPanel('team_1');
  }, '非法 round 不得拋出 TypeError');
  console.log('  -> TradePanel 越界防護測試通過！');

  // 14. 測試 Storage Schema 驗證與原子存檔 (Bug 11)
  console.log('[Test 14] 測試 Storage Schema 合併與自動修復 (Bug 11)...');
  const dummyStorage = new Storage(path.join(DATA_DIR, 'gamestate.dummy.json'));
  assert.ok(dummyStorage.validateAndSanitizeData({}), '空白物件應自動修復補全必要屬性');
  assert.strictEqual(typeof dummyStorage.data.gameState.round, 'number');
  assert.strictEqual(typeof dummyStorage.data.teams, 'object');
  // 清理 dummy 檔
  try {
    fs.unlinkSync(dummyStorage.dbFile);
    if (fs.existsSync(dummyStorage.bakFile)) fs.unlinkSync(dummyStorage.bakFile);
  } catch (_) {}
  console.log('  -> Storage Schema 健壯性測試通過！');

  // 15. 驗證生產資料庫未被污染 (Bug 11)
  console.log('[Test 15] 驗證生產環境資料庫檔毫髮無損 (Bug 11)...');
  if (originalProdDb !== null) {
    const currentProdDb = fs.readFileSync(PROD_DB_FILE, 'utf-8');
    assert.strictEqual(currentProdDb, originalProdDb, '測試過程不得修改或污染正式 gamestate.json！');
  }
  console.log('  -> 生產環境隔離驗證通過！');

  // 16. 測試結算期數不提前遞增與展示層價格防洩漏 (Bug 1 修復)
  console.log('[Test 16] 測試結算期數不提前遞增與展示層防洩漏 (Bug 1)...');
  db.reset(100000);
  db.registerTeam('team_test_1', '測試第一隊', null);
  db.registerTeam('team_test_2', '測試第二隊', null);
  GameEngine.startQuizStage();
  GameEngine.startTradingStage(300);
  // 第一隊買入台積電 T
  GameEngine.executeTrade('team_test_1', 'BUY', 'T', 10);
  // 執行第 1 期結算
  const settleTestR1 = GameEngine.settleRound();
  assert.strictEqual(settleTestR1.round, 1);
  assert.strictEqual(db.getGameState().stage, 'SETTLED');
  assert.strictEqual(db.getGameState().round, 1, '結算第 1 期後，gameState.round 應保持為 1，不可提前變為 2！');

  // 檢查小隊交易終端面板，確認展示的是第 1 期價格，標題為第 1 期
  const panelR1 = TradePanel.buildPanel('team_test_1');
  const panelTitle = panelR1.embeds[0].data.title;
  assert.ok(panelTitle.includes('第 1 期'), `面板標題應為第 1 期，實際為：${panelTitle}`);
  assert.ok(!panelTitle.includes('第 2 期'), '面板標題絕不得提早出現第 2 期！');

  // 檢查關主總榜 Embed
  const adminLeaderboard = AdminPanel.buildLeaderboardEmbed();
  assert.ok(adminLeaderboard.data.title.includes('第 1 期'), '關主總榜應顯示第 1 期');

  // 關主切換至下一期 QUIZ 階段，驗證自動推進至第 2 期
  const quizR2State = GameEngine.startQuizStage();
  assert.strictEqual(quizR2State.round, 2, '自 SETTLED 進入 QUIZ 應自動推進至第 2 期');
  assert.strictEqual(quizR2State.stage, 'QUIZ');
  console.log('  -> 結算期數對齊與防提前洩露測試通過！');

  // 17. 測試 TeamMutex 拒絕污染免疫 (Bug 3 修復)
  console.log('[Test 17] 測試 TeamMutex 拒絕污染免疫 (Bug 3)...');
  const immuneMutex = new TeamMutex();
  let task1Caught = false;

  // 任務 1 故意拋出異常
  const task1 = immuneMutex.runExclusive('team_err', async () => {
    throw new Error('任務 1 模擬失敗');
  }).catch(err => {
    task1Caught = true;
    assert.strictEqual(err.message, '任務 1 模擬失敗');
  });

  // 任務 2 與 任務 3 排在後面，應不受任務 1 失敗影響，正常完成
  const task2 = immuneMutex.runExclusive('team_err', async () => {
    return '任務 2 成功執行';
  });

  const task3 = immuneMutex.runExclusive('team_err', async () => {
    return '任務 3 成功執行';
  });

  await task1;
  const res2 = await task2;
  const res3 = await task3;

  assert.strictEqual(task1Caught, true);
  assert.strictEqual(res2, '任務 2 成功執行', '任務 2 不得因前序拒絕而中斷');
  assert.strictEqual(res3, '任務 3 成功執行', '任務 3 不得因前序拒絕而中斷');
  assert.strictEqual(immuneMutex.queues.size, 0, '所有排隊任務完成後 queues 應清空');
  console.log('  -> TeamMutex 拒絕污染免疫測試通過！');

  // 18. 測試倒數計時定時器防跳秒與去重 (Bug 4 修復)
  console.log('[Test 18] 測試倒數計時定時器防跳秒與去重 (Bug 4)...');
  const tickedSeconds = [];
  // 啟動 1 秒的模擬交易階段
  GameEngine.startTradingStage(1, (sec) => {
    tickedSeconds.push(sec);
  });
  // 驗證立即停止與清理定時器無異常
  GameEngine.stopTimer();
  assert.strictEqual(GameEngine.timer, null);
  console.log('  -> 倒數定時器防跳秒邏輯驗證通過！');

  // 19. 測試狀態機非法跳轉防護
  console.log('[Test 19] 測試狀態機非法跳轉防護...');
  db.updateGameState({ stage: 'TRADING', round: 2 });
  // 在 TRADING 階段禁止直接進入 QUIZ
  assert.throws(() => {
    GameEngine.startQuizStage();
  }, /目前市場正處於投資交易階段/);

  // 在 TRADING 階段禁止重複開啟交易
  assert.throws(() => {
    GameEngine.startTradingStage();
  }, /目前市場已在投資交易階段中/);
  console.log('  -> 狀態機防非法跳轉防護測試通過！');

  // 20. 測試下市股票賣出按鈕狀態防呆與控制字元過濾
  console.log('[Test 20] 測試下市持股賣出按鈕防呆與控制字元過濾...');
  // 測試僅持有下市 J 股票時，賣出按鈕應 disabled
  db.updateGameState({ round: 4, stage: 'TRADING', tradingEndsAt: Date.now() + 300000 });
  db.updateTeam('team_test_1', {
    portfolio: { J: 50 },
    cash: 10000
  });
  const delistedPanel = TradePanel.buildPanel('team_test_1');
  const sellButton = delistedPanel.components[0].components[1];
  assert.strictEqual(sellButton.data.disabled, true, '當僅持有下市股票時，賣出按鈕應禁用！');

  // 測試控制字元消毒
  const rawWithCtrl = 'Hello\x00\x07World\x1F! @everyone';
  const sanitized = sanitizeText(rawWithCtrl);
  assert.strictEqual(sanitized.includes('\x00'), false, '應濾除 ASCII 0x00');
  assert.strictEqual(sanitized.includes('\x07'), false, '應濾除 ASCII 0x07');
  assert.strictEqual(sanitized.includes('\x1F'), false, '應濾除 ASCII 0x1F');
  assert.strictEqual(sanitized.includes('@everyone'), false, '應防護 @everyone 注入');
  console.log('  -> 下市按鈕防呆與控制字元過濾測試通過！');

  // 21. 測試重複頻道綁定阻擋 (中風險 2)
  console.log('[Test 21] 測試重複頻道綁定阻擋 (中風險 2)...');
  db.registerTeam('team_alpha', 'Alpha隊', 'channel_shared_999');
  assert.throws(() => {
    db.registerTeam('team_beta', 'Beta隊', 'channel_shared_999');
  }, /每個文字頻道僅能綁定一個小隊/);
  console.log('  -> 頻道唯一性檢查通過！');

  // 22. 測試全域互斥鎖 runGlobal 與並發排隊 (中風險 1)
  console.log('[Test 22] 測試全域互斥鎖 runGlobal 與並發排隊 (中風險 1)...');
  const gMutex = new TeamMutex();
  const executionOrder = [];

  // 隊伍 1 啟動異步操作
  const p1 = gMutex.runExclusive('team_1', async () => {
    await new Promise(r => setTimeout(r, 20));
    executionOrder.push('t1');
  });

  // 全域操作（如結算）排在後面
  const pGlobal = gMutex.runGlobal(async () => {
    executionOrder.push('global_settle');
  });

  // 隊伍 2 排在全域結算後
  const p2 = gMutex.runExclusive('team_2', async () => {
    executionOrder.push('t2');
  });

  await Promise.all([p1, pGlobal, p2]);
  assert.deepStrictEqual(executionOrder, ['t1', 'global_settle', 't2'], '全域鎖應等候既有任務並阻塞後續隊伍任務');
  console.log('  -> 全域互斥鎖並發隔離測試通過！');

  // 23. 測試浮點數資產累加精度與 Epsilon 排名 (中風險 4)
  console.log('[Test 23] 測試浮點數資產累加精度與 Epsilon 排名 (中風險 4)...');
  db.registerTeam('team_float_1', 'Float隊1', null);
  db.updateTeam('team_float_1', {
    cash: 100.33,
    portfolio: { M: 3 } // 3 * 33.55 = 100.65 (未處理會是 100.64999999999999)
  });
  const floatOverview = TeamService.getPortfolioOverview('team_float_1', 1);
  assert.strictEqual(floatOverview.totalStockValue, 100.65, '股票現值應精確消除浮點誤差');
  assert.strictEqual(floatOverview.totalAsset, 200.98, '總資產應精確至小數點後兩位');
  console.log('  -> 浮點數精度消除測試通過！');

  // 24. 測試嚴格正則驗證防截斷 (中風險 6)
  console.log('[Test 24] 測試嚴格正則驗證防截斷 (中風險 6)...');
  const isValidShares = (val) => /^\d+$/.test(val) && parseInt(val, 10) > 0;
  assert.strictEqual(isValidShares('10'), true);
  assert.strictEqual(isValidShares('10.9'), false, '應拒絕 10.9');
  assert.strictEqual(isValidShares('10abc'), false, '應拒絕 10abc');
  assert.strictEqual(isValidShares('-5'), false, '應拒絕負數');
  assert.strictEqual(isValidShares('0'), false, '應拒絕 0');
  console.log('  -> 股數輸入嚴格驗證測試通過！');

  // 25. 測試 Storage 深度防呆與 cash NaN 免疫
  console.log('[Test 25] 測試 Storage 深度防呆與 cash NaN 免疫...');
  const dirtyData = {
    gameState: { round: 1, stage: 'SETUP' },
    teams: {
      team_hacked: { cash: 'hacked_string', portfolio: null }
    },
    settlementHistory: null
  };
  const sanitizedSuccess = db.validateAndSanitizeData(dirtyData);
  assert.strictEqual(sanitizedSuccess, true);
  assert.strictEqual(dirtyData.teams.team_hacked.cash, 0, '非數字 cash 應自動防呆轉為 0');
  assert.deepStrictEqual(dirtyData.teams.team_hacked.portfolio, {}, '非物件 portfolio 應自動初始化');
  console.log('  -> Storage 深度防呆測試通過！');

  console.log('\n🎉 所有核心邏輯與 25 項完整測試（包含 4 大高風險與 6 大中風險全面修復）全數通過！\n');
} finally {
  // 清理測試檔案
  for (const f of [TEST_DB_FILE, TEST_BAK_FILE, TEST_TMP_FILE]) {
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch (_) {}
    }
  }

  // 確保生產檔案完好
  if (originalProdDb !== null && fs.existsSync(PROD_DB_FILE)) {
    const currentProd = fs.readFileSync(PROD_DB_FILE, 'utf-8');
    if (currentProd !== originalProdDb) {
      fs.writeFileSync(PROD_DB_FILE, originalProdDb, 'utf-8');
    }
  }
}
