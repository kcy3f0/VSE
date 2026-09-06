import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { STOCKS } from '../config/marketData.js';
import { TeamService } from '../services/teamService.js';
import { db } from '../database/storage.js';

export class TradePanel {
  // 建立小隊交易 Embed 與按鈕
  static buildPanel(teamId) {
    const gameState = db.getGameState();
    const round = gameState.round;
    const overview = TeamService.getPortfolioOverview(teamId, round);

    // 格式化行情
    let stockLines = '';
    for (const [id, stock] of Object.entries(STOCKS)) {
      const price = stock.prices[round] ?? 0;
      const prevPrice = round > 1 ? (stock.prices[round - 1] ?? 0) : null;
      let diffStr = '';
      if (prevPrice !== null) {
        const diff = price - prevPrice;
        if (diff > 0) diffStr = `(🔺 +$${diff.toFixed(2)})`;
        else if (diff < 0) diffStr = `(🔻 -$${Math.abs(diff).toFixed(2)})`;
        else diffStr = `(➖ 平盤)`;
      }
      const isDelisted = stock.delistedInRound === round;
      const priceDisplay = isDelisted ? '【已下市】' : `$${price.toFixed(2)}`;
      stockLines += `\`${id}\` **${stock.shortName}**：${priceDisplay} ${diffStr}\n`;
    }

    // 格式化持有股票
    let holdingsStr = '無持股';
    if (overview.holdings.length > 0) {
      holdingsStr = overview.holdings.map(h => {
        const valueStr = h.isDelisted ? '0 (下市)' : `$${h.totalValue.toLocaleString()}`;
        return `• **${h.name}**：${h.shares.toLocaleString()} 股 (現值 ${valueStr})`;
      }).join('\n');
    }

    let stageName = '準備中';
    let stageColor = 0x95a5a6;
    if (gameState.stage === 'QUIZ') {
      stageName = '闖關解題階段 (市場休市中)';
      stageColor = 0xf1c40f;
    } else if (gameState.stage === 'TRADING') {
      stageName = '投資交易時間 (市場開盤中 🟢)';
      stageColor = 0x2ecc71;
    } else if (gameState.stage === 'SETTLED') {
      stageName = '本期結算完畢';
      stageColor = 0x3498db;
    } else if (gameState.stage === 'ENDED') {
      stageName = '競賽圓滿結束 🏆';
      stageColor = 0x9b59b6;
    }

    const embed = new EmbedBuilder()
      .setTitle(`📈 【第 ${round} 期】${overview.teamName} 交易終端機`)
      .setColor(stageColor)
      .setDescription(`目前狀態：**${stageName}**\n\n**當期市場行情**：\n${stockLines}`)
      .addFields(
        { name: '💰 可用現金', value: `$${overview.cash.toLocaleString()}`, inline: true },
        { name: '📊 股票現值', value: `$${overview.totalStockValue.toLocaleString()}`, inline: true },
        { name: '🏦 預估總資產', value: `$${overview.totalAsset.toLocaleString()}`, inline: true },
        { name: '📦 目前持倉庫存', value: holdingsStr, inline: false }
      )
      .setFooter({ text: '股市模擬交易系統 • 2026 迎新' })
      .setTimestamp();

    const isTrading = gameState.stage === 'TRADING';

    const rowButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`trade_open_buy:${teamId}`)
        .setLabel('💰 買入股票')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!isTrading),
      new ButtonBuilder()
        .setCustomId(`trade_open_sell:${teamId}`)
        .setLabel('💸 賣出股票')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!isTrading || overview.holdings.length === 0),
      new ButtonBuilder()
        .setCustomId(`trade_refresh:${teamId}`)
        .setLabel('🔄 刷新資訊')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`trade_hints:${teamId}`)
        .setLabel('💡 查看已獲提示')
        .setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [rowButtons] };
  }

  // 建立股票選擇選單 (買入)
  static buildBuyStockSelect(teamId) {
    const gameState = db.getGameState();
    const round = gameState.round;

    // 過濾出當期未下市之股票 (已下市無法買入，與賣出選單保持一致)
    const buyableStocks = Object.values(STOCKS).filter(stock => stock.delistedInRound !== round);

    const options = buyableStocks.map(stock => {
      const price = stock.prices[round] ?? 0;
      return {
        label: `${stock.id} - ${stock.name}`,
        description: `當期價格：$${price.toFixed(2)}`,
        value: stock.id
      };
    });

    const select = new StringSelectMenuBuilder()
      .setCustomId(`select_buy_stock:${teamId}`)
      .setPlaceholder('請選擇欲買入的股票代號')
      .addOptions(options);

    return new ActionRowBuilder().addComponents(select);
  }

  // 建立股票選擇選單 (賣出)
  static buildSellStockSelect(teamId) {
    const gameState = db.getGameState();
    const round = gameState.round;
    const team = db.getTeam(teamId);
    const portfolio = team.portfolio || {};

    // 過濾出尚有持股且當期未下市之股票 (已下市無法賣出，解決 H1)
    const sellableStockIds = Object.keys(portfolio).filter(id => {
      const stock = STOCKS[id];
      return portfolio[id] > 0 && stock && stock.delistedInRound !== round;
    });

    if (sellableStockIds.length === 0) {
      return null;
    }

    const options = sellableStockIds.map(id => {
      const stock = STOCKS[id];
      const shares = portfolio[id];
      const price = stock.prices[round] ?? 0;
      return {
        label: `${stock.id} - ${stock.name}`,
        description: `持有 ${shares} 股，現價 $${price.toFixed(2)}`,
        value: stock.id
      };
    });

    const select = new StringSelectMenuBuilder()
      .setCustomId(`select_sell_stock:${teamId}`)
      .setPlaceholder('請選擇欲賣出的股票代號')
      .addOptions(options);

    return new ActionRowBuilder().addComponents(select);
  }

  // 建立輸入股數彈跳視窗 (Modal)
  static buildTradeModal(type, stockId, teamId) {
    const stock = STOCKS[stockId];
    const modal = new ModalBuilder()
      .setCustomId(`modal_trade:${type}:${stockId}:${teamId}`)
      .setTitle(`${type === 'BUY' ? '買入' : '賣出'} - ${stock.name}`);

    const sharesInput = new TextInputBuilder()
      .setCustomId('shares_input')
      .setLabel('請輸入交易股數 (正整數，例如: 100)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('例如：50')
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(10);

    const firstActionRow = new ActionRowBuilder().addComponents(sharesInput);
    modal.addComponents(firstActionRow);
    return modal;
  }
}
