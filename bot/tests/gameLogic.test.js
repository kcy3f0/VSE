import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../database/storage.js';
import { STOCKS } from '../config/marketData.js';
import { HINTS } from '../config/hintsData.js';
import { TeamService } from '../services/teamService.js';
import { GameEngine } from '../services/gameEngine.js';
import { sanitizeText } from '../utils/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'gamestate.json');
const BAK_FILE = path.join(DATA_DIR, 'gamestate.json.bak');

console.log('=== 開始測試 2026 迎新股市模擬核心邏輯 (含 C1~C5, H1~H5 邊界防護) ===');

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

// 4. 測試資金發放、負數扣款校正 (C1) 與 餘額防呆 (H2)
console.log('[Test 4] 測試關主資金發放、負數校正 (C1) 與防呆 (H2)...');
// 正數發放
TeamService.addCash('team_1', 20000, '解題第一名加碼');
assert.strictEqual(db.getTeam('team_1').cash, 120000);

// 負數扣款校正 (C1)
TeamService.addCash('team_1', -5000, '校正多發金額');
assert.strictEqual(db.getTeam('team_1').cash, 115000);

// 負數超額扣款防呆 (H2: 餘額不足以扣除時應拋出錯誤，不可靜默歸零)
assert.throws(() => {
  TeamService.addCash('team_1', -200000, '誤輸入大額扣款');
}, /扣款失敗/);
assert.strictEqual(db.getTeam('team_1').cash, 115000); // 確認金額未被清空
console.log('  -> 資金發放、負數扣款及餘額防呆測試通過！');

// 5. 測試階段防護與提示限制 (H4)
console.log('[Test 5] 測試非 QUIZ 階段禁止發放情報 (H4)...');
// 當前階段為 SETUP，發放提示應被阻絕
assert.throws(() => {
  TeamService.unlockHint('team_1', 1, 'T');
}, /僅能在「闖關解題階段/);

// 切換至 QUIZ 階段
GameEngine.startQuizStage(1);
const hintResult1 = TeamService.unlockHint('team_1', 1, 'T');
assert.strictEqual(hintResult1.alreadyHad, false);
assert.strictEqual(TeamService.getUnlockedHints('team_1').length, 1);

// 重複領取提示防護
const hintResultRepeat = TeamService.unlockHint('team_1', 1, 'T');
assert.strictEqual(hintResultRepeat.alreadyHad, true);

// QUIZ 階段禁止下單
assert.throws(() => {
  GameEngine.executeTrade('team_1', 'BUY', 'T', 10);
}, /目前非投資交易階段/);
console.log('  -> 階段限制與情報領取防護測試通過！');

// 6. 測試交易買賣與資產撮合
console.log('[Test 6] 測試第一期交易買賣撮合...');
GameEngine.startTradingStage(300);
// 第一期 T 公司股價 446.00
// 買入 50 股，需花費 50 * 446 = 22,300
// 原現金 115,000，扣除後應為 92,700
const buyRes = GameEngine.executeTrade('team_1', 'BUY', 'T', 50);
assert.strictEqual(buyRes.totalCost, 22300);
assert.strictEqual(buyRes.newCash, 92700);
assert.strictEqual(buyRes.newHolding, 50);

// 賣出部分持股 10 股，現值 10 * 446 = 4,460，現金變 97,160，持股變 40
const sellRes = GameEngine.executeTrade('team_1', 'SELL', 'T', 10);
assert.strictEqual(sellRes.totalCost, 4460);
assert.strictEqual(sellRes.newCash, 97160);
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
// Team A 總資產: 97160 (現金) + 40 * 446 (17840) = 115,000 (第一名)
// Team B 總資產: 100,000 (第二名)
assert.strictEqual(r1TeamA.totalAsset, 115000);
assert.strictEqual(r1TeamA.rank, 1);
assert.strictEqual(r1TeamB.rank, 2);
console.log('  -> 第一期結算與排名運算測試通過！');

// 8. 測試第四期 J 公司下市全面禁止買賣 (H1)
console.log('[Test 8] 測試第四期下市股票買賣全面阻斷 (H1)...');
db.updateGameState({ round: 4, stage: 'TRADING', tradingEndsAt: Date.now() + 300000 });

// 第 4 期禁止買入 J 公司
assert.throws(() => {
  GameEngine.executeTrade('team_1', 'BUY', 'J', 10);
}, /已下市.*無法進行任何買賣/);

// 第 4 期禁止賣出 J 公司 (解決 H1)
assert.throws(() => {
  GameEngine.executeTrade('team_2', 'SELL', 'J', 10);
}, /已下市.*無法進行任何買賣/);

// 檢查隊伍 B 的資產（持有 100 股 J 公司）殘值歸零
const overviewB = TeamService.getPortfolioOverview('team_2', 4);
const jHolding = overviewB.holdings.find(h => h.stockId === 'J');
assert.strictEqual(jHolding.currentPrice, 0);
assert.strictEqual(jHolding.totalValue, 0);
console.log('  -> 第四期 J 公司下市買賣全禁與殘值歸零測試通過！');

// 9. 測試交易時間截止後的下單阻斷 (C5)
console.log('[Test 9] 測試交易截止時間防護 (C5)...');
// 將交易截止時間設在過去
db.updateGameState({ round: 4, stage: 'TRADING', tradingEndsAt: Date.now() - 1000 });
assert.throws(() => {
  GameEngine.executeTrade('team_1', 'BUY', 'T', 10);
}, /交易時間已截止/);
console.log('  -> 交易截止逾時阻斷測試通過！');

// 10. 測試輸入消毒與 Mention 防注入 (H5)
console.log('[Test 10] 測試文字消毒與 Mention 防注入 (H5)...');
const maliciousInput = '@everyone 恭喜中獎！請點擊 <@&12345678> 領取 @here';
const sanitized = sanitizeText(maliciousInput);
assert.strictEqual(sanitized.includes('@everyone'), false);
assert.strictEqual(sanitized.includes('@here'), false);
assert.strictEqual(sanitized.includes('<@&'), false);
assert.ok(sanitized.includes('@\u200Beveryone'));
assert.ok(sanitized.includes('@\u200Bhere'));
console.log('  -> 輸入消毒與防注入測試通過！');

// 11. 測試原子存檔與備份檔案生成 (C2)
console.log('[Test 11] 測試 JSON 原子寫入與備份生成 (C2)...');
db.save();
assert.ok(fs.existsSync(DB_FILE), 'gamestate.json 應存在');
assert.ok(fs.existsSync(BAK_FILE), 'gamestate.json.bak 備份檔應存在');
const rawDb = fs.readFileSync(DB_FILE, 'utf-8');
const parsed = JSON.parse(rawDb);
assert.strictEqual(typeof parsed.gameState, 'object');
console.log('  -> 原子存檔與自動備份測試通過！');

console.log('\n=== 所有核心遊戲邏輯與安全性防護測試全數通過！ ===\n');
