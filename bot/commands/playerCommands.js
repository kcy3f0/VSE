import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { STOCKS } from '../config/marketData.js';
import { db } from '../database/storage.js';
import { GameEngine } from '../services/gameEngine.js';
import { TeamService } from '../services/teamService.js';
import { TradePanel } from '../components/tradePanel.js';

export const playerSlashCommands = [
  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('買入股票')
    .addStringOption(opt =>
      opt.setName('stock')
        .setDescription('股票代碼 (T, M, F, B, S, D, O, J)')
        .setRequired(true)
        .addChoices(
          { name: 'T - 台積電', value: 'T' },
          { name: 'M - 旺宏', value: 'M' },
          { name: 'F - 富邦科技', value: 'F' },
          { name: 'B - 八方雲集', value: 'B' },
          { name: 'S - 台鹽', value: 'S' },
          { name: 'D - 東聯', value: 'D' },
          { name: 'O - 一零四', value: 'O' },
          { name: 'J - 京城銀行', value: 'J' }
        )
    )
    .addIntegerOption(opt =>
      opt.setName('shares')
        .setDescription('欲買入股數 (正整數，例如: 100)')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('sell')
    .setDescription('賣出持有的股票')
    .addStringOption(opt =>
      opt.setName('stock')
        .setDescription('股票代碼 (T, M, F, B, S, D, O, J)')
        .setRequired(true)
        .addChoices(
          { name: 'T - 台積電', value: 'T' },
          { name: 'M - 旺宏', value: 'M' },
          { name: 'F - 富邦科技', value: 'F' },
          { name: 'B - 八方雲集', value: 'B' },
          { name: 'S - 台鹽', value: 'S' },
          { name: 'D - 東聯', value: 'D' },
          { name: 'O - 一零四', value: 'O' },
          { name: 'J - 京城銀行', value: 'J' }
        )
    )
    .addIntegerOption(opt =>
      opt.setName('shares')
        .setDescription('欲賣出股數 (正整數，例如: 100)')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('portfolio')
    .setDescription('查看小隊當前持股明細、現金與預估總資產'),

  new SlashCommandBuilder()
    .setName('hints')
    .setDescription('查看小隊目前已解鎖的所有闖關市場提示'),

  new SlashCommandBuilder()
    .setName('market')
    .setDescription('查看當期市場行情資訊與走勢看板')
];

// 小隊指令執行邏輯
export async function handlePlayerCommand(interaction) {
  const channelId = interaction.channelId;
  const team = db.getTeamByChannel(channelId);

  if (!team) {
    return interaction.reply({
      content: '⚠️ 本文字頻道尚未綁定任何小隊！請洽詢關主使用 `/gm bind` 進行綁定。',
      ephemeral: true
    });
  }

  const { commandName } = interaction;

  if (commandName === 'buy' || commandName === 'sell') {
    const stockId = interaction.options.getString('stock');
    const shares = interaction.options.getInteger('shares');
    const type = commandName.toUpperCase();

    try {
      const result = GameEngine.executeTrade(team.id, type, stockId, shares);
      const actionText = type === 'BUY' ? '買入' : '賣出';
      const embed = new EmbedBuilder()
        .setTitle(`✅ 【交易成功】${actionText} ${shares.toLocaleString()} 股 ${result.stock.name}`)
        .setColor(type === 'BUY' ? 0x2ecc71 : 0xe74c3c)
        .addFields(
          { name: '成交單價', value: `$${result.currentPrice.toFixed(2)}`, inline: true },
          { name: '總金額', value: `$${result.totalCost.toLocaleString()}`, inline: true },
          { name: '交易後現金', value: `$${result.newCash.toLocaleString()}`, inline: true },
          { name: '當前持股數量', value: `${result.newHolding.toLocaleString()} 股`, inline: true }
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
  }

  if (commandName === 'portfolio') {
    const gameState = db.getGameState();
    const overview = TeamService.getPortfolioOverview(team.id, gameState.round);

    let holdingsStr = '目前無任何股票持倉。';
    if (overview.holdings.length > 0) {
      holdingsStr = overview.holdings.map(h => {
        const val = h.isDelisted ? '0 (已下市)' : `$${h.totalValue.toLocaleString()}`;
        return `• **${h.name}**：${h.shares.toLocaleString()} 股 (現價 $${h.currentPrice.toFixed(2)}，總值 ${val})`;
      }).join('\n');
    }

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${overview.teamName} 資產庫存表 (第 ${overview.round} 期)`)
      .setColor(0x3498db)
      .addFields(
        { name: '💰 可用現金', value: `$${overview.cash.toLocaleString()}`, inline: true },
        { name: '📈 股票總市值', value: `$${overview.totalStockValue.toLocaleString()}`, inline: true },
        { name: '🏦 預估總資產', value: `$${overview.totalAsset.toLocaleString()}`, inline: true },
        { name: '📦 持股明細', value: holdingsStr, inline: false }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'hints') {
    const hints = TeamService.getUnlockedHints(team.id);

    if (hints.length === 0) {
      return interaction.reply({
        content: '💡 目前尚未獲得任何市場提示！請在闖關解題階段答對並向關主索取提示。',
        ephemeral: true
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`💡 ${team.name} 已解鎖市場提示庫 (共 ${hints.length} 條)`)
      .setColor(0xf39c12)
      .setDescription(
        hints.map(h => `**【第 ${h.round} 期 • ${h.stockName}】**\n${h.content}`).join('\n\n')
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'market') {
    const panel = TradePanel.buildPanel(team.id);
    return interaction.reply(panel);
  }
}
