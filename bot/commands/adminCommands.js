import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { db } from '../database/storage.js';
import { STOCKS, TOTAL_ROUNDS } from '../config/marketData.js';
import { GameEngine } from '../services/gameEngine.js';
import { TeamService } from '../services/teamService.js';
import { AdminPanel } from '../components/adminPanel.js';
import { TradePanel } from '../components/tradePanel.js';
import { sanitizeText } from '../utils/security.js';

export const adminSlashCommands = [
  new SlashCommandBuilder()
    .setName('gm')
    .setDescription('關主管理控制指令')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('panel')
        .setDescription('在當前頻道送出關主互動控制面板')
    )
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('初始化小隊數量與起始本金')
        .addIntegerOption(opt =>
          opt.setName('team_count')
            .setDescription('小隊總數 (例如: 8)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(20)
        )
        .addIntegerOption(opt =>
          opt.setName('initial_cash')
            .setDescription('起始本金 (預設 100,000)')
            .setRequired(false)
            .setMinValue(0)
        )
    )
    .addSubcommand(sub =>
      sub.setName('bind')
        .setDescription('將小隊綁定至專屬文字頻道')
        .addStringOption(opt =>
          opt.setName('team_id')
            .setDescription('小隊代號 (例如: team_1)')
            .setRequired(true)
        )
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('專屬文字頻道')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('小隊顯示名稱 (例如: 第 1 小隊)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('round')
        .setDescription('推進或切換遊戲階段')
        .addStringOption(opt =>
          opt.setName('stage')
            .setDescription('欲切換的階段')
            .setRequired(true)
            .addChoices(
              { name: '1. 開始本期闖關解題 (QUIZ)', value: 'quiz' },
              { name: '2. 開啟 5 分鐘投資交易 (TRADING)', value: 'trading' },
              { name: '3. 關閉市場並結算本期 (SETTLE)', value: 'settle' }
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('give_cash')
        .setDescription('發放或扣除解題資金 (支援負數校正)')
        .addStringOption(opt =>
          opt.setName('team_id')
            .setDescription('小隊代號 (例如: team_1)')
            .setRequired(true)
        )
        .addIntegerOption(opt =>
          opt.setName('amount')
            .setDescription('發放或扣除金額 (正數發放，負數扣除，例如: 10000 或 -5000)')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('reason')
            .setDescription('發放或扣除事由說明')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('give_hint')
        .setDescription('發放當期市場提示給小隊')
        .addStringOption(opt =>
          opt.setName('team_id')
            .setDescription('小隊代號 (例如: team_1)')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('stock')
            .setDescription('股票公司代碼')
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
    )
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('查看全體小隊即時資產大榜與持股概況 (僅關主)')
    )
    .addSubcommand(sub =>
      sub.setName('broadcast_panels')
        .setDescription('向所有小隊已綁定的頻道推送當前交易看板')
    )
    .addSubcommand(sub =>
      sub.setName('reset')
        .setDescription('重設整場遊戲 (清空所有交易與小隊)')
        .addBooleanOption(opt =>
          opt.setName('confirm')
            .setDescription('確定重設嗎？此動作不可逆！')
            .setRequired(true)
        )
    )
];

// 處理關主指令
export async function handleAdminCommand(interaction, client) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'panel') {
    const panel = AdminPanel.buildPanel();
    return interaction.reply(panel);
  }

  if (subcommand === 'setup') {
    const count = interaction.options.getInteger('team_count');
    const cash = interaction.options.getInteger('initial_cash') ?? 100000;

    GameEngine.stopTimer();
    db.reset(cash);
    for (let i = 1; i <= count; i++) {
      const id = `team_${i}`;
      const name = `第 ${i} 小隊`;
      db.registerTeam(id, name, null);
    }

    return interaction.reply({
      content: `✅ 成功初始化 **${count}** 個小隊，起始本金為 **$${cash.toLocaleString()}**！\n請使用 \`/gm bind\` 指令或至各小隊文字頻道進行綁定。`
    });
  }

  if (subcommand === 'bind') {
    const teamId = interaction.options.getString('team_id');
    const channel = interaction.options.getChannel('channel');
    const rawCustomName = interaction.options.getString('name');
    const customName = rawCustomName ? sanitizeText(rawCustomName, 50) : null;

    const team = db.registerTeam(teamId, customName, channel.id);
    return interaction.reply({
      content: `✅ 成功將 **${team.name}** (${team.id}) 綁定至文字頻道 <#${channel.id}>！`,
      allowedMentions: { parse: [] }
    });
  }

  if (subcommand === 'round') {
    const stage = interaction.options.getString('stage');
    const currentRound = db.getGameState().round;

    if (stage === 'quiz') {
      GameEngine.startQuizStage(currentRound);
      return interaction.reply({
        content: `📢 **【第 ${currentRound} 期 • 闖關解題階段開始】**！\n此時市場休市，請各小隊進行闖關解題，答對可向關主索取提示或資金。`
      });
    }

    if (stage === 'trading') {
      // 避免多頻道廣播逾 3 秒 (H3 防護)
      await interaction.deferReply();

      GameEngine.startTradingStage(
        300,
        async (remainingSec) => {
          // 倒數提醒發送至各小隊頻道
          const teams = Object.values(db.getTeams());
          for (const t of teams) {
            if (t.channelId) {
              const ch = await client.channels.fetch(t.channelId).catch(() => null);
              if (ch) {
                await ch.send({
                  content: `⏰ **【投資時間提醒】** 剩餘最後 **${remainingSec}** 秒，請把握時間確認下單！`,
                  allowedMentions: { parse: [] }
                }).catch(console.error);
              }
            }
          }
        },
        async () => {
          // 時間到自動提示
          const teams = Object.values(db.getTeams());
          for (const t of teams) {
            if (t.channelId) {
              const ch = await client.channels.fetch(t.channelId).catch(() => null);
              if (ch) {
                await ch.send({
                  content: `🛑 **【投資時間截止】** 市場已停止交易，請等候關主公布結算結果！`,
                  allowedMentions: { parse: [] }
                }).catch(console.error);
              }
            }
          }
        }
      );

      // 向所有小隊頻道發送交易面板
      const teams = Object.values(db.getTeams());
      for (const t of teams) {
        if (t.channelId) {
          const ch = await client.channels.fetch(t.channelId).catch(() => null);
          if (ch) {
            const panel = TradePanel.buildPanel(t.id);
            await ch.send({
              content: `🟢 **【第 ${currentRound} 期 • 5分鐘投資時間開始！】** 市場已開盤，請使用下方按鈕或 \`/buy\`、\`/sell\` 進行交易：`,
              ...panel,
              allowedMentions: { parse: [] }
            }).catch(console.error);
          }
        }
      }

      return interaction.editReply({
        content: `🟢 **【第 ${currentRound} 期 • 5 分鐘投資交易階段已開啟！】**\n已向所有綁定的小隊頻道推播交易看板並啟動倒數計時。`
      });
    }

    if (stage === 'settle') {
      // 避免多頻道發送戰報逾 3 秒 (H3 防護)
      await interaction.deferReply();

      const settleResult = GameEngine.settleRound();
      const { round, isLastRound, settlementData } = settleResult;

      // 向各小隊專屬頻道發送私密結算單
      for (const item of settlementData.rankings) {
        if (item.channelId) {
          const ch = await client.channels.fetch(item.channelId).catch(() => null);
          if (ch) {
            const embed = new EmbedBuilder()
              .setTitle(`🏁 【第 ${round} 期結算戰報】${item.teamName}`)
              .setColor(0xf1c40f)
              .setDescription(`本期投資時間已結束，以下為貴隊資產與目前成績：`)
              .addFields(
                { name: '💰 結算現金', value: `$${item.cash.toLocaleString()}`, inline: true },
                { name: '📈 股票庫存現值', value: `$${item.stockValue.toLocaleString()}`, inline: true },
                { name: '🏦 總資產', value: `**$${item.totalAsset.toLocaleString()}**`, inline: true },
                { name: '🏆 當輪全場排名', value: `第 **${item.rank}** 名 (共 ${settlementData.totalTeams} 隊)`, inline: false }
              )
              .setFooter({ text: '依規則：其餘各隊詳細持股與資產不公開。' })
              .setTimestamp();

            await ch.send({
              embeds: [embed],
              allowedMentions: { parse: [] }
            }).catch(console.error);
          }
        }
      }

      let replyMsg = `🏁 **【第 ${round} 期結算完畢】**！\n已將各隊專屬戰報與名次私密發布至各自頻道。`;
      if (isLastRound) {
        replyMsg += `\n🎉 **恭喜！全場 4 個分期競賽已圓滿結束！** 請使用 \`/gm status\` 查看全場最終名次。`;
      } else {
        replyMsg += `\n下一期為第 **${settleResult.nextRound}** 期。請關主就緒後切換至 QUIZ 階段。`;
      }

      return interaction.editReply({ content: replyMsg });
    }
  }

  if (subcommand === 'give_cash') {
    const teamId = interaction.options.getString('team_id');
    const amount = interaction.options.getInteger('amount');
    const reason = interaction.options.getString('reason');

    try {
      const result = TeamService.addCash(teamId, amount, reason);
      const team = result.team;

      // 若小隊有綁定頻道，發送通知
      if (team.channelId) {
        const ch = await client.channels.fetch(team.channelId).catch(() => null);
        if (ch) {
          const notifyMsg = amount >= 0
            ? `🎁 **【資金入帳】** 關主已發放資金 **+$${amount.toLocaleString()}**！(事由: ${result.reason})\n目前現金餘額：**$${result.newCash.toLocaleString()}**`
            : `⚠️ **【資金扣除/校正】** 關主扣除資金 **-$${Math.abs(amount).toLocaleString()}**！(事由: ${result.reason})\n目前現金餘額：**$${result.newCash.toLocaleString()}**`;

          await ch.send({
            content: notifyMsg,
            allowedMentions: { parse: [] }
          }).catch(console.error);
        }
      }

      const replyMsg = amount >= 0
        ? `✅ 已成功發放 **$${amount.toLocaleString()}** 給 **${team.name}**！目前現金：$${result.newCash.toLocaleString()}`
        : `✅ 已成功自 **${team.name}** 扣除 **$${Math.abs(amount).toLocaleString()}**！目前現金：$${result.newCash.toLocaleString()}`;

      return interaction.reply({ content: replyMsg });
    } catch (err) {
      return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
  }

  if (subcommand === 'give_hint') {
    const teamId = interaction.options.getString('team_id');
    const stockId = interaction.options.getString('stock');
    const round = db.getGameState().round;

    try {
      const result = TeamService.unlockHint(teamId, round, stockId);
      const team = db.getTeam(teamId);

      // 發送通知到小隊頻道
      if (team.channelId) {
        const ch = await client.channels.fetch(team.channelId).catch(() => null);
        if (ch) {
          const embed = new EmbedBuilder()
            .setTitle(`💡 【獲得市場情報】第 ${round} 期 • ${result.stock.name}`)
            .setColor(0xf39c12)
            .setDescription(result.hint.content)
            .setFooter({ text: '此為貴隊專屬情報，請妥善利用投資策略！' })
            .setTimestamp();

          await ch.send({
            content: `📬 **【獲得新情報】** 關主發放了市場提示：`,
            embeds: [embed],
            allowedMentions: { parse: [] }
          }).catch(console.error);
        }
      }

      return interaction.reply({
        content: `✅ 已成功發放第 **${round}** 期 **${result.stock.name}** 的提示給 **${team.name}**！${result.alreadyHad ? '(該隊先前已領取過)' : ''}`
      });
    } catch (err) {
      return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
  }

  if (subcommand === 'status') {
    const embed = AdminPanel.buildLeaderboardEmbed();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (subcommand === 'broadcast_panels') {
    await interaction.deferReply({ ephemeral: true });
    const teams = Object.values(db.getTeams());
    let sentCount = 0;
    for (const t of teams) {
      if (t.channelId) {
        const ch = await client.channels.fetch(t.channelId).catch(() => null);
        if (ch) {
          const panel = TradePanel.buildPanel(t.id);
          await ch.send({ ...panel, allowedMentions: { parse: [] } }).catch(console.error);
          sentCount++;
        }
      }
    }
    return interaction.editReply({ content: `✅ 已向 **${sentCount}** 個小隊頻道發送最新交易看板！` });
  }

  if (subcommand === 'reset') {
    const confirm = interaction.options.getBoolean('confirm');
    if (!confirm) return interaction.reply({ content: '已取消重設操作。', ephemeral: true });

    GameEngine.stopTimer();
    db.reset();
    return interaction.reply({ content: '🔄 **已成功重設遊戲！** 所有小隊、持股與交易紀錄已歸零。' });
  }
}
