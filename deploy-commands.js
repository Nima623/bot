require("dotenv").config();

const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const commands = [
    new SlashCommandBuilder()
        .setName("setup")
        .setDescription("認証・相談パネルをそれぞれ指定のチャンネルに設置します")
        // 👇 ここを追加することで、管理者（サーバー管理権限を持つ人）専用になります！
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(cmd => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log("スラッシュコマンドを更新中...");
        
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );

        console.log("コマンド登録完了 (/setup を管理者専用に設定しました)");
    } catch (err) {
        console.error(err);
    }
})();