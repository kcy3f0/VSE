import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { 
  getFirestore, doc, setDoc, collection, onSnapshot, updateDoc, deleteDoc, writeBatch, addDoc, query, orderBy, limit, getDocs
} from 'firebase/firestore';



const firebaseConfig = {
apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

const rawAppId = typeof __app_id !== 'undefined' ? __app_id : 'camp-investment-game';
const appId = rawAppId.replace(/\//g, '_');

if (typeof document !== 'undefined') {
  if (!document.getElementById('tailwind-config')) {
    const s = document.createElement('script'); s.id = 'tailwind-config';
    s.innerHTML = `tailwind.config = { 
      theme: {
        extend: {
          fontFamily: {
            sans: ['"Noto Sans TC"', 'sans-serif', 'system-ui']
          }
        }
      }
    }`; 
    document.head.appendChild(s);
  }
  if (!document.getElementById('tailwind-cdn')) {
    const s = document.createElement('script'); s.id = 'tailwind-cdn';
    s.src = 'https://cdn.tailwindcss.com'; document.head.appendChild(s);
  }
  if (!document.getElementById('fontawesome-cdn')) {
    const l = document.createElement('link'); l.id = 'fontawesome-cdn';
    l.rel = 'stylesheet'; l.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
    document.head.appendChild(l);
  }
  if (!document.getElementById('rubik-font')) {
    const l = document.createElement('link'); l.id = 'rubik-font';
    l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=Rubik:wght@400&display=swap';
    document.head.appendChild(l);
  }
  if (!document.getElementById('price-flash-styles')) {
    const style = document.createElement('style'); style.id = 'price-flash-styles';
    style.innerHTML = `
      @keyframes flashGreen { 0%,100%{background:transparent} 30%{background:rgba(0,200,5,0.22)} }
      @keyframes flashRed   { 0%,100%{background:transparent} 30%{background:rgba(255,80,0,0.22)} }
      @keyframes tickUp { 0%{transform:translateY(4px);opacity:0} 100%{transform:translateY(0);opacity:1} }
      @keyframes tickDn { 0%{transform:translateY(-4px);opacity:0} 100%{transform:translateY(0);opacity:1} }
      .flash-up { animation:flashGreen 0.55s ease-out; border-radius:6px; }
      .flash-dn { animation:flashRed 0.55s ease-out; border-radius:6px; }
      .tick-up  { animation:tickUp 0.2s ease-out; display:inline-block; }
      .tick-dn  { animation:tickDn 0.2s ease-out; display:inline-block; }
    `;
    document.head.appendChild(style);
  }
}

const LOGIN_BG_IMAGES = [
  "/BG3.jpg",
  "/BG2.jpg",
  "/BG1.jpg",
  "/BG4.jpg",
  "/BG5.jpg",
  "/BG6.jpg",
  "/BG7.jpg"
];

const getLastPrice = (stk) => (!stk?.prices?.length ? 100 : stk.prices[stk.prices.length - 1]);
const fmt = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const tsToTime = (ts) => { if (!ts) return ''; const d = new Date(ts); return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`; };

const wipeCollection = async (db, collPath) => {
  const snap = await getDocs(collection(db, ...collPath));
  if (snap.empty) return;
  const chunks = [];
  let batch = writeBatch(db);
  let count = 0;
  snap.forEach(doc => {
    batch.delete(doc.ref);
    count++;
    if (count === 400) {
      chunks.push(batch.commit());
      batch = writeBatch(db);
      count = 0;
    }
  });
  if (count > 0) chunks.push(batch.commit());
  await Promise.all(chunks);
};

const AnimatedPrice = ({ price, stockId = '', className = '', prefix = '$', size = 'text-sm' }) => {
  const prevRef = useRef(price);
  const [flashCls, setFlashCls] = useState('');
  const [tickCls,  setTickCls]  = useState('');
  useEffect(() => {
    prevRef.current = price;
    setFlashCls(''); setTickCls('');
  // eslint-disable-next-line
  }, [stockId]);
  useEffect(() => {
    if (prevRef.current === price) return;
    const up = price > prevRef.current;
    setFlashCls(up ? 'flash-up text-[#00C805]' : 'flash-dn text-[#FF5000]');
    setTickCls(up ? 'tick-up' : 'tick-dn');
    prevRef.current = price;
    const t = setTimeout(() => { setFlashCls(''); setTickCls(''); }, 700);
    return () => clearTimeout(t);
  }, [price]);
  return (
    <span className={`inline-block transition-colors duration-300 ${flashCls} ${className}`}>
      <span className={`${tickCls} ${size} font-black tabular-nums tracking-tight`}>{prefix}{fmt(price)}</span>
    </span>
  );
};

const useLivePrice = (stockId, stocksRef) => {
  const [price, setPrice] = useState(() => {
    const s = stocksRef.current.find(x => x.id === stockId);
    return s ? getLastPrice(s) : 100;
  });
  useEffect(() => {
    if (!stockId) return;
    const tick = () => {
      const s = stocksRef.current.find(x => x.id === stockId);
      if (s) { const p = getLastPrice(s); setPrice(prev => prev !== p ? p : prev); }
    };
    tick();
    const id = setInterval(tick, 400); 
    return () => clearInterval(id);
  }, [stockId, stocksRef]);
  return price;
};

export default function App() {
  const [db, setDb]           = useState(null);
  const [loading, setLoading] = useState(true);
  const [gameState, setGameState] = useState({
    currentRound: 1, marketOpen: false, adminPassword: 'campadmin',
    defaultCash: 20000, autoTick: false, inflationRate: 2, feeRate: 0.01,
    hasOpenedBefore: false, basePrices: {}, previousRanks: {}, news: []
  });
  const [teams,  setTeams]  = useState([]);
  const [stocks, setStocks] = useState([]);
  const [tradeLogs, setTradeLogs] = useState([]); 

  const [role,         setRole]         = useState(null);
  const [adminView,   setAdminView]     = useState('dashboard'); 
  const [teamView,    setTeamView]      = useState('market');
  const [selectedTeamId,   setSelectedTeamId]   = useState('');
  const [teamPwd,          setTeamPwd]          = useState('');
  const [adminPwd,         setAdminPwd]         = useState('');
  const [isAdmin,          setIsAdmin]          = useState(false);
  const [selectedStockId,  setSelectedStockId]  = useState(null);
  const [tradeType,        setTradeType]        = useState('buy');
  const [tradeQty,         setTradeQty]         = useState(1);
  const [toast,            setToast]            = useState(null);
  const [confirm,          setConfirm]          = useState({ open: false, msg: '', fn: null });
  const [draftStocks,      setDraftStocks]      = useState([]);
  const [draftTeamCount,   setDraftTeamCount]   = useState(6);
  const [draftCash,        setDraftCash]        = useState(20000); 
  const [nextPrices,       setNextPrices]       = useState({});
  const [nextBorrowRates,  setNextBorrowRates]  = useState({});
  const [newsInput,        setNewsInput]        = useState(''); 
  const [newsTarget,       setNewsTarget]       = useState('ALL'); 
  const [isResetting,      setIsResetting]      = useState(false);
  const [monitorTeamId,    setMonitorTeamId]    = useState(null); 
  const [showAdminLogin,   setShowAdminLogin]   = useState(false);
  
  // Admin 系統注資/扣款狀態
  const [injectTeamId,     setInjectTeamId]     = useState('ALL');
  const [injectAmount,     setInjectAmount]     = useState('');
  const [injectMemo,       setInjectMemo]       = useState('');
  
  const mySessionId = useRef(Math.random().toString(36).substring(2, 15));
  const [bgIndex, setBgIndex] = useState(0);

  const stocksRef  = useRef(stocks);
  const gsRef      = useRef(gameState);
  const teamsRef   = useRef(teams);
  const tickerRef  = useRef(null);
  const bundleStateRef = useRef(null); 

  useEffect(() => { stocksRef.current = stocks;    }, [stocks]);
  useEffect(() => { gsRef.current     = gameState; }, [gameState]);
  useEffect(() => { teamsRef.current  = teams;     }, [teams]);

  // 背景輪播定時器 (8秒)
  useEffect(() => {
    if (role) return; 
    const timer = setInterval(() => {
      setBgIndex(prev => (prev + 1) % LOGIN_BG_IMAGES.length);
    }, 8000);
    return () => clearInterval(timer);
  }, [role]);

  const notify = useCallback((type, text) => {
    setToast({ type, text }); setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    if (role === 'team' && selectedTeamId) {
      const currentTeam = teams.find(t => t.id === selectedTeamId);
      if (currentTeam && currentTeam.currentSession && currentTeam.currentSession !== mySessionId.current) {
        setRole(null);
        notify('error', '⚠️ 你的帳號已在其他裝置登入，你已被強制登出！');
      }
    }
  }, [teams, role, selectedTeamId, notify]);

  const getBasePrice = useCallback((stk) => {
    const bp = gameState.basePrices?.[stk?.id];
    return bp !== undefined ? bp : (stk?.prices?.[0] ?? 100);
  }, [gameState.basePrices]);

  const calcAssets = useCallback((team, currentStocks) => {
    if (!team) return 0;
    let sv = 0;
    currentStocks.forEach(s => { sv += (team.holdings?.[s.id] || 0) * getLastPrice(s); });
    return (team.cash || 0) + sv;
  }, []); 

  const getBuyingPower = useCallback((team, currentStocks) => {
    if (!team) return 0;
    let shortValue = 0;
    currentStocks.forEach(s => {
      const held = team.holdings?.[s.id] || 0;
      if (held < 0) shortValue += Math.abs(held) * getLastPrice(s);
    });
    return Math.max(0, (team.cash || 0) - (2 * shortValue));
  }, []);

  const leaderboard = useMemo(() => {
    return [...teams].map(t => {
      const realAssets = calcAssets(t, stocks); 
      const initCash   = gameState.defaultCash || 20000;
      return { ...t, totalAssets: realAssets, roi: ((realAssets - initCash) / initCash) * 100 };
    }).sort((a, b) => b.totalAssets - a.totalAssets);
  }, [teams, stocks, gameState.defaultCash, calcAssets]); 

  useEffect(() => {
    try {
        const app  = initializeApp(firebaseConfig);
        const auth = getAuth(app);
        const _db  = getFirestore(app);
        setDb(_db);
        signInAnonymously(auth).catch(console.warn);
        const unsub = onAuthStateChanged(auth, () => setLoading(false));
        return () => unsub();
    } catch (e) {
        console.error("Firebase 初始化失敗:", e);
        setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!db) return;
    const base = ['artifacts', appId, 'public', 'data'];

    const unsubGS = onSnapshot(doc(db, ...base, 'gameState', 'current'), snap => {
      const def = { currentRound: 1, marketOpen: false, adminPassword: 'campadmin',
        defaultCash: 20000, autoTick: false, inflationRate: 2, feeRate: 0.01,
        hasOpenedBefore: false, basePrices: {}, previousRanks: {}, news: [] };
      if (snap.exists()) {
        const data = snap.data();
        setGameState({ ...def, ...data });
        if (data.defaultCash) setDraftCash(data.defaultCash);
      }
      else setDoc(doc(db, ...base, 'gameState', 'current'), def);
    });

    const unsubBundle = onSnapshot(doc(db, ...base, 'stocksBundle', 'all'), snap => {
      if (snap.exists()) {
        const data = snap.data();
        bundleStateRef.current = data; 
        if (Array.isArray(data.stocks)) setStocks([...data.stocks].sort((a, b) => a.id.localeCompare(b.id)));
      }
    });

    const unsubTeams = onSnapshot(collection(db, ...base, 'teams'), snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
      arr.sort((a, b) => (parseInt(a.id.replace('team_', '')) || 0) - (parseInt(b.id.replace('team_', '')) || 0));
      setTeams(arr);
    });

    const qLogs = query(collection(db, ...base, 'tradeLogs'), orderBy('ts', 'desc'), limit(500));
    const unsubLogs = onSnapshot(qLogs, snap => {
      const arr = [];
      snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
      arr.sort((a, b) => b.ts - a.ts);
      setTradeLogs(arr); 
    });

    return () => { unsubGS(); unsubBundle(); unsubTeams(); unsubLogs(); };
  }, [db]);

  useEffect(() => {
    if (stocks.length > 0) {
      setDraftStocks(stocks);
      const np = {}; const nbr = {};
      stocks.forEach(s => { 
        np[s.id] = getLastPrice(s);
        nbr[s.id] = s.borrowRate ?? 0;
      }); 
      setNextPrices(np);
      setNextBorrowRates(nbr);
    } else {
      setDraftStocks([
        { id: 'STK01', symbol: 'AAPL', name: '蘋果', desc: '全球消費電子巨頭。', prices: [150], volatility: 5, borrowRate: 2 },
        { id: 'STK02', symbol: 'TSLA', name: '特斯拉', desc: '電動車領導者，波動劇烈。', prices: [220], volatility: 8, borrowRate: 5 },
        { id: 'STK03', symbol: 'NVDA', name: '輝達晶片', desc: 'AI 運算核心。', prices: [180], volatility: 6, borrowRate: 3 },
      ]);
    }
  }, [stocks]);
  useEffect(() => { if (teams.length > 0) setDraftTeamCount(teams.length); }, [teams]);

  // 分散式跳動引擎 (每 20 秒) 
  useEffect(() => {
    clearInterval(tickerRef.current);
    if (!db) return;
    tickerRef.current = setInterval(async () => {
      const gs = gsRef.current;
      if (!gs.marketOpen || !gs.autoTick) return;
      
      const lastUpdated = bundleStateRef.current?.updatedAt || 0;
      if (Date.now() - lastUpdated < 18000) return; 
      
      if (bundleStateRef.current) bundleStateRef.current.updatedAt = Date.now();

      const cur = stocksRef.current;
      let changed = false;
      const updated = cur.map(stk => {
        if (Math.random() > 0.5) return stk;
        const cp   = getLastPrice(stk); 
        const vol  = stk.volatility ?? 5; 
        
        const maxP = cp * (1 + vol / 100);
        const minP = cp * (1 - vol / 100);
        const step = Math.max(0.5, cp * 0.012);
        
        let np = cp + (Math.random() - 0.48) * 2 * step; 
        np = Math.round(Math.max(minP, Math.min(maxP, np)) * 100) / 100;
        
        if (np === cp) return stk;
        changed = true;
        return { ...stk, prices: [np] }; 
      });
      if (changed) {
        try {
          await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'stocksBundle', 'all'),
            { stocks: updated, updatedAt: Date.now() });
        } catch (e) { console.error(e); }
      }
    }, 20000); 
    return () => clearInterval(tickerRef.current);
  }, [db]);

  const gsDocRef     = () => doc(db, 'artifacts', appId, 'public', 'data', 'gameState', 'current');
  const bundleDocRef = () => doc(db, 'artifacts', appId, 'public', 'data', 'stocksBundle', 'all');

  const toggleMarket = () => {
    if (!db) return;
    if (!gameState.marketOpen) {
      const first     = !gameState.hasOpenedBefore;
      const inflation = gameState.inflationRate ?? 2;
      setConfirm({
        open: true,
        msg: first
          ? `⚠️ 準備【首次】敲鐘開市！\n\n首次開市不扣除通膨，僅啟動市場。`
          : `⚠️ 確定要開市嗎？\n\n將扣除所有小隊 ${inflation}% 現金（通膨），並凍結排行榜快照。`,
        fn: async () => {
          setConfirm({ open: false });
          try {
            const batch = writeBatch(db);
            const multiplier = 1 - (inflation / 100);
            teams.forEach(t => {
              const baseCash = first ? (t.cash || 0) : ((t.cash || 0) * multiplier);
              let sv = 0;
              stocksRef.current.forEach(s => { sv += (t.holdings?.[s.id] || 0) * getLastPrice(s); });
              batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'teams', t.id),
                { cash: baseCash, lastReportedAssets: baseCash + sv });
            });
            batch.update(gsDocRef(), { marketOpen: true, hasOpenedBefore: true });
            await batch.commit();
            notify('success', first ? '✅ 首次開市成功！' : `✅ 市場開啟！已扣除 ${inflation}% 通膨。`);
          } catch (e) { notify('error', '操作失敗: ' + e.message); }
        }
      });
    } else {
      updateDoc(gsDocRef(), { marketOpen: false });
      notify('success', '市場已收盤，交易鎖定。');
    }
  };

  const handleAdvanceRound = () => {
    setConfirm({
      open: true,
      msg: `即將進入第 ${gameState.currentRound + 1} 回合？\n\n1. 將結算「已持有一回合以上」的空單 (強制回補)。\n2. 若結算後總資產小於等於零，將給予警告；若連續兩回合小於等於零，將強制平倉並凍結帳戶。\n3. 目標價鎖定為新基準價。\n4. 更新借券費率。`,
      fn: async () => {
        setConfirm({ open: false });
        try {
          const batch = writeBatch(db);
          const logsRef = collection(db, 'artifacts', appId, 'public', 'data', 'tradeLogs');

          const newBP = {};
          const updatedStocks = stocksRef.current.map(stk => {
            const currentClosePrice = getLastPrice(stk); 
            const tp = parseFloat(nextPrices[stk.id] ?? currentClosePrice);
            const tbr = parseFloat(nextBorrowRates[stk.id] ?? (stk.borrowRate ?? 0));
            newBP[stk.id] = currentClosePrice; 
            return { ...stk, prices: [tp], _tp: tp, borrowRate: tbr, _oldBorrowRate: stk.borrowRate ?? 0 }; 
          });

          teamsRef.current.forEach(t => {
            let cashDelta = 0;
            let feeDelta = 0;
            let borrowFeeDelta = 0;
            const newHoldings = { ...t.holdings };
            const newAvgCosts = { ...t.avgCosts };
            const newShortAges = { ...(t.shortAges || {}) };
            let autoCovered = false;
            let marginCalled = false;
            let nextMarginCallWarning = t.marginCallWarning || false;

            updatedStocks.forEach(s => {
              const held = t.holdings?.[s.id] || 0;
              if (held < 0) { 
                const currentAge = newShortAges[s.id] || 0;
                if (currentAge >= 1) { 
                  const qtyToCover = Math.abs(held);
                  const price = s._tp; 
                  const baseTotal = qtyToCover * price;
                  const shortAvgCost = t.avgCosts?.[s.id] || 0; 
                  
                  const feeRate = gsRef.current.feeRate || 0;
                  const txFee = baseTotal * (feeRate / 100);
                  const borrowRate = s._oldBorrowRate || 0; 
                  const borrowFee = baseTotal * (borrowRate / 100);
                  const totalCost = baseTotal + txFee + borrowFee;

                  cashDelta -= totalCost;
                  feeDelta += txFee;
                  borrowFeeDelta += borrowFee;
                  newHoldings[s.id] = 0;
                  newAvgCosts[s.id] = 0;
                  newShortAges[s.id] = 0;
                  autoCovered = true;

                  const logDoc = doc(logsRef);
                  batch.set(logDoc, {
                    ts: Date.now() + Math.random(), round: gsRef.current.currentRound + 1, teamId: t.id, teamName: t.name, 
                    action: 'buy', symbol: s.symbol, qty: qtyToCover, price: price, shortAvgCost: shortAvgCost,
                    total: totalCost, fee: txFee + borrowFee, isAutoCover: true
                  });
                } else {
                  newShortAges[s.id] = currentAge + 1;
                }
              } else {
                newShortAges[s.id] = 0; 
              }
            });

            let projectedAssets = (t.cash || 0) + cashDelta;
            updatedStocks.forEach(s => {
              const held = newHoldings[s.id] || 0;
              if (held > 0) projectedAssets += held * s._tp;
              if (held < 0) projectedAssets -= Math.abs(held) * s._tp; 
            });

            let finalIsBankrupt = t.isBankrupt;

            if (projectedAssets <= 0 && Object.values(newHoldings).some(v => v !== 0)) {
              if (nextMarginCallWarning) {
                finalIsBankrupt = true;
                nextMarginCallWarning = false;

                updatedStocks.forEach(s => {
                  const held = newHoldings[s.id] || 0;
                  if (held > 0) { 
                    const price = s._tp;
                    const baseTotal = held * price;
                    const feeRate = gsRef.current.feeRate || 0;
                    const txFee = baseTotal * (feeRate / 100);

                    cashDelta += (baseTotal - txFee);
                    feeDelta += txFee;
                    newHoldings[s.id] = 0;
                    newAvgCosts[s.id] = 0;
                    marginCalled = true;

                    const logDoc = doc(logsRef);
                    batch.set(logDoc, {
                      ts: Date.now() + Math.random(), round: gsRef.current.currentRound + 1, teamId: t.id, teamName: t.name, 
                      action: 'sell', symbol: s.symbol, qty: held, price: price,
                      total: baseTotal - txFee, fee: txFee, isMarginCall: true
                    });
                  } else if (held < 0) { 
                    const qtyToCover = Math.abs(held);
                    const price = s._tp; 
                    const baseTotal = qtyToCover * price;
                    const shortAvgCost = t.avgCosts?.[s.id] || 0; 
                    
                    const feeRate = gsRef.current.feeRate || 0;
                    const txFee = baseTotal * (feeRate / 100);
                    const borrowRate = s._oldBorrowRate || 0; 
                    const borrowFee = baseTotal * (borrowRate / 100);
                    const totalCost = baseTotal + txFee + borrowFee;

                    cashDelta -= totalCost;
                    feeDelta += txFee;
                    borrowFeeDelta += borrowFee;
                    newHoldings[s.id] = 0;
                    newAvgCosts[s.id] = 0;
                    newShortAges[s.id] = 0;
                    marginCalled = true;

                    const logDoc = doc(logsRef);
                    batch.set(logDoc, {
                      ts: Date.now() + Math.random(), round: gsRef.current.currentRound + 1, teamId: t.id, teamName: t.name, 
                      action: 'buy', symbol: s.symbol, qty: qtyToCover, price: price, shortAvgCost: shortAvgCost,
                      total: totalCost, fee: txFee + borrowFee, isMarginCall: true
                    });
                  }
                });
              } else {
                nextMarginCallWarning = true;
              }
            } else {
              nextMarginCallWarning = false;
              finalIsBankrupt = false; 
            }
            
            if (autoCovered || marginCalled || finalIsBankrupt !== t.isBankrupt || nextMarginCallWarning !== t.marginCallWarning || Object.keys(newShortAges).length > 0) {
              batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'teams', t.id), {
                cash: (t.cash || 0) + cashDelta,
                holdings: newHoldings,
                avgCosts: newAvgCosts,
                shortAges: newShortAges,
                marginCallWarning: nextMarginCallWarning,
                accumulatedFee: (t.accumulatedFee || 0) + feeDelta,
                accumulatedBorrowFee: (t.accumulatedBorrowFee || 0) + borrowFeeDelta,
                isBankrupt: finalIsBankrupt
              });
            }
          });

          const newRanks = {};
          leaderboard.forEach((t, i) => newRanks[t.id] = i + 1);

          const finalStocks = updatedStocks.map(({_tp, _oldBorrowRate, ...rest}) => rest);
          
          batch.set(bundleDocRef(), { stocks: finalStocks, updatedAt: Date.now() });
          batch.update(gsDocRef(), {
            currentRound: gameState.currentRound + 1,
            marketOpen: false,
            basePrices: newBP,
            previousRanks: newRanks
          });
          
          await batch.commit();
          notify('success', `✅ 已切換至第 ${gameState.currentRound + 1} 回合！結算完成。`);
        } catch (e) { notify('error', '切換失敗: ' + e.message); }
      }
    });
  };

  const handleSendNews = async () => {
    if (!newsInput.trim() || !db) return;
    try {
      const newMsg = { ts: Date.now(), text: newsInput, target: newsTarget };
      const currentNews = gameState.news || [];
      await updateDoc(gsDocRef(), { news: [newMsg, ...currentNews].slice(0, 5) }); 
      setNewsInput('');
      notify('success', '✅ 市場新聞已發布！');
    } catch (e) { notify('error', '廣播失敗'); }
  };

  const handleInjectCash = async () => {
    if (!db || injectAmount === '' || injectAmount === 0 || !injectMemo.trim()) return notify('error', '請填寫金額與備註說明');
    setConfirm({
      open: true,
      msg: `確定要為 ${injectTeamId === 'ALL' ? '所有小隊' : teams.find(t=>t.id===injectTeamId)?.name} ${injectAmount > 0 ? '增加' : '扣除'} $${fmt(Math.abs(injectAmount))} 嗎？\n說明：${injectMemo}`,
      fn: async () => {
        setConfirm({ open: false });
        try {
          const batch = writeBatch(db);
          const logsRef = collection(db, 'artifacts', appId, 'public', 'data', 'tradeLogs');
          const targetTeams = injectTeamId === 'ALL' ? teams : teams.filter(t => t.id === injectTeamId);
          
          targetTeams.forEach(t => {
            const newCash = (t.cash || 0) + parseInt(injectAmount);
            const currentAssets = calcAssets({...t, cash: newCash}, stocksRef.current);

            batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'teams', t.id), {
              cash: newCash,
              isBankrupt: currentAssets <= 0, 
              marginCallWarning: currentAssets <= 0 ? t.marginCallWarning : false 
            });
            batch.set(doc(logsRef), {
              ts: Date.now() + Math.random(), 
              round: gsRef.current.currentRound, 
              teamId: t.id, 
              teamName: t.name, 
              action: 'system', 
              symbol: injectMemo, 
              qty: 0, 
              price: 0, 
              total: parseInt(injectAmount), 
              fee: 0
            });
          });
          await batch.commit();
          notify('success', '✅ 資金發放/扣除成功！');
          setInjectAmount('');
          setInjectMemo('');
        } catch (e) {
          notify('error', '操作失敗: ' + e.message);
        }
      }
    });
  };

  const handleReset = () => {
    setConfirm({
      open: true,
      msg: `⚠️ 清除所有資料！\n重新建立 ${draftTeamCount} 個小隊？`,
      fn: async () => {
        setConfirm({ open: false }); setIsResetting(true);
        try {
          await wipeCollection(db, ['artifacts', appId, 'public', 'data', 'teams']);
          await wipeCollection(db, ['artifacts', appId, 'public', 'data', 'tradeLogs']);
          await wipeCollection(db, ['artifacts', appId, 'public', 'data', 'stocks']); 
          
          const batch = writeBatch(db);
          const initHoldings = {}; const initAvgCosts = {}; const initBP = {};
          draftStocks.forEach(s => { initHoldings[s.id] = 0; initAvgCosts[s.id] = 0; initBP[s.id] = s.prices?.[0] ?? 100; });
          
          const initCash = draftCash || 20000;
          const count = Math.max(1, parseInt(draftTeamCount) || 1);
          for (let i = 1; i <= count; i++) {
            const tid = `team_${i}`;
            const pin = Math.floor(1000 + Math.random() * 9000).toString();
            batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'teams', tid), {
              id: tid, name: `第 ${i} 小隊`, cash: initCash, isBankrupt: false,
              holdings: initHoldings, avgCosts: initAvgCosts, password: pin, lastReportedAssets: initCash,
              accumulatedFee: 0, accumulatedBorrowFee: 0, shortAges: {}, marginCallWarning: false
            });
          }
          await batch.commit();
          const cleanStocks = draftStocks.map(s => ({ id: s.id, symbol: s.symbol, name: s.name, desc: s.desc || '', prices: [s.prices?.[0] ?? 100], volatility: s.volatility ?? 5, borrowRate: s.borrowRate ?? 0 }));
          await setDoc(bundleDocRef(), { stocks: cleanStocks, updatedAt: Date.now() });
          await setDoc(gsDocRef(), {
            currentRound: 1, adminPassword: gameState.adminPassword || 'campadmin',
            defaultCash: initCash, marketOpen: false, autoTick: false,
            volatility: 5, inflationRate: gameState.inflationRate || 2, feeRate: gameState.feeRate || 0.01,
            hasOpenedBefore: false, basePrices: initBP, previousRanks: {}, news: []
          });
          notify('success', `✅ 重建完成！初始資金 $${fmt(initCash, 0)}`);
        } catch (e) { notify('error', '❌ ' + e.message); }
        finally { setIsResetting(false); }
      }
    });
  };

  const handleTrade = async () => {
    if (!db || !selectedTeamId || !selectedStockId) return;
    const team  = teams.find(t => t.id === selectedTeamId);
    if (team?.isBankrupt) return notify('error', '帳戶已遭破產凍結，無法交易！');
    if (!gameState.marketOpen) return notify('error', '市場已收盤，無法進行交易！'); 
    
    const stock = stocksRef.current.find(s => s.id === selectedStockId);
    if (!team || !stock) return;

    const price = getLastPrice(stock);
    const held  = team.holdings?.[selectedStockId] || 0;
    const currentAvgCost = team.avgCosts?.[selectedStockId] || 0;
    const tRef  = doc(db, 'artifacts', appId, 'public', 'data', 'teams', selectedTeamId);
    const logsRef = collection(db, 'artifacts', appId, 'public', 'data', 'tradeLogs');
    
    const feeRate = gameState.feeRate || 0;
    const baseTotal = price * tradeQty;
    const feeAmount = baseTotal * (feeRate / 100);

    try {
      if (tradeType === 'buy') {
        const totalCost = baseTotal + feeAmount; 
        
        if (held < 0 && tradeQty > Math.abs(held)) return notify('error', `請先平倉 (最大可回補 ${Math.abs(held)} 股)，再進行做多買入！`);

        const newHeld = held + tradeQty;
        let simulatedShortValue = 0;
        stocksRef.current.forEach(s => {
          let sHeld = team.holdings?.[s.id] || 0;
          if (s.id === selectedStockId) sHeld = newHeld;
          if (sHeld < 0) simulatedShortValue += Math.abs(sHeld) * getLastPrice(s);
        });
        
        let manualBorrowFee = 0;
        if (held < 0) {
          const borrowRate = stock.borrowRate || 0;
          manualBorrowFee = baseTotal * (borrowRate / 100);
        }

        const newCash = (team.cash || 0) - totalCost - manualBorrowFee;
        const newBP = newCash - (2 * simulatedShortValue);

        if (newCash < 0) return notify('error', `帳戶餘額(Cash)不足支付！含各項費用共需 $${fmt(totalCost + manualBorrowFee)}`);
        if (newBP < 0 && newHeld > 0) return notify('error', `可用資金(Buying Power)不足以做多！`);
        
        let newAvgCost = currentAvgCost;
        if (held >= 0) { 
          newAvgCost = ((held * currentAvgCost) + totalCost) / newHeld;
        } else if (newHeld === 0) { 
          newAvgCost = 0;
        }

        await updateDoc(tRef, {
          cash: newCash,
          [`holdings.${selectedStockId}`]: newHeld,
          [`avgCosts.${selectedStockId}`]: newAvgCost,
          accumulatedFee: (team.accumulatedFee || 0) + feeAmount,
          accumulatedBorrowFee: (team.accumulatedBorrowFee || 0) + manualBorrowFee
        });

        await addDoc(logsRef, {
          ts: Date.now(), round: gameState.currentRound, teamId: selectedTeamId, teamName: team.name, action: 'buy', 
          symbol: stock.symbol, qty: tradeQty, price, total: totalCost, fee: feeAmount
        });

        if (manualBorrowFee > 0) {
          await addDoc(logsRef, {
            ts: Date.now() + 1, round: gameState.currentRound, teamId: selectedTeamId, teamName: team.name, action: 'fee', 
            symbol: stock.symbol, qty: tradeQty, price, total: manualBorrowFee, fee: manualBorrowFee, isBorrowFee: true
          });
        }

        notify('success', `✅ 買入(回補) ${tradeQty} 股 ${stock.symbol} @ $${fmt(price)}`);
      } else {
        if (held > 0 && tradeQty > held) return notify('error', `請先賣出所有持股 (最大可賣出 ${held} 股)，再進行放空！`);

        const totalRevenue = baseTotal - feeAmount; 
        const newHeld = held - tradeQty;
        
        let simulatedShortValue = 0;
        stocksRef.current.forEach(s => {
          let sHeld = team.holdings?.[s.id] || 0;
          if (s.id === selectedStockId) sHeld = newHeld;
          if (sHeld < 0) simulatedShortValue += Math.abs(sHeld) * getLastPrice(s);
        });
        const newCash = (team.cash || 0) + totalRevenue;
        const newBP = newCash - (2 * simulatedShortValue);

        if (newBP < 0 && newHeld < 0) return notify('error', `可用資金(Buying Power)不足以放空！`);

        let newAvgCost = currentAvgCost;
        if (held <= 0) { 
          newAvgCost = ((Math.abs(held) * currentAvgCost) + totalRevenue) / Math.abs(newHeld);
        } else if (newHeld === 0) { 
          newAvgCost = 0;
        }

        await updateDoc(tRef, {
          cash: newCash,
          [`holdings.${selectedStockId}`]: newHeld,
          [`avgCosts.${selectedStockId}`]: newAvgCost,
          accumulatedFee: (team.accumulatedFee || 0) + feeAmount
        });
        await addDoc(logsRef, {
          ts: Date.now(), round: gameState.currentRound, teamId: selectedTeamId, teamName: team.name, action: 'sell', 
          symbol: stock.symbol, qty: tradeQty, price, total: totalRevenue, fee: feeAmount
        });
        notify('success', `✅ 賣出(放空) ${tradeQty} 股 ${stock.symbol} @ $${fmt(price)}`);
      }
      setTradeQty(1);
    } catch (e) { notify('error', `交易失敗: ${e.message}`); }
  };

  const Toast = () => !toast ? null : (
    <div className={`fixed bottom-8 right-6 z-[300] flex items-center gap-3 px-5 py-4 rounded-2xl text-sm font-bold shadow-2xl
      ${toast.type === 'success' ? 'bg-[#00C805] text-white' : 'bg-[#FF5000] text-white'}`}>
      <i className={`fa-solid ${toast.type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'}`}></i>
      {toast.text}
    </div>
  );

  const ConfirmModal = () => !confirm.open ? null : (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-2xl p-8 max-w-md w-full shadow-2xl text-center">
        <h3 className="text-xl font-bold mb-4">確認操作</h3>
        <p className="text-slate-500 mb-8 whitespace-pre-wrap text-sm leading-relaxed">{confirm.msg}</p>
        <div className="flex gap-4">
          <button onClick={() => setConfirm({ open: false })} className="flex-1 bg-slate-100 py-3 rounded-xl font-bold text-sm hover:bg-slate-200 transition-colors">取消</button>
          <button onClick={confirm.fn} className="flex-1 bg-slate-900 text-white py-3 rounded-xl font-bold text-sm hover:opacity-80 transition-opacity">確認執行</button>
        </div>
      </div>
    </div>
  );

  const MarketStatusBadge = () => (
    <div className={`px-2.5 py-1 rounded-full text-[11px] font-bold flex items-center gap-1.5 border shrink-0
      ${gameState.marketOpen ? 'bg-[#00C805]/10 text-[#00C805] border-[#00C805]/30' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
      <div className={`w-1.5 h-1.5 rounded-full ${gameState.marketOpen ? 'bg-[#00C805] animate-pulse' : 'bg-slate-400'}`}></div>
      {gameState.marketOpen ? 'Open' : 'Closed'}
    </div>
  );

  const NewsBanner = () => {
    const [visible, setVisible] = useState(false);
    const [activeNews, setActiveNews] = useState(null);

    useEffect(() => {
      const activeNewsList = (gameState.news || []).filter(n => n.target === 'ALL' || n.target === selectedTeamId || role === 'admin' || role === 'board');
      const latest = activeNewsList[0];
      
      if (latest && Date.now() - latest.ts < 20000) { 
        setActiveNews(latest);
        setVisible(true);
        const timer = setTimeout(() => setVisible(false), 20000 - (Date.now() - latest.ts));
        return () => clearTimeout(timer);
      } else {
        setVisible(false);
      }
    }, [gameState.news, selectedTeamId, role]);

    if (!visible || !activeNews) return null;

    return (
      <div className="w-full bg-[#0033A0] text-white px-4 py-2.5 flex items-center gap-3 overflow-hidden shadow-md animate-fade-in-down z-40 relative transition-all">
        <span className="shrink-0 text-[10px] font-black tracking-widest bg-white/20 px-2 py-0.5 rounded animate-pulse">
          <i className="fa-solid fa-bullhorn mr-1.5"></i>MARKET NEWS
        </span>
        <div className="text-sm font-bold truncate flex-1 leading-none">{activeNews.text}</div>
        <div className="shrink-0 text-[10px] opacity-70 font-mono hidden sm:block">{tsToTime(activeNews.ts)}</div>
      </div>
    );
  };

  const Navbar = ({ showTeamTabs = false }) => (
    <nav className="sticky top-0 z-50 flex justify-between items-center px-4 sm:px-6 py-3 border-b
      bg-white/85 backdrop-blur-2xl border-slate-200">
      <div className="flex items-center gap-3 min-w-0">
        <img src="/NYCU.png" alt="NYCU Logo" className="h-7 w-auto mr-1.5" />
        <span className="text-sm font-black tracking-tight whitespace-nowrap">
          NYCU IMF VSE
          <span className="ml-1.5 text-[10px] font-normal text-slate-400">R{gameState.currentRound}</span>
        </span>
        <MarketStatusBadge />
        {showTeamTabs && (
          <div className="hidden md:flex items-center gap-1 ml-1 bg-slate-100 p-1 rounded-xl">
            {[['market','chart-line','報價與下單'], ['portfolio','wallet','我的持股']].map(([v, icon, lbl]) => (
              <button key={v} onClick={() => { setTeamView(v); setSelectedStockId(null); }}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[11px] font-black transition-all
                  ${teamView === v ? 'bg-white shadow text-slate-900' : 'text-slate-400 hover:text-slate-900'}`}>
                <i className={`fa-solid fa-${icon}`}></i>{lbl}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {role === 'team' && (
          <span className={`hidden sm:block text-[11px] font-bold px-2.5 py-1 rounded-lg border ${teams.find(t=>t.id===selectedTeamId)?.isBankrupt ? 'bg-rose-50 text-rose-500 border-rose-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
            {teams.find(t => t.id === selectedTeamId)?.name}
          </span>
        )}
        <button onClick={() => { setRole(null); setIsAdmin(false); setSelectedStockId(null); setTeamView('market'); }}
          className="text-[11px] font-bold text-slate-400 hover:text-slate-900 transition">Exit</button>
      </div>
    </nav>
  );

  const MobileTeamTabs = () => (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/92 backdrop-blur-xl border-t border-slate-200 flex">
      {[['market','chart-line','報價與下單'], ['portfolio','wallet','我的持股']].map(([v, icon, lbl]) => (
        <button key={v} onClick={() => { setTeamView(v); setSelectedStockId(null); }}
          className={`flex-1 flex flex-col items-center py-3 text-[10px] font-black gap-1 transition-colors
            ${teamView === v ? 'text-[#00C805]' : 'text-slate-400'}`}>
          <i className={`fa-solid fa-${icon} text-lg`}></i>{lbl}
        </button>
      ))}
    </div>
  );

  const StockRowItem = ({ stk, onClick, selected, holding }) => {
    const price = getLastPrice(stk);
    const base  = getBasePrice(stk);
    const isUp  = price >= base;
    const pct   = base > 0 ? Math.abs((price - base) / base * 100) : 0;
    return (
      <div onClick={onClick}
        className={`p-4 rounded-2xl cursor-pointer transition-all border
          ${selected ? 'bg-white border-slate-200 shadow-lg' : 'border-transparent hover:bg-slate-100'}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="font-black text-base leading-tight">{stk.symbol}</div>
            <div className="text-[11px] text-slate-400 truncate mt-0.5">{stk.name}</div>
            {holding !== 0 && <div className={`text-[10px] font-bold mt-1 ${holding > 0 ? 'text-blue-600' : 'text-rose-400'}`}>{holding > 0 ? '擁有' : '放空'} {Math.abs(holding)} 股</div>}
          </div>
          <div className="text-right shrink-0">
            <AnimatedPrice price={price} stockId={stk.id} size="text-lg" />
            <div className={`text-xs font-bold mt-1 ${isUp ? 'text-[#00C805]' : 'text-[#FF5000]'}`}>
              {isUp ? '+' : '-'}{pct.toFixed(2)}%
            </div>
          </div>
        </div>
      </div>
    );
  };

  const OrderPanel = ({ stockId, team }) => {
    const price = useLivePrice(stockId, stocksRef);
    const stock = stocks.find(s => s.id === stockId);
    if (!stock || !team) return null;
    const base  = getBasePrice(stock);
    const isUp  = price >= base;
    const held  = team?.holdings?.[stockId] || 0;
    const pct   = base > 0 ? ((price - base) / base * 100) : 0;
    const buyingPower = getBuyingPower(team, stocksRef.current); 
    
    const feeRate = gameState.feeRate || 0;
    const baseTotal = price * tradeQty;
    const feeAmount = baseTotal * (feeRate / 100);
    
    let manualBorrowFee = 0;
    if (tradeType === 'buy' && held < 0) {
      const borrowRate = stock.borrowRate || 0;
      manualBorrowFee = baseTotal * (borrowRate / 100);
    }
    const finalAmount = tradeType === 'buy' ? baseTotal + feeAmount + manualBorrowFee : baseTotal - feeAmount;
    
    let maxBuy = 0; let maxSell = 0;
    const affordableQty = Math.max(0, Math.floor(buyingPower / (price * (1 + feeRate/100))));

    if (held < 0) { 
       maxBuy = Math.abs(held); 
       maxSell = affordableQty; 
    } else if (held > 0) { 
       maxBuy = affordableQty; 
       maxSell = held; 
    } else { 
       maxBuy = affordableQty; 
       maxSell = affordableQty; 
    }

    return (
      <div className="bg-white/85 backdrop-blur-xl border border-slate-200 rounded-3xl p-6 relative shadow-sm">
        {(!gameState.marketOpen || team.isBankrupt) && (
          <div className="absolute inset-0 bg-white/70 backdrop-blur-sm z-10 flex flex-col items-center justify-center rounded-3xl">
            {!team.isBankrupt && <i className="fa-solid fa-lock text-slate-400 text-3xl mb-3"></i>}
            <div className={`text-sm font-bold ${team.isBankrupt ? 'text-rose-500' : 'text-slate-500'}`}>{team.isBankrupt ? '帳戶已遭破產凍結' : 'Market Closed'}</div>
            <div className="text-xs text-slate-400 mt-1">收盤中，無法下單</div>
          </div>
        )}
        
        {feeRate > 0 && (
          <div className="flex justify-between items-center mb-3 bg-rose-50 p-2.5 rounded-lg border border-rose-100">
            <span className="text-[10px] font-bold text-rose-600"><i className="fa-solid fa-circle-info mr-1.5"></i>交易手續費率</span>
            <span className="text-xs font-black text-rose-600">{feeRate.toFixed(2)}%</span>
          </div>
        )}
        {(stock.borrowRate || 0) > 0 && (
          <div className="flex justify-between items-center mb-4 bg-blue-50 p-2.5 rounded-lg border border-blue-100">
            <span className="text-[10px] font-bold text-[#0033A0]"><i className="fa-solid fa-clock-rotate-left mr-1.5"></i>放空借券費率 (平倉時收取)</span>
            <span className="text-xs font-black text-[#0033A0]">{stock.borrowRate.toFixed(1)}%</span>
          </div>
        )}

        <div className="mb-6">
          <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{stock.symbol} · {stock.name}</div>
          <AnimatedPrice key={stockId} price={price} stockId={stockId} size="text-4xl" className="block mt-2" />
          <div className={`text-sm font-bold mt-1 ${isUp ? 'text-[#00C805]' : 'text-[#FF5000]'}`}>
            {isUp ? '+' : '-'}{pct.toFixed(2)}% 本回合
          </div>
        </div>
        <div className="flex border-b border-slate-100 mb-5">
          {['buy','sell'].map(t => (
            <button key={t} onClick={() => setTradeType(t)}
              className={`flex-1 pb-3 text-sm font-black border-b-2 transition-all uppercase
                ${tradeType === t ? (t === 'buy' ? 'border-[#00C805] text-[#00C805]' : 'border-[#FF5000] text-[#FF5000]') : 'border-transparent text-slate-400'}`}>
              {t === 'buy' ? '買入 (Buy/Cover)' : '賣出 (Sell/Short)'}
            </button>
          ))}
        </div>
        <div className="space-y-4 mb-6">
          <div className="flex justify-between items-center">
            <span className="text-sm text-slate-400 font-bold">股數</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setTradeQty(1)} className="px-2 h-8 rounded-lg bg-slate-100 font-bold text-[10px] hover:bg-slate-200 transition text-slate-500">MIN</button>
              <button onClick={() => setTradeQty(q => Math.max(1, q - 1))} className="w-8 h-8 rounded-lg bg-slate-100 font-bold text-base hover:bg-slate-200 transition">−</button>
              <input type="number" value={tradeQty} onChange={e => setTradeQty(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-14 text-center bg-slate-100 rounded-lg py-1.5 text-sm font-black outline-none" />
              <button onClick={() => setTradeQty(q => q + 1)} className="w-8 h-8 rounded-lg bg-slate-100 font-bold text-base hover:bg-slate-200 transition">+</button>
              <button onClick={() => setTradeQty(Math.max(1, tradeType === 'buy' ? maxBuy : maxSell))}
                className="ml-2 px-3 h-8 rounded-lg bg-blue-50 text-[#0033A0] font-black text-[10px] hover:bg-blue-100 transition border border-blue-200 active:scale-95">MAX</button>
            </div>
          </div>
          <div className="flex justify-between items-center border-t border-slate-100 pt-4">
            <div>
              <span className="text-sm font-bold text-slate-400 block">預估總額</span>
              {(feeRate > 0 || manualBorrowFee > 0) && (
                <span className="text-[10px] text-rose-500 font-bold block mt-0.5">
                  含手續/借券費 (${fmt(feeAmount + manualBorrowFee)})
                </span>
              )}
            </div>
            <AnimatedPrice price={finalAmount} stockId={`cost-${stockId}`} size="text-lg" />
          </div>
        </div>
        <button onClick={handleTrade} disabled={!gameState.marketOpen || team.isBankrupt}
          className={`w-full py-4 rounded-2xl text-base font-black text-white transition-all active:scale-95
            ${!gameState.marketOpen || team.isBankrupt ? 'bg-slate-300' : tradeType === 'buy' ? 'bg-[#00C805] shadow-md shadow-[#00C805]/20' : 'bg-[#FF5000] shadow-md shadow-[#FF5000]/20'}`}>
          {tradeType === 'buy' ? `確認買入 ${tradeQty} 股` : `確認賣出 ${tradeQty} 股`}
        </button>
        <div className="mt-4 text-center text-xs text-slate-500 font-bold">
          {tradeType === 'buy'
            ? `可用資金(BP) $${fmt(buyingPower)} · 最多可 ${held < 0 ? '回補' : '買'} ${maxBuy} 股`
            : `目前 ${held >= 0 ? `持有 ${held}` : `放空 ${Math.abs(held)}`} 股 · 最多可 ${held > 0 ? '平倉' : '空'} ${maxSell} 股`}
        </div>
      </div>
    );
  };

  const LeaderboardContent = () => {
    if (!gameState.hasOpenedBefore) return (
      <div className="text-center py-12 text-slate-400">
        <i className="fa-solid fa-lock text-4xl mb-4"></i>
        <p className="text-lg font-black">排行榜將於首次結算後解鎖</p>
      </div>
    );
    return (
      <div className="w-full space-y-4">
        {leaderboard.map((t, i) => {
          const bar = (t.totalAssets / (leaderboard[0]?.totalAssets || 1)) * 100;
          const prevRank = gameState.previousRanks?.[t.id];
          const currRank = i + 1;
          let trend = <span className="text-slate-400 text-[10px] w-5 text-center">-</span>;
          if (prevRank) {
            if (currRank < prevRank) trend = <span className="text-[#00C805] text-[10px] font-black w-5 text-center">▲{prevRank - currRank}</span>;
            else if (currRank > prevRank) trend = <span className="text-[#FF5000] text-[10px] font-black w-5 text-center">▼{currRank - prevRank}</span>;
          }

          return (
            <div key={t.id} className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-3">
                  <span className={`w-10 h-10 rounded-full flex items-center justify-center text-lg font-black shrink-0 shadow-sm
                    ${currRank === 1 ? 'bg-[#FFD700] text-black' : currRank === 2 ? 'bg-slate-300 text-black' : currRank === 3 ? 'bg-[#CD7F32] text-white' : 'bg-slate-100 text-slate-500'}`}>{currRank}</span>
                  {trend}
                  <span className={`font-black text-2xl tracking-tight flex items-center gap-2 ${t.isBankrupt ? 'text-rose-500' : ''}`}>
                    {t.name}
                  </span>
                </div>
                <div className="text-right">
                  <AnimatedPrice price={t.totalAssets} stockId={`lb-${t.id}`} size="text-3xl" className={`block ${t.isBankrupt ? 'text-rose-500' : 'text-slate-900'}`} />
                  <div className={`text-sm font-bold mt-1 ${t.roi >= 0 ? 'text-[#00C805]' : 'text-[#FF5000]'}`}>
                    {t.roi >= 0 ? '+' : ''}{t.roi.toFixed(2)}%
                  </div>
                </div>
              </div>
              <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-700 ${currRank === 1 ? 'bg-[#FFD700]' : 'bg-slate-400'}`}
                  style={{ width: `${Math.max(3, bar)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const AdminLeaderboardBoard = () => (
    <div className="fixed inset-0 bg-slate-50 z-[100] flex flex-col pt-0 pb-8 px-8 overflow-y-auto">
      <NewsBanner />
      <div className="relative mt-8">
        <button onClick={() => setAdminView('dashboard')} className="absolute top-0 right-0 w-14 h-14 rounded-full bg-slate-200 flex items-center justify-center hover:bg-slate-300 text-slate-600 transition shadow-lg">
          <i className="fa-solid fa-xmark text-2xl"></i>
        </button>
        <div className="text-center mb-12 mt-8">
          <h2 className="text-6xl font-black mb-4 tracking-tighter">20th IMF Camp Trading Leaderboard</h2>
          <br />
        </div>
      </div>
      <div className="max-w-4xl mx-auto w-full flex-grow"><LeaderboardContent /></div>
      <footer className="py-6 text-center text-xs font-bold text-slate-400 mt-auto">© 20th NYCU IMF Camp Course Team.</footer>
    </div>
  );

  const MonitorPanel = () => {
    const adminLogs = useMemo(() => tradeLogs.filter(l => l.round === gameState.currentRound), [tradeLogs, gameState.currentRound]);
    return (
      <div className="fixed inset-0 bg-slate-50 z-[100] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-white shrink-0">
          <h2 className="text-lg font-black flex items-center gap-2 text-[#0033A0]">
            <i className="fa-solid fa-satellite-dish text-[#0033A0]"></i> Team Monitor
          </h2>
          <button onClick={() => { setAdminView('dashboard'); setMonitorTeamId(null); }} className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center hover:bg-slate-200 transition">
            <i className="fa-solid fa-xmark text-slate-500"></i>
          </button>
        </div>
        <div className="flex flex-col lg:flex-row flex-grow overflow-hidden">
          <div className="w-full lg:w-[55%] overflow-y-auto p-5 border-r border-slate-200">
            <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-3">即時資產總覽</div>
            <div className="space-y-3">
              {leaderboard.map((t, i) => {
                const team = teams.find(x => x.id === t.id);
                const roi  = t.roi;
                const buyingPower = getBuyingPower(team, stocksRef.current);
                return (
                  <div key={t.id} onClick={() => setMonitorTeamId(t.id === monitorTeamId ? null : t.id)}
                    className={`bg-white border rounded-2xl p-4 cursor-pointer transition-all ${monitorTeamId === t.id ? 'border-[#0033A0] shadow-md' : 'border-slate-200 hover:border-blue-400/50'}`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-black shrink-0
                          ${i === 0 ? 'bg-[#FFD700] text-black' : i === 1 ? 'bg-slate-300 text-black' : i === 2 ? 'bg-[#CD7F32] text-white' : 'bg-slate-100 text-slate-500'}`}>{i + 1}</span>
                        <span className={`font-black text-sm flex items-center gap-2 ${t.isBankrupt ? 'text-rose-500' : ''}`}>{t.name}</span>
                      </div>
                      <div className="text-right">
                        <AnimatedPrice price={t.totalAssets} stockId={`m-${t.id}`} size="text-base" className={`block ${t.isBankrupt ? 'text-rose-500' : 'text-slate-900'}`} />
                        <span className={`text-xs font-bold ${roi >= 0 ? 'text-[#00C805]' : 'text-[#FF5000]'}`}>{roi >= 0 ? '+' : ''}{roi.toFixed(2)}%</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-slate-50 rounded-xl p-2.5">
                        <div className="text-[9px] text-slate-400 font-bold uppercase mb-1">可用資金 (BP)</div>
                        <div className="text-sm font-black text-[#0033A0]">${fmt(buyingPower)}</div>
                      </div>
                      <div className="bg-slate-50 rounded-xl p-2.5">
                        <div className="text-[9px] text-slate-400 font-bold uppercase mb-1">帳戶餘額 (Cash)</div>
                        <div className="text-sm font-black">${fmt(team?.cash || 0)}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="w-full lg:w-[45%] overflow-y-auto p-5">
            <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-3">{monitorTeamId ? `[${teams.find(t=>t.id===monitorTeamId)?.name}] 專屬紀錄` : `全服即時交易 (R${gameState.currentRound})`}</div>
            {adminLogs.filter(l => !monitorTeamId || l.teamId === monitorTeamId).length === 0 ? (
              <div className="text-center py-12 text-slate-400 text-sm">尚無交易紀錄</div>
            ) : (
              <div className="space-y-1.5">
                {adminLogs.filter(l => !monitorTeamId || l.teamId === monitorTeamId).map(log => (
                  <div key={log.id} className={`flex items-center justify-between p-3 rounded-xl border text-xs
                    ${log.isAutoCover || log.isMarginCall ? 'bg-amber-50 border-amber-200' 
                    : log.action === 'buy' ? 'bg-[#00C805]/5 border-[#00C805]/15'
                    : log.action === 'sell' ? 'bg-[#FF5000]/5 border-[#FF5000]/15'
                    : 'bg-blue-50 border-blue-200'}`}>
                    <div className="flex items-center gap-2.5">
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${log.isAutoCover || log.isMarginCall ? 'bg-amber-500' : log.action === 'buy' ? 'bg-[#00C805]' : log.action==='sell' ? 'bg-[#FF5000]' : 'bg-[#0033A0]'}`}></div>
                      {!monitorTeamId && <span className="font-black text-slate-700">{log.teamName}</span>}
                      <span className={`font-black uppercase ${log.isAutoCover || log.isMarginCall ? 'text-amber-500' : log.action === 'buy' ? 'text-[#00C805]' : log.action==='sell' ? 'text-[#FF5000]' : 'text-[#0033A0]'}`}>
                        {log.isMarginCall ? '強制平倉' : log.isAutoCover ? '自動回補' : log.action === 'buy' ? '買' : log.action === 'sell' ? '賣' : '費'}
                      </span>
                      <span className="font-bold text-slate-600">
                        {log.symbol} 
                        {log.isAutoCover 
                           ? ` (空$${fmt(log.shortAvgCost)}→平$${fmt(log.price)})`
                           : log.action === 'fee' ? '' : ` × ${log.qty} @ $${fmt(log.price)}`}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="font-black text-slate-700">${fmt(log.total)}</span>
                      <span className="text-slate-400 font-mono hidden sm:inline">{tsToTime(log.ts)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="min-h-screen w-screen flex items-center justify-center bg-slate-50">
      <i className="fa-solid fa-circle-notch animate-spin text-3xl text-slate-300"></i>
    </div>
  );
  if (!firebaseConfig) return (
    <div className="min-h-screen flex items-center justify-center">
      <h2 className="text-2xl font-bold">缺少 Firebase 設定</h2>
    </div>
  );

  return (
    <div>
      <div className="min-h-screen w-screen m-0 p-0 overflow-x-hidden font-sans transition-colors duration-300 bg-slate-50 text-slate-900 flex flex-col">
        <Toast /><ConfirmModal />

        {/* ══ LANDING ══════════════════════════════════════════════════════════ */}
        {!role && (
          <div className="flex min-h-screen flex-col lg:flex-row overflow-hidden flex-grow">
            <div className="hidden lg:flex lg:w-[60%] relative overflow-hidden group bg-slate-100">
              {LOGIN_BG_IMAGES.map((img, idx) => (
                <div key={idx}
                  className={`absolute inset-0 bg-cover transition-all duration-1000 ease-in-out ${idx === bgIndex ? 'opacity-100 blur-0 z-10' : 'opacity-0 blur-xl z-0'}`}
                  style={{ backgroundImage: `url('${img}')`, backgroundPosition: idx === 0 ? '30% center' : 'center' }}
                ></div>
              ))}
              <div className="absolute inset-0 z-20 bg-gradient-to-r from-slate-900/90 via-slate-900/40 to-transparent pointer-events-none"></div>
              <div className="relative z-30 p-16 pb-20 text-white flex flex-col justify-end h-full pointer-events-none">
                <div className="w-10 h-1 bg-[#FFFFFF] mb-6 rounded-full"></div>
                <h1 className="text-6xl xl:text-7xl font-black leading-none tracking-tighter mb-3" style={{ fontFamily: "'Rubik', sans-serif" }}>Inspire.<br/>Motivate.<br/>Flourish.</h1>
                <p className="text-slate-300 max-w-sm leading-relaxed text-sm">Experience the Market Without Financial Risk, Climb the Leaderboard, Try your Best and Hope you Guys Enjoy it!</p>
              </div>
              <div className="absolute bottom-8 left-16 z-30 flex gap-2">
                {LOGIN_BG_IMAGES.map((_, idx) => (
                  <div key={idx} onClick={(e) => { e.stopPropagation(); setBgIndex(idx); }} className={`w-2 h-2 rounded-full cursor-pointer transition-all ${idx === bgIndex ? 'bg-white w-6' : 'bg-white/40'}`}></div>
                ))}
              </div>
            </div>
            <div className="w-full lg:w-[40%] flex flex-col relative bg-slate-50 min-h-screen">
              <div className="absolute top-5 right-5 z-50 flex items-center gap-2">
                {showAdminLogin && (
                  <div className="bg-white border border-slate-200 rounded-full flex items-center px-3 py-1.5 shadow-sm animate-fade-in-right">
                    <i className="fa-solid fa-key text-slate-400 text-xs mr-2"></i>
                    <input type="password" value={adminPwd} onChange={e=>setAdminPwd(e.target.value)}
                      placeholder="PIN + Enter"
                      onKeyDown={e => { if(e.key === 'Enter') { if (adminPwd === (gameState.adminPassword)) { setIsAdmin(true); setRole('admin'); setShowAdminLogin(false); } else notify('error', '密碼錯誤'); } }}
                      className="bg-transparent outline-none text-xs w-20 font-bold" />
                  </div>
                )}
                <button onClick={() => setShowAdminLogin(!showAdminLogin)}
                  className="w-10 h-10 rounded-full flex items-center justify-center bg-white border border-slate-200 text-slate-400 hover:text-[#0033A0] transition-colors shadow-sm">
                  <i className="fa-solid fa-shield-halved text-sm"></i>
                </button>
              </div>
              <div className="flex-grow flex items-center justify-center p-8 mt-10 lg:mt-0">
                <div className="w-full max-w-md space-y-4">
                  <div className="mb-8 text-center lg:text-left">
                    <img src="/logo.png" alt="Logo" className="h-21 w-auto mx-auto lg:mx-0 mb-4" />
                    <h2 className="text-4xl tracking-tight mb-2 text-[#0033A0]" style={{ fontFamily: "'Rubik', sans-serif", fontWeight: 400 }}>IMF CAMP</h2>
                    <p className="text-slate-500 font-bold">Virtual Stock Exchange</p>                    
                  </div>
                  <div className="bg-white/75 backdrop-blur-xl border border-slate-200/60 rounded-3xl p-6 space-y-4 shadow-xl">
                    <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-2"><i className="fa-solid fa-wallet mr-1.5"></i>Team Login</div>
                    {teams.length === 0 ? (
                      <p className="text-sm text-slate-500 bg-slate-100 rounded-xl p-4 text-center font-bold">Waiting...</p>
                    ) : (
                      <>
                        <select value={selectedTeamId} onChange={e => setSelectedTeamId(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3.5 text-sm font-bold outline-none focus:border-[#0033A0] transition-colors">
                          <option value="" disabled>Select Your Team</option>
                          {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                        <input type="password" value={teamPwd} onChange={e => setTeamPwd(e.target.value)}
                          placeholder="PIN"
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3.5 text-sm outline-none focus:border-[#0033A0] transition-colors" />
                        <button disabled={!selectedTeamId}
                          onClick={async () => {
                            const t = teams.find(x => x.id === selectedTeamId);
                            if (t?.password && t.password !== teamPwd) { notify('error', '密碼錯誤！'); return; }
                            try {
                              await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'teams', selectedTeamId), { currentSession: mySessionId.current });
                              setRole('team'); setTeamPwd('');
                            } catch (e) {
                              notify('error', '登入失敗，請稍後再試！');
                            }
                          }}
                          className="w-full bg-[#0033A0] hover:bg-[#002277] disabled:bg-slate-200 disabled:text-slate-400 text-white py-3.5 rounded-xl text-sm font-black transition-all shadow-md shadow-[#0033A0]/20">
                          Login <i className="fa-solid fa-arrow-right ml-1"></i>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <footer className="py-6 text-center text-xs font-bold text-slate-400 mt-auto">© 20th NYCU IMF Camp Course Team.</footer>
            </div>
          </div>
        )}

        {/* ══ TEAM ═════════════════════════════════════════════════════════════ */}
        {role === 'team' && (() => {
          const team = teams.find(t => t.id === selectedTeamId);
          if (!team) return <div className="p-8 text-center text-slate-500">找不到小隊</div>;
          
          const realAssets = calcAssets(team, stocks);
          const initCash   = gameState.defaultCash || 20000;
          const totalROI   = ((realAssets - initCash) / initCash * 100);
          const selStock   = stocks.find(s => s.id === selectedStockId);
          const buyingPower = getBuyingPower(team, stocksRef.current);
          
          let longValueTotal = 0;
          let shortValueTotal = 0;
          let totalFeePaid = team.accumulatedFee || 0;
          let totalBorrowFeePaid = team.accumulatedBorrowFee || 0;

          const teamLogs = tradeLogs.filter(log => log.teamId === team.id);

          const portfolio  = stocks.filter(s => (team.holdings?.[s.id] || 0) !== 0).map(s => {
            const shares = team.holdings[s.id];
            const price  = getLastPrice(s);
            const avgCost = team.avgCosts?.[s.id] || getBasePrice(s); 
            const value  = Math.abs(shares) * price;
            const totalCost = Math.abs(shares) * avgCost;
            
            let returnAmt = 0;
            if (shares > 0) { 
              returnAmt = value - totalCost; 
              longValueTotal += value;
            } else { 
              returnAmt = totalCost - value; 
              shortValueTotal += value;
            }
            
            const returnPct = totalCost > 0 ? (returnAmt / totalCost * 100) : 0;
            return { ...s, shares, price, avgCost, value: shares * price, returnAmt, returnPct, isUp: returnAmt >= 0 };
          });

          return (
            <div className="flex flex-col min-h-screen">
              <NewsBanner />
              <Navbar showTeamTabs />
              <MobileTeamTabs />
              <div className="flex-grow w-full max-w-[1400px] mx-auto px-4 sm:px-6 py-6 pb-24 md:pb-6">
                
                {/* MARKET TAB */}
                {teamView === 'market' && (
                  <div className="flex flex-col lg:flex-row gap-6">
                    <div className="w-full lg:w-72 shrink-0">
                      <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-3 ml-1">Market</div>
                      <div className="grid grid-cols-1 gap-2">
                        {stocks.map(stk => (
                          <StockRowItem key={stk.id} stk={stk}
                            onClick={() => { setSelectedStockId(stk.id === selectedStockId ? null : stk.id); setTradeQty(1); }}
                            selected={selectedStockId === stk.id}
                            holding={team.holdings?.[stk.id] || 0} />
                        ))}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      {!selStock ? (
                        <div className="bg-white border border-slate-200 rounded-3xl p-8 lg:p-10 shadow-sm mt-6 lg:mt-0">
                          <div className="text-xs text-slate-400 font-bold uppercase tracking-wider mb-2">總資產(Total Portfolio Value)</div>
                          <AnimatedPrice price={realAssets} stockId="portfolio-total" size="text-5xl" className={`block mb-2 ${team.isBankrupt ? 'text-rose-500' : 'text-slate-900'}`} />
                          <div className={`text-sm font-bold mb-8 ${totalROI >= 0 ? 'text-[#00C805]' : 'text-[#FF5000]'}`}>
                            {totalROI >= 0 ? '+' : ''}{totalROI.toFixed(2)}% 總報酬率
                          </div>
                          
                          {/* Margin Call 寬限期警告 */}
                          {team.marginCallWarning && !team.isBankrupt && (
                            <div className="bg-amber-50 border border-amber-200 text-amber-700 p-4 rounded-xl text-sm font-bold mb-6 flex items-center gap-3 animate-pulse">
                              <i className="fa-solid fa-triangle-exclamation text-xl"></i>
                              <div>
                                <div className="text-[11px] uppercase tracking-wider mb-0.5 opacity-80">Margin Call Warning</div>
                                ⚠️ 資金嚴重不足！若下回合結算時總資產仍小於零，將被強制平倉並凍結帳戶！
                              </div>
                            </div>
                          )}

                          <div className="bg-slate-50 rounded-2xl p-5 mb-6 mt-4">
                            <div className="text-[10px] text-slate-400 font-bold uppercase mb-2">資產明細公式：總資產 = 帳戶餘額 + 做多市值 - 放空負債</div>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                              <div><div className="text-[10px] uppercase font-bold text-slate-400 mb-1">可用資金 (Buying Power)</div><div className="text-xl font-black text-[#0033A0]">${fmt(buyingPower)}</div></div>
                              <div><div className="text-[10px] uppercase font-bold text-slate-400 mb-1">帳戶餘額 (Cash)</div><div className="text-xl font-black">${fmt(team.cash || 0)}</div></div>
                              <div><div className="text-[10px] uppercase font-bold text-slate-400 mb-1">做多市值 (Long)</div><div className="text-xl font-black text-[#00C805]">${fmt(longValueTotal)}</div></div>
                              <div><div className="text-[10px] uppercase font-bold text-slate-400 mb-1">放空負債 (Short)</div><div className="text-xl font-black text-[#FF5000]">-${fmt(shortValueTotal)}</div></div>
                            </div>
                          </div>

                          <p className="text-xs text-slate-400 mt-6">← 點選左側股票查看價格並下單</p>
                        </div>
                      ) : (
                        <div className="flex flex-col xl:flex-row gap-6">
                          <div className="flex-1 min-w-0">
                            <button onClick={() => setSelectedStockId(null)}
                              className="flex items-center text-xs text-slate-400 hover:text-slate-900 mb-4 font-bold transition-colors gap-1.5 bg-slate-50 px-3 py-1.5 rounded-lg w-fit">
                              <i className="fa-solid fa-arrow-left"></i>返回清單
                            </button>
                            <div className="bg-white border border-slate-200 rounded-3xl p-8 shadow-sm">
                              <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{selStock.symbol}</div>
                              <h2 className="text-3xl font-black mb-1">{selStock.name}</h2>
                              <AnimatedPrice price={getLastPrice(selStock)} stockId={selectedStockId} size="text-5xl" className="block mb-2 text-slate-900" />
                              <div className={`text-sm font-bold mb-8 ${getLastPrice(selStock) >= getBasePrice(selStock) ? 'text-[#00C805]' : 'text-[#FF5000]'}`}>
                                {(() => { const d = getLastPrice(selStock) - getBasePrice(selStock); const b = getBasePrice(selStock); const p = b > 0 ? d/b*100 : 0; return `${d >= 0 ? '+' : ''}$${fmt(Math.abs(d))} (${p >= 0 ? '+' : ''}${p.toFixed(2)}%) 本回合`; })()}
                              </div>
                              <div className="border-t border-slate-100 pt-6 mb-4">
                                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">公司簡介</div>
                                <p className="text-sm text-slate-500 leading-relaxed bg-slate-50 p-4 rounded-xl">{selStock.desc}</p>
                              </div>
                            </div>
                          </div>
                          <div className="w-full xl:w-80 shrink-0">
                            <OrderPanel stockId={selectedStockId} team={team} />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                
                {/* PORTFOLIO TAB */}
                {teamView === 'portfolio' && (
                  <div className="max-w-4xl mx-auto space-y-6">
                    <div className="bg-white border border-slate-200 rounded-3xl p-8 shadow-sm">
                      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 mb-6 border-b border-slate-100 pb-6">
                        <div>
                          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">總資產</div>
                          <AnimatedPrice price={realAssets} stockId="pf-total" size="text-5xl" className={`block mb-2 ${team.isBankrupt ? 'text-rose-500' : 'text-slate-900'}`} />
                          <div className={`text-sm font-bold ${totalROI >= 0 ? 'text-[#00C805]' : 'text-[#FF5000]'}`}>
                            {totalROI >= 0 ? '+' : ''}{totalROI.toFixed(2)}% 總報酬率
                          </div>
                        </div>
                        <div className="flex gap-8">
                          <div>
                            <div className="text-[10px] text-slate-400 mb-1 font-bold uppercase">可用資金 (Buying Power)</div>
                            <div className="text-2xl font-black text-[#0033A0]">${fmt(buyingPower)}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-400 mb-1 font-bold uppercase">初始資金</div>
                            <div className="text-2xl font-black text-slate-300">${fmt(initCash)}</div>
                          </div>
                        </div>
                      </div>

                      {/* Margin Call 寬限期警告 */}
                      {team.marginCallWarning && !team.isBankrupt && (
                        <div className="bg-amber-50 border border-amber-200 text-amber-700 p-4 rounded-xl text-sm font-bold mb-4 flex items-center gap-3 animate-pulse">
                          <i className="fa-solid fa-triangle-exclamation text-xl"></i>
                          <div>
                            <div className="text-[10px] uppercase tracking-wider mb-0.5 opacity-80">Margin Call Warning</div>
                            ⚠️ 資金嚴重不足！若下回合結算時總資產仍小於零，將被強制平倉並凍結帳戶！
                          </div>
                        </div>
                      )}
                      
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 bg-slate-50 p-4 rounded-2xl mb-4">
                        <div><div className="text-[10px] uppercase font-bold text-slate-400 mb-1">可用資金 (Buying Power)</div><div className="text-lg font-black text-[#0033A0]">${fmt(buyingPower)}</div></div>
                        <div><div className="text-[10px] uppercase font-bold text-slate-400 mb-1">帳戶餘額 (Cash)</div><div className="text-lg font-black">${fmt(team.cash || 0)}</div></div>
                        <div><div className="text-[10px] uppercase font-bold text-slate-400 mb-1">做多市值 (Long)</div><div className="text-lg font-black text-[#00C805]">${fmt(longValueTotal)}</div></div>
                        <div><div className="text-[10px] uppercase font-bold text-slate-400 mb-1">放空負債 (Short)</div><div className="text-lg font-black text-[#FF5000]">-${fmt(shortValueTotal)}</div></div>
                      </div>

                      <div className="flex justify-end gap-6 border-t border-slate-100 pt-4 px-2">
                        <div className="text-right">
                          <div className="text-[10px] uppercase font-bold text-slate-400">總計支付 手續費</div>
                          <div className="text-sm font-bold text-rose-500">-${fmt(totalFeePaid)}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] uppercase font-bold text-slate-400">總計支付 借券費</div>
                          <div className="text-sm font-bold text-rose-500">-${fmt(totalBorrowFeePaid)}</div>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col lg:flex-row gap-6">
                      {/* 持股明細 */}
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-3 ml-1">持股明細(Positions)</div>
                        {portfolio.length === 0 ? (
                          <div className="bg-white border border-slate-200 rounded-3xl p-12 text-center shadow-sm">
                            <i className="fa-solid fa-inbox text-4xl text-slate-200 mb-3"></i>
                            <p className="text-slate-500 font-bold">尚未持有或放空股票</p>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {portfolio.map(item => (
                              <div key={item.id} onClick={() => { setTeamView('market'); setSelectedStockId(item.id); setTradeQty(1); }}
                                className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between cursor-pointer hover:border-blue-400/40 hover:shadow-md transition-all group gap-4">
                                <div className="flex items-center gap-4">
                                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-black shrink-0 ${item.shares > 0 ? 'bg-blue-50 text-blue-600' : 'bg-rose-50 text-rose-600'}`}>
                                    {item.symbol.slice(0, 2)}
                                  </div>
                                  <div>
                                    <div className="font-black text-lg mb-0.5">{item.symbol}</div>
                                    <div className={`text-[11px] font-bold ${item.shares > 0 ? 'text-slate-500' : 'text-rose-500'}`}>
                                      {item.shares > 0 ? '做多' : '放空'} {Math.abs(item.shares)} 股
                                      {team.shortAges?.[item.id] >= 1 && (
                                        <span className="ml-2 bg-rose-100 text-rose-600 text-[9px] px-1.5 py-0.5 rounded font-black">下回合強制回補</span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-8 justify-between sm:justify-end">
                                  <div className="text-left sm:text-right">
                                    <div className="text-[10px] text-slate-400 font-bold mb-0.5">平均成本 (Avg Cost)</div>
                                    <div className="font-mono text-sm">${fmt(item.avgCost)}</div>
                                  </div>
                                  <div className="text-right">
                                    <div className="text-[10px] text-slate-400 font-bold mb-0.5">現價總值 (Value)</div>
                                    <AnimatedPrice price={Math.abs(item.value)} stockId={`pf-${item.id}`} size="text-lg" className="block text-slate-900" />
                                    <div className={`text-xs font-bold ${item.isUp ? 'text-[#00C805]' : 'text-[#FF5000]'}`}>
                                      {item.isUp ? '+' : ''}${fmt(item.returnAmt)} ({item.returnPct.toFixed(2)}%)
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* 小隊歷史交易紀錄 */}
                      <div className="w-full lg:w-[360px] shrink-0">
                        <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-3 ml-1">交易紀錄(Recent Transactions)</div>
                        <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm max-h-[600px] overflow-y-auto">
                          {teamLogs.length === 0 ? (
                            <div className="text-center py-8 text-slate-400 text-sm">尚無交易紀錄</div>
                          ) : (
                            <div className="space-y-3">
                              {teamLogs.map(log => (
                                <div key={log.id} className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                                  <div className="flex justify-between items-start mb-2">
                                    <div className="flex items-center gap-2">
                                      <span className={`text-[10px] font-black px-1.5 py-0.5 rounded uppercase 
                                        ${log.action === 'system' ? 'bg-emerald-100 text-emerald-600'
                                        : log.isAutoCover || log.isMarginCall ? 'bg-amber-100 text-amber-600'
                                        : log.action === 'buy' ? 'bg-[#00C805]/10 text-[#00C805]' : log.action === 'sell' ? 'bg-[#FF5000]/10 text-[#FF5000]' : 'bg-blue-100 text-[#0033A0]'}`}>
                                        {log.action === 'system' ? 'Admin' : log.isMarginCall ? '強制平倉' : log.isAutoCover ? '換局回補' : log.action === 'buy' ? '買入' : log.action === 'sell' ? '賣出' : '借券費'}
                                      </span>
                                      <span className="font-bold text-sm">{log.symbol}</span>
                                    </div>
                                    <span className="text-[10px] font-black bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded">R{log.round}</span>
                                  </div>
                                  <div className="flex justify-between items-end">
                                    <div className="text-[10px] text-slate-400">
                                      {log.action === 'system' ? (
                                        <>{log.symbol}<br/></>
                                      ) : log.isAutoCover ? (
                                        <>
                                          空單均價 ${fmt(log.shortAvgCost)} → 平倉價 ${fmt(log.price)}<br/>
                                        </>
                                      ) : log.action !== 'fee' && !log.isMarginCall ? (
                                        <>{log.qty} 股 @ ${fmt(log.price)}<br/></>
                                      ) : log.isMarginCall ? (
                                        <>{log.qty} 股 @ ${fmt(log.price)}<br/></>
                                      ) : null}
                                      {log.fee > 0 && `手續/借券費 $${fmt(log.fee)}`}
                                    </div>
                                    <div className="text-right">
                                      <div className={`font-black text-sm ${log.action === 'buy' || log.action === 'fee' || (log.action === 'system' && log.total < 0) ? 'text-[#FF5000]' : 'text-[#00C805]'}`}>
                                        {log.action === 'system' 
                                          ? `${log.total >= 0 ? '+' : '-'}$${fmt(Math.abs(log.total))}`
                                          : `${log.action === 'buy' || log.action === 'fee' ? '-' : '+'}$${fmt(log.total)}`}
                                      </div>
                                      <div className="text-[9px] text-slate-400 font-mono mt-0.5">{tsToTime(log.ts)}</div>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                  </div>
                )}
              </div>
              <footer className="py-6 text-center text-xs font-bold text-slate-400 mt-auto">© 20th NYCU IMF Camp Course Team.</footer>
            </div>
          );
        })()}

        {/* ══ ADMIN ════════════════════════════════════════════════════════════ */}
        {role === 'admin' && isAdmin && (
          <div className="flex flex-col min-h-screen">
            {adminView === 'leaderboard' ? (
              <AdminLeaderboardBoard />
            ) : adminView === 'monitor' ? (
              <MonitorPanel />
            ) : (
              <>
                <NewsBanner />
                <Navbar />
                {isResetting && (
                  <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] flex items-center justify-center">
                    <div className="text-center text-white"><i className="fa-solid fa-circle-notch animate-spin text-4xl mb-4"></i><div className="font-bold">Factory Resetting...</div></div>
                  </div>
                )}
                <div className="w-full max-w-[1200px] mx-auto p-5 sm:p-8 space-y-6 flex-grow">
                  
                  <div className="flex flex-wrap gap-3 justify-end">
                    <button onClick={() => setAdminView('monitor')}
                      className="bg-[#0033A0] hover:bg-[#002277] text-white px-5 py-3.5 rounded-2xl font-black shadow-md shadow-[#0033A0]/20 transition-transform active:scale-95 flex items-center gap-2 text-sm">
                      <i className="fa-solid fa-satellite-dish text-lg"></i> Team Monitor
                    </button>
                    <button onClick={() => setAdminView('leaderboard')} 
                      className="bg-gradient-to-r from-[#FFD700] to-[#FDB931] hover:from-[#FDB931] hover:to-[#FFD700] text-black px-6 py-3.5 rounded-2xl font-black shadow-lg shadow-[#FFD700]/20 transition-transform active:scale-95 flex items-center gap-2 text-sm">
                      <i className="fa-solid fa-crown text-xl"></i> 投影排行榜 (Projector Mode)
                    </button>
                  </div>

                  <div className="bg-emerald-50 border border-emerald-100 rounded-3xl p-6 sm:p-8 shadow-sm">
                    <h2 className="text-lg font-black mb-4 flex items-center gap-2 text-emerald-700"><i className="fa-solid fa-hand-holding-dollar"></i>資金注資 / 扣款 (Manual Cash Adjust)</h2>
                    <div className="flex flex-col sm:flex-row gap-3">
                      <select value={injectTeamId} onChange={e => setInjectTeamId(e.target.value)}
                        className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none focus:border-emerald-500 transition-colors">
                        <option value="ALL">所有小隊 (全體)</option>
                        {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                      <input type="number" value={injectAmount} onChange={e => setInjectAmount(parseInt(e.target.value) || 0)}
                        placeholder="金額 (正數增加，負數扣除)"
                        className="w-full sm:w-48 bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-black outline-none focus:border-emerald-500 transition-colors text-center" />
                      <input type="text" value={injectMemo} onChange={e => setInjectMemo(e.target.value)}
                        placeholder="輸入說明 (例: 大地遊戲第一名獎勵)"
                        className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-emerald-500 transition-colors font-bold" />
                      <button onClick={handleInjectCash} className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-xl text-sm font-black shadow-md shadow-emerald-600/20 transition-all active:scale-95 whitespace-nowrap">
                        確認執行
                      </button>
                    </div>
                  </div>

                  <div className="bg-blue-50 border border-blue-100 rounded-3xl p-6 sm:p-8 shadow-sm">
                    <h2 className="text-lg font-black mb-4 flex items-center gap-2 text-[#0033A0]"><i className="fa-solid fa-bullhorn"></i>市場快訊廣播 (News Feed)</h2>
                    <div className="flex flex-col sm:flex-row gap-3">
                      <select value={newsTarget} onChange={e => setNewsTarget(e.target.value)}
                        className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none focus:border-[#0033A0] transition-colors">
                        <option value="ALL">全服廣播</option>
                        {teams.map(t => <option key={t.id} value={t.id}>[{t.name}] 獨家內線</option>)}
                      </select>
                      <input type="text" value={newsInput} onChange={e => setNewsInput(e.target.value)}
                        placeholder="輸入要推播的突發新聞... (顯示20秒後自動消失)"
                        onKeyDown={e => { if(e.key === 'Enter') handleSendNews(); }}
                        className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-[#0033A0] transition-colors font-bold" />
                      <button onClick={handleSendNews} className="bg-[#0033A0] hover:bg-[#002277] text-white px-6 py-3 rounded-xl text-sm font-black shadow-md shadow-[#0033A0]/20 transition-all active:scale-95 whitespace-nowrap">
                        發送廣播
                      </button>
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 shadow-sm">
                    <h2 className="text-lg font-black mb-5 flex items-center gap-2 text-[#0033A0]"><i className="fa-solid fa-sliders text-[#0033A0]"></i>Control Center</h2>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                      
                      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col gap-3">
                        <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Market Power</span>
                        <button onClick={toggleMarket}
                          className={`mt-auto py-3 rounded-xl text-sm font-black text-white shadow-md transition-transform active:scale-95 ${gameState.marketOpen ? 'bg-[#FF5000] shadow-[#FF5000]/20' : 'bg-[#00C805] shadow-[#00C805]/20'}`}>
                          {gameState.marketOpen ? '收盤 Close' : '開市 Open'}
                        </button>
                        <span className="text-[9px] font-bold text-slate-400 text-center">{!gameState.hasOpenedBefore ? '首次不扣款' : `扣 ${gameState.inflationRate ?? 2}% 通膨`}</span>
                      </div>
                      
                      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col gap-3">
                        <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Auto Tick</span>
                        <button onClick={() => updateDoc(gsDocRef(), { autoTick: !gameState.autoTick })}
                          className={`mt-auto py-3 rounded-xl text-sm font-black transition-all active:scale-95 ${gameState.autoTick ? 'bg-slate-900 text-white shadow-lg' : 'bg-slate-200 text-slate-500'}`}>
                          {gameState.autoTick ? '跳動中 ●' : '已暫停'}
                        </button>
                        <span className="text-[9px] font-bold text-slate-400 text-center">Batch Write / 20s</span>
                      </div>

                      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col justify-between">
                        <div className="mb-3">
                          <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">Fee (交易手續費率)</span>
                          <div className="flex items-center gap-1">
                            <button onClick={() => updateDoc(gsDocRef(), { feeRate: Math.max(0, (gameState.feeRate || 0) - 0.01) })} className="w-6 h-6 rounded-lg bg-slate-200 text-xs font-black hover:bg-slate-300 transition">−</button>
                            <span className="flex-1 text-center font-black text-sm text-[#0033A0]">{(gameState.feeRate || 0).toFixed(2)}%</span>
                            <button onClick={() => updateDoc(gsDocRef(), { feeRate: Math.min(10, (gameState.feeRate || 0) + 0.01) })} className="w-6 h-6 rounded-lg bg-slate-200 text-xs font-black hover:bg-slate-300 transition">+</button>
                          </div>
                        </div>
                        <div>
                          <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">Inflation (每次開市通膨率)</span>
                          <div className="flex items-center gap-1">
                            <button onClick={() => updateDoc(gsDocRef(), { inflationRate: Math.max(0, (gameState.inflationRate ?? 2) - 0.5) })} className="w-6 h-6 rounded-lg bg-slate-200 text-xs font-black hover:bg-slate-300 transition">−</button>
                            <span className="flex-1 text-center font-black text-sm text-rose-500">{(gameState.inflationRate ?? 2).toFixed(1)}%</span>
                            <button onClick={() => updateDoc(gsDocRef(), { inflationRate: Math.min(20, (gameState.inflationRate ?? 2) + 0.5) })} className="w-6 h-6 rounded-lg bg-slate-200 text-xs font-black hover:bg-slate-300 transition">+</button>
                          </div>
                        </div>
                      </div>

                      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col gap-3">
                        <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">System</span>
                        <button onClick={handleReset} className="mt-auto py-3 bg-red-100 text-red-600 rounded-xl text-sm font-black hover:bg-red-200 transition-colors">Factory Reset</button>
                      </div>
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 shadow-sm overflow-x-auto">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 border-b border-slate-100 pb-4">
                      <div>
                        <h3 className="text-lg font-black flex items-center gap-2 text-[#0033A0]"><i className="fa-solid fa-forward-step text-[#0033A0]"></i>回合控盤 (Round {gameState.currentRound})</h3>
                        <p className="text-[10px] font-bold text-slate-400 mt-1">⚠️ 點擊 Advance 時，將結算「已持有一回合以上」的空單。若總資產小於零將給予警告，連續兩回和小於零則強制破產平倉。</p>
                      </div>
                      <button onClick={handleAdvanceRound} className="bg-[#0033A0] hover:bg-[#002277] text-white px-5 py-3 rounded-xl text-sm font-black shadow-md shadow-[#0033A0]/20 transition-all active:scale-95 whitespace-nowrap">
                        Advance to Round {gameState.currentRound + 1}
                      </button>
                    </div>
                    <table className="w-full min-w-[700px] text-sm">
                      <thead className="text-[10px] text-slate-400 uppercase tracking-wider border-b border-slate-100">
                        <tr><th className="p-3 text-left font-black">Symbol</th><th className="p-3 text-right font-black">現價 (Live)</th><th className="p-3 text-right font-black text-[#0033A0]">基準價 (R{gameState.currentRound})</th><th className="p-3 text-center font-black w-24">即時波動率 (%)</th><th className="p-3 text-center font-black w-28 text-[#0033A0]">現行借券費 (%)</th><th className="p-3 text-right font-black w-32">收盤目標價 (R{gameState.currentRound+1})</th><th className="p-3 text-right font-black w-28 text-rose-500">下回合借券費 (%)</th></tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {stocks.map(stk => (
                          <tr key={stk.id} className="hover:bg-slate-50 transition-colors">
                            <td className="p-3 font-black">{stk.symbol} <span className="text-slate-400 font-normal text-xs ml-1">{stk.name}</span></td>
                            <td className="p-3 text-right"><AnimatedPrice price={getLastPrice(stk)} stockId={stk.id} size="text-sm" /></td>
                            <td className="p-3 text-right font-mono font-bold text-[#0033A0]">${fmt(getBasePrice(stk))}</td>
                            <td className="p-3">
                              <div className="flex items-center justify-center gap-1">
                                <button onClick={async () => {
                                  const val = Math.max(0.1, (stk.volatility ?? 5) - 0.5);
                                  const updated = stocksRef.current.map(s => s.id === stk.id ? { ...s, volatility: val } : s);
                                  await setDoc(bundleDocRef(), { stocks: updated, updatedAt: Date.now() });
                                }} className="w-6 h-6 rounded bg-slate-100 text-xs font-bold hover:bg-slate-200 transition">−</button>
                                <span className="w-10 text-center font-bold font-mono text-sm">{stk.volatility ?? 5}</span>
                                <button onClick={async () => {
                                  const val = Math.min(20, (stk.volatility ?? 5) + 0.5);
                                  const updated = stocksRef.current.map(s => s.id === stk.id ? { ...s, volatility: val } : s);
                                  await setDoc(bundleDocRef(), { stocks: updated, updatedAt: Date.now() });
                                }} className="w-6 h-6 rounded bg-slate-100 text-xs font-bold hover:bg-slate-200 transition">+</button>
                              </div>
                            </td>
                            <td className="p-3 text-center font-mono font-bold text-[#0033A0]">{(stk.borrowRate ?? 0).toFixed(1)}%</td>
                            <td className="p-3 text-right">
                              <input type="number"
                                className="w-24 bg-white border border-slate-200 rounded-lg p-2 font-bold text-sm outline-none focus:border-[#0033A0] focus:ring-2 focus:ring-[#0033A0]/20 text-right shadow-sm"
                                value={nextPrices[stk.id] ?? getLastPrice(stk)}
                                onChange={e => setNextPrices({ ...nextPrices, [stk.id]: parseFloat(e.target.value) || 0 })} />
                            </td>
                            <td className="p-3 text-right">
                              <input type="number"
                                className="w-20 bg-white border border-slate-200 rounded-lg p-2 font-bold text-sm outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 text-right shadow-sm text-rose-500"
                                value={nextBorrowRates[stk.id] ?? (stk.borrowRate ?? 0)}
                                onChange={e => setNextBorrowRates({ ...nextBorrowRates, [stk.id]: parseFloat(e.target.value) || 0 })} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 shadow-sm">
                    <h3 className="text-lg font-black mb-5 flex items-center gap-2"><i className="fa-solid fa-key text-emerald-500"></i>小隊 PIN 碼庫</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                      {teams.map(t => (
                        <div key={t.id} className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center hover:border-emerald-500/30 transition-colors">
                          <div className={`text-[10px] font-bold mb-1 truncate flex justify-center items-center gap-1 ${t.isBankrupt ? 'text-rose-500' : 'text-slate-400'}`}>
                            {t.name}
                          </div>
                          <div className="text-lg font-mono font-black text-emerald-600 tracking-wider">{t.password || '—'}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  <div className="bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 shadow-sm overflow-x-auto">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 border-b border-slate-100 pb-4">
                      <h3 className="text-lg font-black">Initial Database (重建設定)</h3>
                      <div className="flex gap-3 items-center">
                        <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl p-1.5 px-3">
                          <label className="text-[10px] font-black text-slate-400 uppercase">Teams</label>
                          <input type="number" value={draftTeamCount} onChange={e => setDraftTeamCount(parseInt(e.target.value) || 1)}
                            className="w-12 bg-transparent text-sm text-center font-black outline-none" />
                        </div>
                        <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl p-1.5 px-3">
                          <label className="text-[10px] font-black text-slate-400 uppercase">初始資金</label>
                          <input type="number" value={draftCash} onChange={e => setDraftCash(parseInt(e.target.value) || 0)}
                            className="w-20 bg-transparent text-sm text-center font-black outline-none" />
                        </div>
                        <button onClick={() => setDraftStocks([...draftStocks, { id: `STK_${Date.now()}`, symbol: 'NEW', name: 'New Stock', desc: '...', prices: [100], volatility: 5, borrowRate: 0 }])}
                          className="bg-slate-900 text-white px-4 py-2.5 rounded-xl text-xs font-black hover:opacity-80 transition whitespace-nowrap">+ Add Stock</button>
                      </div>
                    </div>
                    <table className="w-full min-w-[700px] text-sm">
                      <thead className="text-[10px] text-slate-400 uppercase tracking-wider border-b border-slate-100">
                        <tr><th className="p-2 text-left font-black w-24">Symbol</th><th className="p-2 text-left font-black w-32">名稱</th><th className="p-2 text-left font-black">描述</th><th className="p-2 text-center font-black w-20">初始價</th><th className="p-2 text-center font-black w-20">波動率(%)</th><th className="p-2 text-center font-black w-20 text-[#0033A0]">借券費率(%)</th><th className="p-2 w-8"></th></tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {draftStocks.map(stk => (
                          <tr key={stk.id}>
                            {['symbol','name','desc'].map(f => (
                              <td key={f} className="p-1.5">
                                <input type="text" value={stk[f] || ''}
                                  onChange={e => setDraftStocks(draftStocks.map(s => s.id === stk.id ? { ...s, [f]: e.target.value } : s))}
                                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs font-bold outline-none focus:border-[#0033A0] transition-all" />
                              </td>
                            ))}
                            <td className="p-1.5">
                              <input type="number" value={stk.prices?.[0] ?? 100}
                                onChange={e => setDraftStocks(draftStocks.map(s => s.id === stk.id ? { ...s, prices: [parseFloat(e.target.value) || 0] } : s))}
                                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-center font-black outline-none focus:border-[#0033A0]" />
                            </td>
                            <td className="p-1.5">
                              <input type="number" value={stk.volatility ?? 5}
                                onChange={e => setDraftStocks(draftStocks.map(s => s.id === stk.id ? { ...s, volatility: parseFloat(e.target.value) || 0 } : s))}
                                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-center font-black outline-none focus:border-[#0033A0]" />
                            </td>
                            <td className="p-1.5">
                              <input type="number" value={stk.borrowRate ?? 0}
                                onChange={e => setDraftStocks(draftStocks.map(s => s.id === stk.id ? { ...s, borrowRate: parseFloat(e.target.value) || 0 } : s))}
                                className="w-full bg-blue-50 border border-blue-200 rounded-lg p-2 text-xs text-center font-black outline-none focus:border-[#0033A0] text-blue-600" />
                            </td>
                            <td className="p-1.5 text-center">
                              <button onClick={() => draftStocks.length > 1 && setDraftStocks(draftStocks.filter(s => s.id !== stk.id))}
                                className="w-8 h-8 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"><i className="fa-solid fa-trash-can"></i></button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}