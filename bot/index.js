import { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import dotenv from 'dotenv';
import { db } from './database/storage.js';
import { STOCKS } from './config/marketData.js';
import { GameEngine } from './services/gameEngine.js';
import { TeamService } from './services/teamService.js';
import { TradePanel } from './components/tradePanel.js';
import { AdminPanel } from './components/adminPanel.js';
import { handlePlayerCommand } from './commands/playerCommands.js';
import { handleAdminCommand } from './commands/adminCommands.js';
import { teamMutex } from './utils/security.js';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  const gameState = db.getGameState();
  console.log(`========================================`);
  console.log(`🤖 股市模擬機器人已上線！登入身分：${client.user.tag}`);
  console.log(`目前遊戲狀態：第 ${gameState.round} 期 | 階段：${gameState.stage}`);

  // 開機健全檢查：若處於 TRADING 但時間已過期，印出警示 (中風險 3)
  if (gameState.stage === 'TRADING' && gameState.tradingEndsAt && Date.now() > gameState.tradingEndsAt) {
    console.warn(`⚠️ [GameEngine] 偵測到第 ${gameState.round} 期 5 分鐘投資時間已逾期截止，市場關閉等候關主結算。`);
  }
  console.log(`========================================`);
});

/**
 * 檢查互動發起者是否擁有管理員權限 (關主防護 C4)
 */
function checkAdminPermission(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    interaction.reply({
      content: '❌ 權限不足：僅有伺服器管理員/關主可操作控制台！',
      ephemeral: true
    }).catch(() => {});
    return false;
  }
  return true;
}

/**
 * 檢查小隊頻道歸屬與合法性 (小隊防護 C4)
 */
function checkTeamChannel(interaction, teamId) {
  const team = db.getTeam(teamId);
  if (!team) {
    interaction.reply({ content: `❌ 找不到指定小隊（代號：${teamId}）！`, ephemeral: true }).catch(() => {});
    return null;
  }
  if (!team.channelId) {
    interaction.reply({
      content: `❌ 操作被拒絕：**${team.name}** 尚未綁定至任何專屬文字頻道！請聯繫關主使用 \`/gm bind\` 進行綁定。`,
      ephemeral: true
    }).catch(() => {});
    return null;
  }
  if (team.channelId !== interaction.channelId) {
    interaction.reply({
      content: `❌ 操作被拒絕：此操作僅限於 **${team.name}** 的專屬頻道 (<#${team.channelId}>) 中執行！`,
      ephemeral: true
    }).catch(() => {});
    return null;
  }
  return team;
}

