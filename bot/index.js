import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import { db } from './database/storage.js';
import { STOCKS } from './config/marketData.js';
import { GameEngine } from './services/gameEngine.js';
import { TeamService } from './services/teamService.js';
import { TradePanel } from './components/tradePanel.js';
import { AdminPanel } from './components/adminPanel.js';
import { handlePlayerCommand } from './commands/playerCommands.js';
import { handleAdminCommand } from './commands/adminCommands.js';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`========================================`);
  console.log(`🤖 股市模擬機器人已上線！登入身分：${client.user.tag}`);
  console.log(`目前遊戲狀態：第 ${db.getGameState().round} 期 | 階段：${db.getGameState().stage}`);
  console.log(`========================================`);
});

// 互動事件監聽 (Slash Commands, Buttons, Menus, Modals)
client.on('interactionCreate', async (interaction) => {
  try {
    // 1. 斜線指令 (Slash Commands)
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'gm') {
        return await handleAdminCommand(interaction, client);
      } else {
        return await handlePlayerCommand(interaction);
      }
    }

    // 2. 按鈕點擊 (Buttons)
    if (interaction.isButton()) {
      const customId = interaction.customId;

      // 小隊交易面板按鈕
      if (customId.startsWith('trade_open_buy:')) {
        const teamId = customId.split(':')[1];
        const selectRow = TradePanel.buildBuyStockSelect(teamId);
        return interaction.reply({
          content: '請從下方選單選擇您要買入的股票代號：',
          components: [selectRow],
          ephemeral: true
        });
      }

      if (customId.startsWith('trade_open_sell:')) {
        const teamId = customId.split(':')[1];
        const selectRow = TradePanel.buildSellStockSelect(teamId);
        if (!selectRow) {
          return interaction.reply({ content: '您目前沒有持有任何可賣出的股票！', ephemeral: true });
        }
        return interaction.reply({
          content: '請從下方選單選擇您要賣出的股票代號：',
          components: [selectRow],
          ephemeral: true
        });
      }

      if (customId.startsWith('trade_refresh:')) {
        const teamId = customId.split(':')[1];
        const panel = TradePanel.buildPanel(teamId);
        return interaction.update(panel);
      }

      if (customId.startsWith('trade_hints:')) {
        const teamId = customId.split(':')[1];
        const team = db.getTeam(teamId);
        const hints = TeamService.getUnlockedHints(teamId);
        if (hints.length === 0) {
          return interaction.reply({
            content: '💡 目前尚未獲得任何市場情報！請在解題階段向關主索取。',
            ephemeral: true
          });
        }
        const embed = new EmbedBuilder()
          .setTitle(`💡 ${team.name} 已解鎖情報庫`)
          .setColor(0xf39c12)
          .setDescription(hints.map(h => `**【第 ${h.round} 期 • ${h.stockName}】**\n${h.content}`).join('\n\n'));
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // 關主控制台按鈕
      if (customId === 'admin_btn_start_quiz') {
        const currentRound = db.getGameState().round;
        GameEngine.startQuizStage(currentRound);
        return interaction.reply({
          content: `📢 **【第 ${currentRound} 期 • 闖關解題階段已開啟】** (市場休市)`,
          ephemeral: true
        });
      }

      if (customId === 'admin_btn_start_trading') {
        const currentRound = db.getGameState().round;
        GameEngine.startTradingStage(
          300,
          async (remainingSec) => {
            const teams = Object.values(db.getTeams());
            for (const t of teams) {
              if (t.channelId) {
                const ch = await client.channels.fetch(t.channelId).catch(() => null);
                if (ch) ch.send(`⏰ **【投資時間提醒】** 剩餘最後 **${remainingSec}** 秒！`);
              }
            }
          },
          async () => {
            const teams = Object.values(db.getTeams());
            for (const t of teams) {
              if (t.channelId) {
                const ch = await client.channels.fetch(t.channelId).catch(() => null);
                if (ch) ch.send(`🛑 **【投資時間截止】** 市場已停止交易，等候結算！`);
              }
            }
          }
        );

        // 推播交易面板到各隊頻道
        const teams = Object.values(db.getTeams());
        for (const t of teams) {
          if (t.channelId) {
            const ch = await client.channels.fetch(t.channelId).catch(() => null);
            if (ch) {
              const panel = TradePanel.buildPanel(t.id);
              await ch.send({
                content: `🟢 **【第 ${currentRound} 期 • 5分鐘投資時間開始！】**`,
                ...panel
              }).catch(console.error);
            }
          }
        }

        return interaction.reply({
          content: `🟢 **【第 ${currentRound} 期 • 5 分鐘投資交易已開啟！】** 已推播至各隊頻道並啟動倒數。`,
          ephemeral: true
        });
      }

      if (customId === 'admin_btn_settle') {
        const settleResult = GameEngine.settleRound();
        const { round, isLastRound, settlementData } = settleResult;

        for (const item of settlementData.rankings) {
          if (item.channelId) {
            const ch = await client.channels.fetch(item.channelId).catch(() => null);
            if (ch) {
              const embed = new EmbedBuilder()
                .setTitle(`🏁 【第 ${round} 期結算戰報】${item.teamName}`)
                .setColor(0xf1c40f)
                .addFields(
                  { name: '💰 結算現金', value: `$${item.cash.toLocaleString()}`, inline: true },
                  { name: '📈 股票庫存市值', value: `$${item.stockValue.toLocaleString()}`, inline: true },
                  { name: '🏦 總資產', value: `**$${item.totalAsset.toLocaleString()}**`, inline: true },
                  { name: '🏆 當輪排名', value: `第 **${item.rank}** 名 (共 ${settlementData.totalTeams} 隊)`, inline: false }
                )
                .setFooter({ text: '依規則：其餘各隊詳細資產不公開。' })
                .setTimestamp();
              await ch.send({ embeds: [embed] }).catch(console.error);
            }
          }
        }

        return interaction.reply({
          content: `🏁 **【第 ${round} 期結算完畢】**！已私密發送成績至各隊頻道。${isLastRound ? '（全 4 期完結）' : ''}`,
          ephemeral: true
        });
      }

      if (customId === 'admin_btn_give_cash') {
        const modal = AdminPanel.buildGiveCashModal();
        return interaction.showModal(modal);
      }

      if (customId === 'admin_btn_give_hint') {
        const teamSelectRow = AdminPanel.buildSelectTeamForHint();
        if (!teamSelectRow) {
          return interaction.reply({ content: '尚未建立任何小隊！請先執行 `/gm setup`。', ephemeral: true });
        }
        return interaction.reply({
          content: '請選擇欲獲得情報的小隊：',
          components: [teamSelectRow],
          ephemeral: true
        });
      }

      if (customId === 'admin_btn_view_ranks') {
        const embed = AdminPanel.buildLeaderboardEmbed();
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
    }

    // 3. 下拉選單選擇 (StringSelectMenu)
    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;

      // 小隊選好買入股票
      if (customId.startsWith('select_buy_stock:')) {
        const teamId = customId.split(':')[1];
        const stockId = interaction.values[0];
        const modal = TradePanel.buildTradeModal('BUY', stockId, teamId);
        return interaction.showModal(modal);
      }

      // 小隊選好賣出股票
      if (customId.startsWith('select_sell_stock:')) {
        const teamId = customId.split(':')[1];
        const stockId = interaction.values[0];
        const modal = TradePanel.buildTradeModal('SELL', stockId, teamId);
        return interaction.showModal(modal);
      }

      // 關主發放提示：第一步選好小隊
      if (customId === 'admin_select_team_hint') {
        const teamId = interaction.values[0];
        const team = db.getTeam(teamId);
        const stockSelectRow = AdminPanel.buildSelectStockForHint(teamId);
        return interaction.update({
          content: `已選擇小隊：**${team.name}**。請選擇要發放的市場提示公司：`,
          components: [stockSelectRow]
        });
      }

      // 關主發放提示：第二步選好公司
      if (customId === 'admin_select_stock_hint') {
        const [teamId, stockId] = interaction.values[0].split(':');
        const round = db.getGameState().round;
        const result = TeamService.unlockHint(teamId, round, stockId);
        const team = db.getTeam(teamId);

        if (team.channelId) {
          const ch = await client.channels.fetch(team.channelId).catch(() => null);
          if (ch) {
            const embed = new EmbedBuilder()
              .setTitle(`💡 【獲得市場情報】第 ${round} 期 • ${result.stock.name}`)
              .setColor(0xf39c12)
              .setDescription(result.hint.content)
              .setFooter({ text: '此為貴隊專屬情報，請妥善規劃投資策略！' })
              .setTimestamp();
            ch.send({ content: '📬 **【獲得新情報】** 關主發送了市場提示：', embeds: [embed] });
          }
        }

        return interaction.update({
          content: `✅ 已成功發放第 **${round}** 期 **${result.stock.name}** 提示給 **${team.name}**！`,
          components: []
        });
      }
    }

    // 4. 彈窗送出 (ModalSubmit)
    if (interaction.isModalSubmit()) {
      const customId = interaction.customId;

      // 小隊交易 Modal
      if (customId.startsWith('modal_trade:')) {
        const [, type, stockId, teamId] = customId.split(':');
        const sharesRaw = interaction.fields.getTextInputValue('shares_input').trim();
        const shares = parseInt(sharesRaw, 10);

        if (isNaN(shares) || shares <= 0) {
          return interaction.reply({ content: '❌ 請輸入有效的正整數股數！', ephemeral: true });
        }

        try {
          const result = GameEngine.executeTrade(teamId, type, stockId, shares);
          const actionText = type === 'BUY' ? '買入' : '賣出';
          const embed = new EmbedBuilder()
            .setTitle(`✅ 【交易成功】${actionText} ${shares.toLocaleString()} 股 ${result.stock.name}`)
            .setColor(type === 'BUY' ? 0x2ecc71 : 0xe74c3c)
            .addFields(
              { name: '成交單價', value: `$${result.currentPrice.toFixed(2)}`, inline: true },
              { name: '成交總額', value: `$${result.totalCost.toLocaleString()}`, inline: true },
              { name: '交易後現金', value: `$${result.newCash.toLocaleString()}`, inline: true },
              { name: '目前該股庫存', value: `${result.newHolding.toLocaleString()} 股`, inline: true }
            )
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        } catch (err) {
          return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
      }

      // 關主發放現金 Modal
      if (customId === 'modal_admin_give_cash') {
        const teamId = interaction.fields.getTextInputValue('team_id_input').trim();
        const amountRaw = interaction.fields.getTextInputValue('amount_input').trim();
        const reason = interaction.fields.getTextInputValue('reason_input').trim() || '關主發放資金';
        const amount = parseInt(amountRaw, 10);

        if (isNaN(amount) || amount <= 0) {
          return interaction.reply({ content: '❌ 發放金額必須為大於 0 的整數！', ephemeral: true });
        }

        try {
          const result = TeamService.addCash(teamId, amount, reason);
          const team = result.team;

          if (team.channelId) {
            const ch = await client.channels.fetch(team.channelId).catch(() => null);
            if (ch) {
              ch.send(`🎁 **【獎勵入帳】** 關主發放資金 **+$${amount.toLocaleString()}**！(事由: ${reason})\n目前現金餘額：**$${result.newCash.toLocaleString()}**`);
            }
          }

          return interaction.reply({
            content: `✅ 已成功發放 **$${amount.toLocaleString()}** 給 **${team.name}**！目前該隊現金：$${result.newCash.toLocaleString()}`,
            ephemeral: true
          });
        } catch (err) {
          return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
      }
    }
  } catch (error) {
    console.error('處理互動時發生例外錯誤：', error);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: `❌ 處理請求時發生錯誤：${error.message}`, ephemeral: true }).catch(() => {});
    }
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.warn('⚠️ 未在 .env 檔案中偵測到 DISCORD_TOKEN！請配置後再啟動機器人。');
} else {
  client.login(token).catch(err => {
    console.error('❌ 機器人登入 Discord 失敗：', err.message);
  });
}
