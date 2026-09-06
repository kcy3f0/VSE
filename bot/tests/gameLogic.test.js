import assert from 'assert';
import { db } from '../database/storage.js';
import { STOCKS } from '../config/marketData.js';
import { HINTS } from '../config/hintsData.js';
import { TeamService } from '../services/teamService.js';
import { GameEngine } from '../services/gameEngine.js';

console.log('=== 開始測試 2026 迎新股市模擬核心邏輯 ===');

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

// 3. 測試小隊建立與重設
console.log('[Test 3] 測試遊戲重設與小隊註冊...');
db.reset(100000);
const teamA = TeamService.bindTeamChannel('team_1', '第 1 小隊', 'channel_101');
const teamB = TeamService.bindTeamChannel('team_2', '第 2 小隊', 'channel_102');
assert.strictEqual(teamA.cash, 100000);
assert.strictEqual(teamB.cash, 100000);
console.log('  -> 小隊註冊與初始資金測試通過！');

// 4. 測試關主發放資金與提示
console.log('[Test 4] 測試關主獎勵機制...');
TeamService.addCash('team_1', 20000, '解題第一名加碼');
assert.strictEqual(db.getTeam('team_1').cash, 120000);

const hintResult1 = TeamService.unlockHint('team_1', 1, 'T');
assert.strictEqual(hintResult1.alreadyHad, false);
assert.strictEqual(TeamService.getUnlockedHints('team_1').length, 1);

const hintResultRepeat = TeamService.unlockHint('team_1', 1, 'T');
assert.strictEqual(hintResultRepeat.alreadyHad, true);
console.log('  -> 資金與提示發放及防重複測試通過！');

// 5. 測試交易限制（非交易階段禁止交易）
console.log('[Test 5] 測試非交易階段限制...');
GameEngine.startQuizStage(1);
assert.throws(() => {
  GameEngine.executeTrade('team_1', 'BUY', 'T', 10);
}, /目前非投資交易階段/);
console.log('  -> 非交易時間防護測試通過！');

// 6. 測試第一期交易買入與資產計算
console.log('[Test 6] 測試第一期交易買賣...');
GameEngine.startTradingStage(300);
// 第一期 T 公司股價 446.00
// 買入 50 股，需花費 50 * 446 = 22,300
// 原現金 120,000，扣除後應為 97,700
const buyRes = GameEngine.executeTrade('team_1', 'BUY', 'T', 50);
assert.strictEqual(buyRes.totalCost, 22300);
assert.strictEqual(buyRes.newCash, 97700);
assert.strictEqual(buyRes.newHolding, 50);

// 測試賣出部分持股 10 股，現值 10 * 446 = 4,460，現金變 102,160，持股變 40
const sellRes = GameEngine.executeTrade('team_1', 'SELL', 'T', 10);
assert.strictEqual(sellRes.totalCost, 4460);
assert.strictEqual(sellRes.newCash, 102160);
assert.strictEqual(sellRes.newHolding, 40);

// 隊伍 B 買入 J 公司 100 股（股價 33.60，成本 3360）
GameEngine.executeTrade('team_2', 'BUY', 'J', 100);
console.log('  -> 買賣撮合與零股計算測試通過！');

// 7. 測試第一期結算
console.log('[Test 7] 測試第一期結算與排名...');
const settleR1 = GameEngine.settleRound();
assert.strictEqual(settleR1.round, 1);
const r1TeamA = settleR1.settlementData.rankings.find(r => r.teamId === 'team_1');
const r1TeamB = settleR1.settlementData.rankings.find(r => r.teamId === 'team_2');
// Team A 總資產: 102160 (現金) + 40 * 446 (17840) = 120,000 (第一名)
// Team B 總資產: 100,000 (第二名)
assert.strictEqual(r1TeamA.totalAsset, 120000);
assert.strictEqual(r1TeamA.rank, 1);
assert.strictEqual(r1TeamB.rank, 2);
console.log('  -> 第一期結算與排名運算測試通過！');

// 8. 測試第四期 J 公司下市處理
console.log('[Test 8] 測試第四期下市歸零與交易防護...');
// 將回合快轉至第 4 期
db.updateGameState({ round: 4, stage: 'TRADING' });
// 測試第 4 期禁止買入 J 公司
assert.throws(() => {
  GameEngine.executeTrade('team_1', 'BUY', 'J', 10);
}, /已下市/);

// 檢查隊伍 B 的資產（持有 100 股 J 公司）
// 在第 4 期 J 公司股價為 0，持股市值應為 0
const overviewB = TeamService.getPortfolioOverview('team_2', 4);
const jHolding = overviewB.holdings.find(h => h.stockId === 'J');
assert.strictEqual(jHolding.currentPrice, 0);
assert.strictEqual(jHolding.totalValue, 0);
console.log('  -> 第四期 J 公司下市防買與殘值歸零測試通過！');

console.log('=== 所有核心遊戲邏輯單元測試全數通過！ ===\n');