// 互動事件監聽 (Slash Commands, Buttons, Menus, Modals)
client.on('interactionCreate', async (interaction) => {
  try {
    // 1. 斜線指令 (Slash Commands)
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'gm') {
        if (!checkAdminPermission(interaction)) return;
        return await handleAdminCommand(interaction, client);
      } else {
        return await handlePlayerCommand(interaction);
      }
    }

    // 2. 按鈕點擊 (Buttons)
    if (interaction.isButton()) {
      const customId = interaction.customId;

      // --- 小隊交易面板按鈕 (嚴格驗證頻道歸屬 C4) ---
      if (customId.startsWith('trade_open_buy:')) {
        const teamId = customId.split(':')[1];
        const team = checkTeamChannel(interaction, teamId);
        if (!team) return;

        const selectRow = TradePanel.buildBuyStockSelect(teamId);
        return interaction.reply({
          content: '請從下方選單選擇您要買入的股票代號：',
          components: [selectRow],
          ephemeral: true
        });
      }

      if (customId.startsWith('trade_open_sell:')) {
        const teamId = customId.split(':')[1];
        const team = checkTeamChannel(interaction, teamId);
        if (!team) return;

        const selectRow = TradePanel.buildSellStockSelect(teamId);
        if (!selectRow) {
          return interaction.reply({ content: '您目前沒有持有任何可賣出的股票！（若為第四期已下市股票則無法賣出）', ephemeral: true });
        }
        return interaction.reply({
          content: '請從下方選單選擇您要賣出的股票代號：',
          components: [selectRow],
          ephemeral: true
        });
      }

      if (customId.startsWith('trade_refresh:')) {
        const teamId = customId.split(':')[1];
        const team = checkTeamChannel(interaction, teamId);
        if (!team) return;

        const panel = TradePanel.buildPanel(teamId);
        return interaction.update(panel);
      }

      if (customId.startsWith('trade_hints:')) {
        const teamId = customId.split(':')[1];
        const team = checkTeamChannel(interaction, teamId);
        if (!team) return;

        const hints = TeamService.getUnlockedHints(teamId);
        if (hints.length === 0) {
          return interaction.reply({
            content: '💡 目前尚未獲得任何市場情報！請在解題階段向關主索取。',
            ephemeral: true
          });
        }
        // 防範 Embed description 突破 Discord 4096 字元上限 (中風險 5)
        let fullContent = hints.map(h => `**【第 ${h.round} 期 • ${h.stockName}】**\n${h.content}`).join('\n\n');
        if (fullContent.length > 3800) {
          fullContent = fullContent.substring(0, 3800) + '\n\n...（情報字數過長，其餘內容已省略，請洽關主查閱）';
        }

        const embed = new EmbedBuilder()
          .setTitle(`💡 ${team.name} 已解鎖情報庫 (共 ${hints.length} 條)`)
          .setColor(0xf39c12)
          .setDescription(fullContent);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // --- 關主控制台按鈕 (嚴格驗證關主身分 C4) ---
      if (customId.startsWith('admin_btn_')) {
        if (!checkAdminPermission(interaction)) return;
      }

      if (customId === 'admin_btn_start_quiz') {
        try {
          const newGameState = GameEngine.startQuizStage();
          const currentRound = newGameState.round;
          return interaction.reply({
            content: `📢 **【第 ${currentRound} 期 • 闖關解題階段已開啟】** (市場休市)`,
            ephemeral: true
          });
        } catch (err) {
          return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
      }

      if (customId === 'admin_btn_start_trading') {
        // 延遲響應防止多頻道推播超過 3 秒 (H3 防護)
        await interaction.deferReply({ ephemeral: true });

        try {
          const tradingResult = GameEngine.startTradingStage(
            300,
            async (remainingSec) => {
              const teams = Object.values(db.getTeams());
              for (const t of teams) {
                if (t.channelId) {
                  const ch = await client.channels.fetch(t.channelId).catch(() => null);
                  if (ch) {
                    await ch.send({
                      content: `⏰ **【投資時間提醒】** 剩餘最後 **${remainingSec}** 秒！`,
                      allowedMentions: { parse: [] }
                    }).catch(console.error);
                  }
                }
              }
            },
            async () => {
              const teams = Object.values(db.getTeams());
              for (const t of teams) {
                if (t.channelId) {
                  const ch = await client.channels.fetch(t.channelId).catch(() => null);
                  if (ch) {
                    await ch.send({
                      content: `🛑 **【投資時間截止】** 市場已停止交易，等候結算！`,
                      allowedMentions: { parse: [] }
                    }).catch(console.error);
                  }
                }
              }
            }
          );

          const currentRound = tradingResult.gameState.round;

        // 推播交易面板到各隊頻道
        const teams = Object.values(db.getTeams());
        for (const t of teams) {
          if (t.channelId) {
            const ch = await client.channels.fetch(t.channelId).catch(() => null);
            if (ch) {
              const panel = TradePanel.buildPanel(t.id);
              await ch.send({
                content: `🟢 **【第 ${currentRound} 期 • 5分鐘投資時間開始！】**`,
                ...panel,
                allowedMentions: { parse: [] }
              }).catch(console.error);
            }
          }
        }

        return interaction.editReply({
          content: `🟢 **【第 ${currentRound} 期 • 5 分鐘投資交易已開啟！】** 已推播至各隊頻道並啟動倒數。`
        });
      } catch (err) {
        return interaction.editReply({ content: `❌ ${err.message}` });
      }
    }

      if (customId === 'admin_btn_settle') {
        // 延遲響應防止多隊戰報發送逾時 (H3 防護)
        await interaction.deferReply({ ephemeral: true });

        try {
          // 使用全域互斥鎖，阻斷結算與交易之並發競態 (中風險 1)
          const settleResult = await teamMutex.runGlobal(async () => {
            return GameEngine.settleRound();
          });
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
                await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(console.error);
              }
            }
          }

          return interaction.editReply({
            content: `🏁 **【第 ${round} 期結算完畢】**！已私密發送成績至各隊頻道。${isLastRound ? '（全 4 期完結）' : ''}`
          });
        } catch (err) {
          // 完整捕獲錯誤並通知關主，防止卡在「正在思考...」(H2)
          return interaction.editReply({ content: `❌ 結算失敗：${err.message}` });
        }
      }

      if (customId === 'admin_btn_give_cash') {
        const modal = AdminPanel.buildGiveCashModal();
        return interaction.showModal(modal);
      }

      if (customId === 'admin_btn_give_hint') {
        const gameState = db.getGameState();
        if (gameState.stage !== 'QUIZ') {
          return interaction.reply({
            content: '⚠️ 依規則，市場提示僅能在「闖關解題階段 (QUIZ)」發放！目前階段為 ' + gameState.stage,
            ephemeral: true
          });
        }

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

      // 小隊選好買入股票 (驗證頻道歸屬 C4)
      if (customId.startsWith('select_buy_stock:')) {
        const teamId = customId.split(':')[1];
        const team = checkTeamChannel(interaction, teamId);
        if (!team) return;

        const stockId = interaction.values[0];
        const modal = TradePanel.buildTradeModal('BUY', stockId, teamId);
        return interaction.showModal(modal);
      }

      // 小隊選好賣出股票 (驗證頻道歸屬 C4)
      if (customId.startsWith('select_sell_stock:')) {
        const teamId = customId.split(':')[1];
        const team = checkTeamChannel(interaction, teamId);
        if (!team) return;

        const stockId = interaction.values[0];
        const modal = TradePanel.buildTradeModal('SELL', stockId, teamId);
        return interaction.showModal(modal);
      }

      // 關主發放提示選單 (驗證關主身分 C4)
      if (customId === 'admin_select_team_hint') {
        if (!checkAdminPermission(interaction)) return;

        const teamId = interaction.values[0];
        const team = db.getTeam(teamId);
        const stockSelectRow = AdminPanel.buildSelectStockForHint(teamId);
        return interaction.update({
          content: `已選擇小隊：**${team.name}**。請選擇要發放的市場提示公司：`,
          components: [stockSelectRow]
        });
      }

      if (customId === 'admin_select_stock_hint') {
        if (!checkAdminPermission(interaction)) return;

        const [teamId, stockId] = interaction.values[0].split(':');
        const round = db.getGameState().round;

        try {
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
              await ch.send({
                content: '📬 **【獲得新情報】** 關主發送了市場提示：',
                embeds: [embed],
                allowedMentions: { parse: [] }
              });
            }
          }

          return interaction.update({
            content: `✅ 已成功發放第 **${round}** 期 **${result.stock.name}** 提示給 **${team.name}**！`,
            components: []
          });
        } catch (err) {
          return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
      }
    }

    // 4. 彈窗送出 (ModalSubmit)
    if (interaction.isModalSubmit()) {
      const customId = interaction.customId;

      // 小隊交易 Modal (驗證頻道歸屬 C4 與互斥鎖 C3)
      if (customId.startsWith('modal_trade:')) {
        const [, type, stockId, teamId] = customId.split(':');
        const team = checkTeamChannel(interaction, teamId);
        if (!team) return;

        const sharesRaw = interaction.fields.getTextInputValue('shares_input').trim();

        // 嚴格整數正則校驗，杜絕 10.9 或 10abc 截斷靜默成交 (中風險 6)
        if (!/^\d+$/.test(sharesRaw)) {
          return interaction.reply({ content: '❌ 請輸入有效的正整數股數（不可包含小數點、符號或文字）！', ephemeral: true });
        }

        const shares = parseInt(sharesRaw, 10);
        if (shares <= 0 || shares > 10000000) {
          return interaction.reply({ content: '❌ 請輸入大於 0 且在合理範圍內的整數股數！', ephemeral: true });
        }

        try {
          // 使用 teamMutex 鎖定隊伍並發撮合 (解決 C3)
          const result = await teamMutex.runExclusive(teamId, async () => {
            return GameEngine.executeTrade(teamId, type, stockId, shares);
          });

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

      // 關主發放或扣除現金 Modal (驗證管理員權限 C4、支援負數 C1、防呆 H2)
      if (customId === 'modal_admin_give_cash') {
        if (!checkAdminPermission(interaction)) return;

        const teamId = interaction.fields.getTextInputValue('team_id_input').trim();
        const amountRaw = interaction.fields.getTextInputValue('amount_input').trim();
        const reason = interaction.fields.getTextInputValue('reason_input').trim();
        const amount = parseInt(amountRaw, 10);

        if (isNaN(amount) || amount === 0) {
          return interaction.reply({
            content: '❌ 發放或扣除金額必須為不為 0 的有效整數！(例如: 10000 或 -5000)',
            ephemeral: true
          });
        }

        try {
          const result = await teamMutex.runExclusive(teamId, async () => {
            return TeamService.addCash(teamId, amount, reason);
          });
          const team = result.team;

          if (team.channelId) {
            const ch = await client.channels.fetch(team.channelId).catch(() => null);
            if (ch) {
              const notifyMsg = amount >= 0
                ? `🎁 **【資金入帳】** 關主發放資金 **+$${amount.toLocaleString()}**！(事由: ${result.reason})\n目前現金餘額：**$${result.newCash.toLocaleString()}**`
                : `⚠️ **【資金扣除/校正】** 關主扣除資金 **-$${Math.abs(amount).toLocaleString()}**！(事由: ${result.reason})\n目前現金餘額：**$${result.newCash.toLocaleString()}**`;

              await ch.send({
                content: notifyMsg,
                allowedMentions: { parse: [] }
              }).catch(console.error);
            }
          }

          const replyMsg = amount >= 0
            ? `✅ 已成功發放 **$${amount.toLocaleString()}** 給 **${team.name}**！目前該隊現金：$${result.newCash.toLocaleString()}`
            : `✅ 已成功自 **${team.name}** 扣除 **$${Math.abs(amount).toLocaleString()}**！目前該隊現金：$${result.newCash.toLocaleString()}`;

          return interaction.reply({ content: replyMsg, ephemeral: true });
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
