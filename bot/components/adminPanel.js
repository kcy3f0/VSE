import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { db } from '../database/storage.js';
import { STOCKS, TOTAL_ROUNDS } from '../config/marketData.js';
import { TeamService } from '../services/teamService.js';

export class AdminPanel {
  static buildPanel() {
    const gameState = db.getGameState();
    const teams = db.getTeams();
    const teamList = Object.values(teams);

    let stageText = '⚙️ 尚未開始 (SETUP)';
    if (gameState.stage === 'QUIZ') stageText = '🧩 闖關解題階段 (QUIZ)';
    if (gameState.stage === 'TRADING') stageText = '🟢 投資交易階段 (TRADING)';
    if (gameState.stage === 'SETTLED') stageText = '🏁 本期已結算 (SETTLED)';
    if (gameState.stage === 'ENDED') stageText = '🎉 遊戲全數結束 (ENDED)';

    let teamsSummary = '尚未註冊任何小隊，請使用 `/gm setup` 或點擊【小隊設置】。';
    if (teamList.length > 0) {
      teamsSummary = teamList.map(t => {
        const channelStr = t.channelId ? `<#${t.channelId}>` : '❌ 未綁定頻道';
        return `• **${t.name}** (${t.id})：${channelStr} | 現金 $${t.cash.toLocaleString()}`;
      }).join('\n');
    }

    const embed = new EmbedBuilder()
      .setTitle('🛡️ 2026 迎新股市模擬 — 關主總控台')
      .setColor(0x2c3e50)
      .setDescription(`歡迎使用關主總控台！請在此推進流程或發放獎勵。`)
      .addFields(
        { name: '📍 當前進度', value: `第 **${gameState.round}** / ${TOTAL_ROUNDS} 期`, inline: true },
        { name: '🚦 遊戲階段', value: `**${stageText}**`, inline: true },
        { name: '👥 小隊數量', value: `${teamList.length} 隊`, inline: true },
        { name: '📋 小隊名冊與綁定頻道', value: teamsSummary, inline: false }
      )
      .setFooter({ text: '管理員控場系統 • 請勿洩漏給學員' })
      .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('admin_btn_start_quiz')
        .setLabel('🧩 開始本期闖關解題')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('admin_btn_start_trading')
        .setLabel('🟢 開啟 5 分鐘投資交易')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('admin_btn_settle')
        .setLabel('🛑 關閉市場並結算')
        .setStyle(ButtonStyle.Danger)
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('admin_btn_give_cash')
        .setLabel('💵 發放資金獎勵')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('admin_btn_give_hint')
        .setLabel('💡 發放市場提示')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('admin_btn_view_ranks')
        .setLabel('🏆 查看全場總排名')
        .setStyle(ButtonStyle.Primary)
    );

    return { embeds: [embed], components: [row1, row2] };
  }

  // 關主查看全場即時總榜 Embed
  static buildLeaderboardEmbed() {
    const gameState = db.getGameState();
    const round = gameState.round;
    const teams = Object.values(db.getTeams());

    if (teams.length === 0) {
      return new EmbedBuilder()
        .setTitle('🏆 全場小隊排行榜')
        .setDescription('目前尚未有小隊資料。');
    }

    const overviews = teams.map(t => TeamService.getPortfolioOverview(t.id, round));
    overviews.sort((a, b) => b.totalAsset - a.totalAsset);

    const lines = overviews.map((o, idx) => {
      const rankEmoji = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `**#${idx + 1}**`;
      const holdingsDetail = o.holdings.length > 0
        ? o.holdings.map(h => `${h.stockId}:${h.shares}`).join(', ')
        : '無股票';
      return `${rankEmoji} **${o.teamName}**：總資產 **$${o.totalAsset.toLocaleString()}** (現金: $${o.cash.toLocaleString()} | 市值: $${o.totalStockValue.toLocaleString()})\n持股: \`${holdingsDetail}\``;
    }).join('\n\n');

    return new EmbedBuilder()
      .setTitle(`🏆 全場即時總榜 (第 ${round} 期 - 僅關主可見)`)
      .setColor(0xf39c12)
      .setDescription(lines)
      .setFooter({ text: '依總資產 (現金 + 股票現值) 即時排序' })
      .setTimestamp();
  }

  // 關主發放資金 Modal
  static buildGiveCashModal() {
    const modal = new ModalBuilder()
      .setCustomId('modal_admin_give_cash')
      .setTitle('發放闖關解題資金');

    const teamInput = new TextInputBuilder()
      .setCustomId('team_id_input')
      .setLabel('小隊代號 (例如: team_1 或第 1 小隊代碼)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const amountInput = new TextInputBuilder()
      .setCustomId('amount_input')
      .setLabel('發放金額 (數字，例如: 10000)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const reasonInput = new TextInputBuilder()
      .setCustomId('reason_input')
      .setLabel('事由 (例如: 闖關第 1 題答對獎勵)')
      .setStyle(TextInputStyle.Short)
      .setValue('闖關解題獎勵資金')
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(teamInput),
      new ActionRowBuilder().addComponents(amountInput),
      new ActionRowBuilder().addComponents(reasonInput)
    );
    return modal;
  }

  // 關主發放提示 Select Menu (選擇小隊與公司)
  static buildSelectTeamForHint() {
    const teams = Object.values(db.getTeams());
    if (teams.length === 0) return null;

    const options = teams.map(t => ({
      label: t.name,
      description: `代號: ${t.id}`,
      value: t.id
    }));

    const select = new StringSelectMenuBuilder()
      .setCustomId('admin_select_team_hint')
      .setPlaceholder('請選擇要發放提示的小隊')
      .addOptions(options);

    return new ActionRowBuilder().addComponents(select);
  }

  static buildSelectStockForHint(teamId) {
    const options = Object.values(STOCKS).map(s => ({
      label: `${s.id} - ${s.name}`,
      description: `${s.sector}`,
      value: `${teamId}:${s.id}`
    }));

    const select = new StringSelectMenuBuilder()
      .setCustomId('admin_select_stock_hint')
      .setPlaceholder('請選擇要發放的市場提示公司')
      .addOptions(options);

    return new ActionRowBuilder().addComponents(select);
  }
}
