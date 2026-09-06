import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import { playerSlashCommands } from './commands/playerCommands.js';
import { adminSlashCommands } from './commands/adminCommands.js';

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error('❌ 請在 .env 檔案中配置 DISCORD_TOKEN 與 CLIENT_ID！');
  process.exit(1);
}

const commands = [
  ...playerSlashCommands.map(cmd => cmd.toJSON()),
  ...adminSlashCommands.map(cmd => cmd.toJSON())
];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log(`⏳ 正在向 Discord 註冊 ${commands.length} 個斜線指令...`);

    if (guildId) {
      // 伺服器專屬指令 (即時生效，適合營隊 Discord 伺服器)
      const data = await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );
      console.log(`✅ 成功向伺服器 (${guildId}) 註冊了 ${data.length} 個應用程式指令！`);
    } else {
      // 全域指令 (生效需數分鐘)
      const data = await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log(`✅ 成功向全域註冊了 ${data.length} 個應用程式指令！`);
    }
  } catch (error) {
    console.error('❌ 註冊指令時發生錯誤：', error);
  }
})();
