// 股市模擬遊戲市場與公司設定
export const STOCKS = {
  T: {
    id: 'T',
    name: '台積電 (T公司)',
    shortName: '台積電',
    sector: '半導體',
    prices: {
      1: 446.00,
      2: 590.00,
      3: 1070.00,
      4: 1555.00
    },
    delistedInRound: null
  },
  M: {
    id: 'M',
    name: '旺宏 (M公司)',
    shortName: '旺宏',
    sector: '半導體',
    prices: {
      1: 33.55,
      2: 31.50,
      3: 19.65,
      4: 40.00
    },
    delistedInRound: null
  },
  F: {
    id: 'F',
    name: '富邦科技 (F公司)',
    shortName: '富邦科技',
    sector: 'ETF',
    prices: {
      1: 92.00,
      2: 129.40,
      3: 194.35,
      4: 38.09
    },
    delistedInRound: null
  },
  B: {
    id: 'B',
    name: '八方雲集 (B公司)',
    shortName: '八方雲集',
    sector: '觀光餐旅',
    prices: {
      1: 226.00,
      2: 170.50,
      3: 148.00,
      4: 191.00
    },
    delistedInRound: null
  },
  S: {
    id: 'S',
    name: '台鹽 (S公司)',
    shortName: '台鹽',
    sector: '食品',
    prices: {
      1: 32.40,
      2: 34.45,
      3: 32.45,
      4: 31.70
    },
    delistedInRound: null
  },
  D: {
    id: 'D',
    name: '東聯 (D公司)',
    shortName: '東聯',
    sector: '化學',
    prices: {
      1: 18.75,
      2: 20.20,
      3: 14.20,
      4: 12.45
    },
    delistedInRound: null
  },
  O: {
    id: 'O',
    name: '一零四 (O公司)',
    shortName: '一零四',
    sector: '數位雲端',
    prices: {
      1: 205.50,
      2: 212.00,
      3: 220.00,
      4: 224.50
    },
    delistedInRound: null
  },
  J: {
    id: 'J',
    name: '京城銀行 (J公司)',
    shortName: '京城銀行',
    sector: '金融保險',
    prices: {
      1: 33.60,
      2: 39.90,
      3: 50.60,
      4: 0.00 // 第四期已下市，殘值歸零
    },
    delistedInRound: 4
  }
};

export const TOTAL_ROUNDS = 4;
export const DEFAULT_INITIAL_CASH = 100000;
export const DEFAULT_TRADING_DURATION_SECONDS = 300; // 5 分鐘
