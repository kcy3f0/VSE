import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_INITIAL_CASH } from '../config/marketData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'gamestate.json');
const TMP_FILE = path.join(DATA_DIR, 'gamestate.json.tmp');
const BAK_FILE = path.join(DATA_DIR, 'gamestate.json.bak');

// 初始預設狀態
const defaultState = {
  gameState: {
    round: 1, // 1 ~ 4
    stage: 'SETUP', // 'SETUP', 'QUIZ', 'TRADING', 'SETTLED', 'ENDED'
    tradingEndsAt: null,
    initialCash: DEFAULT_INITIAL_CASH
  },
  teams: {}, // teamId -> { id, name, channelId, cash, portfolio: {}, unlockedHints: [], transactions: [], history: [] }
  settlementHistory: {} // round -> { timestamp, rankings: [{ teamId, rank, cash, stockValue, totalAsset }] }
};

export class Storage {
  constructor(customDbPath = null) {
    this.dbFile = customDbPath || process.env.VSE_DB_PATH || DB_FILE;
    this.dataDir = path.dirname(this.dbFile);
    this.tmpFile = `${this.dbFile}.tmp`;
    this.bakFile = `${this.dbFile}.bak`;
    this.data = JSON.parse(JSON.stringify(defaultState));
    this.init();
  }

  validateAndSanitizeData(data) {
    if (!data || typeof data !== 'object') return false;
    if (!data.gameState || typeof data.gameState !== 'object') {
      data.gameState = { ...defaultState.gameState };
    } else {
      data.gameState = { ...defaultState.gameState, ...data.gameState };
    }
    if (!data.teams || typeof data.teams !== 'object') {
      data.teams = {};
    }
    if (!data.settlementHistory || typeof data.settlementHistory !== 'object') {
      data.settlementHistory = {};
    }
    return true;
  }

  init() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    let loaded = false;

    // 嘗試從主要資料庫檔案載入
    if (fs.existsSync(this.dbFile)) {
      try {
        const raw = fs.readFileSync(this.dbFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (this.validateAndSanitizeData(parsed)) {
          this.data = parsed;
          console.log(`[Storage] 成功自 ${this.dbFile} 載入遊戲狀態檔。`);
          loaded = true;
        } else {
          console.warn('[Storage] 資料庫結構不符，嘗試自備份檔還原。');
        }
      } catch (err) {
        console.error('[Storage] 主要資料庫損毀或解析失敗：', err.message);
      }
    }

    // 若主檔損毀，嘗試從備份檔還原
    if (!loaded && fs.existsSync(this.bakFile)) {
      try {
        const rawBak = fs.readFileSync(this.bakFile, 'utf-8');
        const parsedBak = JSON.parse(rawBak);
        if (this.validateAndSanitizeData(parsedBak)) {
          this.data = parsedBak;
          console.log(`[Storage] 成功自備份檔 (${this.bakFile}) 還原遊戲狀態！`);
          loaded = true;
          this.save();
        }
      } catch (bakErr) {
        console.error('[Storage] 備份檔亦無法讀取：', bakErr.message);
      }
    }

    if (!loaded) {
      this.data = JSON.parse(JSON.stringify(defaultState));
      this.save();
      console.log('[Storage] 已建立全新遊戲狀態檔。');
    }
  }

  // 原子化寫入 (Atomic Write)：寫入臨時檔案 -> 備份現有主檔 -> 替換主檔
  save() {
    try {
      const content = JSON.stringify(this.data, null, 2);
      fs.writeFileSync(this.tmpFile, content, 'utf-8');

      if (fs.existsSync(this.dbFile)) {
        try {
          fs.copyFileSync(this.dbFile, this.bakFile);
        } catch (copyErr) {
          console.warn('[Storage] 備份檔案建立失敗：', copyErr.message);
        }
      }

      try {
        fs.renameSync(this.tmpFile, this.dbFile);
      } catch (renameErr) {
        // Windows 上跨檔案或高頻讀寫時可能短暫拋出 EPERM / EBUSY / EACCES
        if (['EPERM', 'EBUSY', 'EACCES'].includes(renameErr.code)) {
          fs.copyFileSync(this.tmpFile, this.dbFile);
          try {
            fs.unlinkSync(this.tmpFile);
          } catch (_) {}
        } else {
          throw renameErr;
        }
      }
    } catch (err) {
      console.error('[Storage] 原子存檔失敗：', err);
      throw err;
    }
  }

  // 重設遊戲狀態
  reset(initialCash = DEFAULT_INITIAL_CASH) {
    this.data = {
      gameState: {
        round: 1,
        stage: 'SETUP',
        tradingEndsAt: null,
        initialCash
      },
      teams: {},
      settlementHistory: {}
    };
    this.save();
    return this.data;
  }

  getGameState() {
    return this.data.gameState;
  }

  updateGameState(updates) {
    this.data.gameState = { ...this.data.gameState, ...updates };
    this.save();
    return this.data.gameState;
  }

  getTeams() {
    return this.data.teams;
  }

  getTeam(teamId) {
    return this.data.teams[teamId] || null;
  }

  getTeamByChannel(channelId) {
    return Object.values(this.data.teams).find(t => t.channelId === channelId) || null;
  }

  registerTeam(teamId, name, channelId) {
    if (!this.data.teams[teamId]) {
      this.data.teams[teamId] = {
        id: teamId,
        name: name || teamId,
        channelId: channelId || null,
        cash: this.data.gameState.initialCash,
        portfolio: {},
        unlockedHints: [],
        transactions: [],
        history: []
      };
    } else {
      if (name) this.data.teams[teamId].name = name;
      if (channelId) this.data.teams[teamId].channelId = channelId;
    }
    this.save();
    return this.data.teams[teamId];
  }

  updateTeam(teamId, updates, autoSave = true) {
    if (this.data.teams[teamId]) {
      this.data.teams[teamId] = { ...this.data.teams[teamId], ...updates };
      if (autoSave) this.save();
      return this.data.teams[teamId];
    }
    return null;
  }

  batchUpdateTeams(updaterFn) {
    if (typeof updaterFn === 'function') {
      updaterFn(this.data.teams);
      this.save();
    }
  }

  saveSettlement(round, settlementData) {
    this.data.settlementHistory[round] = settlementData;
    this.save();
  }

  getSettlement(round) {
    return this.data.settlementHistory[round] || null;
  }
}

export const db = new Storage();
