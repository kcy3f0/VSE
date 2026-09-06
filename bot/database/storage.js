import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_INITIAL_CASH } from '../config/marketData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'gamestate.json');

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

class Storage {
  constructor() {
    this.data = JSON.parse(JSON.stringify(defaultState));
    this.init();
  }

  init() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        this.data = JSON.parse(raw);
        console.log('[Storage] 成功自本地載入遊戲狀態檔。');
      } catch (err) {
        console.error('[Storage] 載入資料庫失敗，使用預設值：', err);
        this.save();
      }
    } else {
      this.save();
      console.log('[Storage] 已建立全新遊戲狀態檔。');
    }
  }

  save() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Storage] 存檔失敗：', err);
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

  updateTeam(teamId, updates) {
    if (this.data.teams[teamId]) {
      this.data.teams[teamId] = { ...this.data.teams[teamId], ...updates };
      this.save();
      return this.data.teams[teamId];
    }
    return null;
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
