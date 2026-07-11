const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Botは元気に動いています！');
});

app.listen(PORT, () => {
  console.log(`サーバーがポート ${PORT} で起動しました`);
});

const fs = require("fs");

// sent.jsonの初期構造
let sent = {
    verify: false,
    consult: false,
    consults: {},      // 通報などのメッセージID用
    activityLog: {}    // ユーザー毎の発言日付記録用
};

if (fs.existsSync("./sent.json")) {
    try {
        const data = JSON.parse(fs.readFileSync("./sent.json", "utf8"));
        sent = { ...sent, ...data };
    } catch (e) {
        console.error("sent.jsonの読み込みに失敗しました:", e);
    }
}

function save() {
    fs.writeFileSync("./sent.json", JSON.stringify(sent, null, 2));
}

require("dotenv").config();

// ==========================
// 🧠 Gemini AI 設定
// ==========================
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// ==========================
// ⚙️ チャンネル・カテゴリーID設定
// ==========================
const VERIFY_CHANNEL_ID = "1517692680191344690";       // 🛡️ 認証パネル
const CONSULT_CHANNEL_ID = "1517760332255461577";      // 💬 相談窓口
const REPORT_PANEL_CHANNEL_ID = "1524269876947189891"; // 🚨 通報パネルを設置するチャンネル
const CONSULT_RECEIVE_CHANNEL_ID = "1517865558136066201"; // 📩 運営への通報・ログを受信するチャンネル
const WELCOME_CHANNEL_ID = "1520424091792838779";      // 👋 歓迎・自己紹介・退室通知チャンネル

const TICKET_CATEGORY_ID = "1520579786764845086";      // 🎫 相談チャンネルが作成されるカテゴリー

// ==========================
// 🛡️ ロールID設定
// ==========================
const VERIFIED_ROLE_ID = "1517686961765093397";        // 認証済み
const UNVERIFIED_ROLE_ID = "1523928117503066143";      // 未認証
const ACTIVE_TALKER_ROLE_ID = "1517753520407707668";   // 3日連続発言
const ADMIN_ROLE_ID = "1517746980145598614";           // 👑 管理者用ロール（/setup 実行可能権限）

const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    AttachmentBuilder,
    StringSelectMenuBuilder,
    PermissionFlagsBits,
    MessageFlags
} = require("discord.js");

const { Captcha } = require("captcha-canvas");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const captchaAnswers = new Map();
const welcomeMessages = new Map();

// 各サーバーの「Botを除いた人間の数」を保持するメモリマップ
const serverHumanCounts = new Map();

// サーバーの人（人間）の数を計算してセットする共通関数
function updateHumanCount(guild, offset = 0) {
    if (!serverHumanCounts.has(guild.id)) {
        serverHumanCounts.set(guild.id, guild.memberCount);
    }
    let current = serverHumanCounts.get(guild.id) + offset;
    if (current < 1) current = 1;
    serverHumanCounts.set(guild.id, current);
    return current;
}

client.once("clientReady", async () => {
    console.log(`${client.user.tag} 起動完了`);
});

// 📥 サーバー参加時
client.on("guildMemberAdd", async member => {
    try {
        const unverifiedRole = member.guild.roles.cache.get(UNVERIFIED_ROLE_ID);
        if (unverifiedRole) await member.roles.add(unverifiedRole);
    } catch (error) {
        console.error("未認証ロール付与失敗:", error);
    }
});

// 🚪 サーバー退出時
client.on("guildMemberRemove", async member => {
    if (member.user.bot) return;

    const welcomeChannel = client.channels.cache.get(WELCOME_CHANNEL_ID);
    if (welcomeChannel && welcomeChannel.isTextBased()) {
        try {
            const humanCount = updateHumanCount(member.guild, -1);
            await welcomeChannel.send({
                content: `<@${member.user.id}> さんがこのサーバーから退出してしまいました... \n現在のメンバー数は ${humanCount} 人です。`
            });
        } catch (error) {
            console.error("退出通知の送信に失敗しました:", error);
        }
    }
});

// 💬 メッセージ送信時
client.on("messageCreate", async message => {
    if (message.author.bot) return;

    // --------------------------
    // 🧠 メンションAI応答機能（長文分割対応・完全版）
    // --------------------------
    if (message.mentions.has(client.user)) {
        // Botへのメンション文字列を綺麗に除去
        const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
        const cleanText = message.content.replace(mentionRegex, '').trim();

        if (!cleanText) {
            return message.reply("⚠️ メンションと一緒に、AIに聞きたい文章を入力してください！\n例: `@Bot名 美味しいオムライスの作り方は？`").catch(console.error);
        }

        if (!genAI) {
            return message.reply("❌ AI設定（APIキー）が正しく完了していません。Renderの環境変数を確認してください。").catch(console.error);
        }

        try {
            // タイピング中状態（...が動くやつ）を開始
            await message.channel.sendTyping();

            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent(cleanText);
            const aiResponse = result.response.text();

            if (!aiResponse || aiResponse.trim() === "") {
                await message.reply("AIからの応答が空でした。もう一度試してください。");
                return;
            }

            // Discordの2000文字上限対策（元の長文分割ロジックを100%維持）
            if (aiResponse.length <= 2000) {
                await message.reply(aiResponse);
            } else {
                const chunks = [];
                for (let i = 0; i < aiResponse.length; i += 1900) {
                    chunks.push(aiResponse.substring(i, i + 1900));
                }
                
                // 最初のメッセージはリプライ、続きは普通のチャンネル送信
                await message.reply(chunks[0] + "\n(続く...)");
                for (let i = 1; i < chunks.length; i++) {
                    const suffix = (i === chunks.length - 1) ? "" : "\n(続く...)";
                    await message.channel.send(chunks[i] + suffix);
                }
            }

        } catch (aiError) {
            console.error("AI応答エラー詳細:", aiError);
            await message.reply("❌ AIの呼び出し中にエラーが発生しました。時間を置いて再度お試しください。").catch(console.error);
        }
        return; // AI処理をした場合はここで終了し、BUMP検知などへ進ませない
    }

    // 🚀 BUMP & UP コマンド検知機能
    const textContent = message.content.toLowerCase().trim();
    const isTextCommand = textContent.startsWith("/bump") || textContent.startsWith("/up");
    const isSlashCommand = message.interaction && 
        (message.interaction.commandName === "bump" || message.interaction.commandName === "up");

    if (isTextCommand || isSlashCommand) {
        const cmdName = (isSlashCommand ? message.interaction.commandName : (textContent.startsWith("/bump") ? "bump" : "up")).toUpperCase();

        try {
            await message.channel.send(`✅ **${cmdName}** コマンドを検知しました。2時間後にこのチャンネルで通知します！`);
            
            setTimeout(async () => {
                await message.channel.send({
                    content: `🔔 **@everyone ${cmdName} の時間になりました！**\n次のコマンド入力をよろしくお願いします！`
                }).catch(console.error);
            }, 7200000); 
        } catch (error) {
            console.error("BUMP/UP通知のセットに失敗しました:", error);
        }
    }

    if (!message.guild) return;

    const userId = message.author.id;
    const today = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }).replace(/\//g, "-");

    // 3日連続発言の判定処理
    if (!sent.activityLog) sent.activityLog = {};
    if (!sent.activityLog[userId]) sent.activityLog[userId] = [];

    const userLog = sent.activityLog[userId];

    if (!userLog.includes(today)) {
        userLog.push(today);
        userLog.sort();
        if (userLog.length > 5) userLog.shift();
        save();
    }

    if (!(message.member && message.member.roles.cache.has(ACTIVE_TALKER_ROLE_ID))) {
        const datesToCheck = [];
        for (let i = 0; i < 3; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dStr = d.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }).replace(/\//g, "-");
            datesToCheck.push(dStr);
        }

        const hasThreeDaysStreak = datesToCheck.every(date => userLog.includes(date));

        if (hasThreeDaysStreak) {
            try {
                const role = message.guild.roles.cache.get(ACTIVE_TALKER_ROLE_ID);
                if (role && message.member) {
                    await message.member.roles.add(role);
                    await message.channel.send(`🎉 <@${userId}> さん、3日連続発言達成！ロールが付与されました！`);
                }
            } catch (error) {
                console.error("ロール付与失敗:", error);
            }
        }
    }
});

// インタラクション処理
client.on("interactionCreate", async interaction => {
    try {
        // 🛠️ /setup コマンド
        if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            if (!interaction.inGuild() || !interaction.member) {
                return interaction.editReply("❌ このコマンドはサーバー内でのみ実行できます。");
            }

            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) {
                return interaction.editReply("❌ このコマンドは、指定された管理者ロールを持っている人のみ実行できます。");
            }

            const verifyChannel = client.channels.cache.get(VERIFY_CHANNEL_ID);
            if (verifyChannel && verifyChannel.isTextBased()) {
                const verifyButton = new ButtonBuilder().setCustomId("verify_start").setLabel("🔒 認証を開始する").setStyle(ButtonStyle.Primary);
                await verifyChannel.send({
                    content: "# 🛡️ サーバー認証\n下のボタンを押して画像認証を完了させてください。",
                    components: [new ActionRowBuilder().addComponents(verifyButton)]
                });
            }

            const consultChannel = client.channels.cache.get(CONSULT_CHANNEL_ID);
            if (consultChannel && consultChannel.isTextBased()) {
                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId("consult_select_direct")
                    .setPlaceholder("お問い合わせのカテゴリを選択してください")
                    .addOptions([
                        { label: "💡 提案", description: "サーバーへの提案やアイデアはこちら", value: "💡 提案" },
                        { label: "❓ 質問・問い合わせ", description: "運営への質問や一般的な問い合わせ", value: "❓ 質問・問い合わせ" },
                        { label: "🐛 不具合・バグ報告", description: "Botやサーバーのバグ報告はこちら", value: "🐛 不具合・バグ報告" }
                    ]);
                await consultChannel.send({
                    content: "# 🔷 窓口\nお問い合わせのカテゴリを選択してください。選択すると自動的に件名と詳細入力のフォームが開きます。",
                    components: [new ActionRowBuilder().addComponents(selectMenu)]
                });
            }

            const reportChannel = client.channels.cache.get(REPORT_PANEL_CHANNEL_ID);
            if (reportChannel && reportChannel.isTextBased()) {
                const reportButton = new ButtonBuilder().setCustomId("report_start").setLabel("🚨 荒らしを通報する").setStyle(ButtonStyle.Danger);
                await reportChannel.send({
                    content: "# 🚨 違反・荒らし通報窓口\nサーバー内での規約違反、迷惑行為、荒らしを発見した場合は、下のボタンから通報をお願いします。\n※通報内容は運営のみに届きます。",
                    components: [new ActionRowBuilder().addComponents(reportButton)]
                });
            }

            return interaction.editReply("✅ すべての窓口（認証・相談・通報）のセットアップが完了しました！");
        }

        // 🔷 相談窓口モーダル展開
        if (interaction.isStringSelectMenu() && interaction.customId === "consult_select_direct") {
            const selectedCategory = interaction.values[0];
            const modal = new ModalBuilder().setCustomId(`consult_modal:${selectedCategory}`).setTitle(`${selectedCategory} 窓口`);
            const titleInput = new TextInputBuilder().setCustomId("consult_title").setLabel("件名を入力してください").setStyle(TextInputStyle.Short).setRequired(true);
            const detailInput = new TextInputBuilder().setCustomId("consult_detail").setLabel("相談内容の詳細を入力してください").setStyle(TextInputStyle.Paragraph).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(detailInput));
            await interaction.showModal(modal);
            return;
        }

        // 🔷 相談部屋作成
        if (interaction.isModalSubmit() && interaction.customId.startsWith("consult_modal:")) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const selectedCategory = interaction.customId.split(":")[1];
            const title = interaction.fields.getTextInputValue("consult_title");
            const detail = interaction.fields.getTextInputValue("consult_detail");

            const channelName = `💬-相談-${interaction.user.username}`;
            let consultRoom;
            try {
                consultRoom = await interaction.guild.channels.create({
                    name: channelName,
                    type: 0,
                    parent: TICKET_CATEGORY_ID,
                    permissionOverwrites: [
                        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                    ]
                });
            } catch (e) {
                consultRoom = await interaction.guild.channels.create({
                    name: channelName,
                    type: 0,
                    permissionOverwrites: [
                        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                    ]
                });
            }

            const closeButton = new ButtonBuilder().setCustomId("consult_close").setLabel("🔒 相談室を閉じる").setStyle(ButtonStyle.Danger);
            await consultRoom.send({
                content: `### 💬 相談窓口が開設されました ${interaction.user}`,
                embeds: [{
                    title: `📄 受付内容: ${selectedCategory}`,
                    fields: [{ name: "件名", value: title }, { name: "相談内容のまとめ", value: detail }],
                    color: 0x3498db,
                    timestamp: new Date()
                }],
                components: [new ActionRowBuilder().addComponents(closeButton)]
            });
            await interaction.editReply(`✅ 相談用の個別チャンネルを作成しました！こちらで対応します ➡️ ${consultRoom}`);
            return;
        }

        if (interaction.isButton() && interaction.customId === "consult_close") {
            await interaction.reply("🔒 5秒後にこの相談チャンネルを削除します...");
            setTimeout(async () => { await interaction.channel.delete().catch(console.error); }, 5000);
            return;
        }

        // 🚨 通報機能
        if (interaction.isButton() && interaction.customId === "report_start") {
            const modal = new ModalBuilder().setCustomId("report_modal").setTitle("荒らし・違反者の通報");
            const target = new TextInputBuilder().setCustomId("target").setLabel("通報するユーザー名 または ID").setStyle(TextInputStyle.Short).setRequired(true);
            const reason = new TextInputBuilder().setCustomId("reason").setLabel("詳しい通報理由・状況").setStyle(TextInputStyle.Paragraph).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(target), new ActionRowBuilder().addComponents(reason));
            await interaction.showModal(modal);
            return;
        }

        if (interaction.isModalSubmit() && interaction.customId === "report_modal") {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const target = interaction.fields.getTextInputValue("target");
            const reason = interaction.fields.getTextInputValue("reason");
            const receive = client.channels.cache.get(CONSULT_RECEIVE_CHANNEL_ID);

            if (receive) {
                await receive.send({
                    embeds: [{
                        title: "🚨 荒らし通報を受信しました",
                        fields: [
                            { name: "通報者", value: `${interaction.user.tag} (${interaction.user.id})` },
                            { name: "対象者", value: target },
                            { name: "詳細", value: reason }
                        ],
                        color: 0xe74c3c,
                        timestamp: new Date()
                    }]
                });
            }
            await interaction.editReply("✅ 通報内容を運営に匿名送信しました。ご協力ありがとうございます。");
            return;
        }

        // 🛡️ 画像認証システム
        if (interaction.isButton() && interaction.customId === "verify_start") {
            if (interaction.member && interaction.member.roles.cache.has(VERIFIED_ROLE_ID)) {
                return interaction.reply({ flags: [MessageFlags.Ephemeral], content: "✅ すでに認証済みです。" });
            }
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const captcha = new Captcha();
            captcha.async = true;
            captcha.drawCaptcha();
            captchaAnswers.set(interaction.user.id, captcha.text);

            const attachment = new AttachmentBuilder(await captcha.png, { name: "captcha.png" });
            const inputButton = new ButtonBuilder().setCustomId("captcha_open_modal").setLabel("✍️ 答えを入力する").setStyle(ButtonStyle.Primary);

            await interaction.editReply({
                content: "⚠️ **画像認証**\n下の画像に表示されている文字を入力してください。",
                files: [attachment],
                components: [new ActionRowBuilder().addComponents(inputButton)]
            });
            return;
        }

        if (interaction.isButton() && interaction.customId === "captcha_open_modal") {
            const modal = new ModalBuilder().setCustomId("captcha_submit_modal").setTitle("🚨 画像認証");
            const textInput = new TextInputBuilder().setCustomId("captcha_code_input").setLabel("画像に写っている英数字を入力してください").setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(textInput));
            await interaction.showModal(modal);
            return;
        }

        if (interaction.isModalSubmit() && interaction.customId === "captcha_submit_modal") {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const userAnswer = interaction.fields.getTextInputValue("captcha_code_input").trim();
            const correctAnswer = captchaAnswers.get(interaction.user.id);
            captchaAnswers.delete(interaction.user.id);

            if (!correctAnswer) return interaction.editReply("❌ 有効期限切れです。最初からやり直してください。");
            if (userAnswer.toLowerCase() !== correctAnswer.toLowerCase()) return interaction.editReply("❌ 文字が一致しませんでした。");

            const verifiedRole = interaction.guild.roles.cache.get(VERIFIED_ROLE_ID);
            const unverifiedRole = interaction.guild.roles.cache.get(UNVERIFIED_ROLE_ID);

            if (unverifiedRole && interaction.member && interaction.member.roles.cache.has(UNVERIFIED_ROLE_ID)) await interaction.member.roles.remove(unverifiedRole).catch(console.error);
            if (verifiedRole && interaction.member) await interaction.member.roles.add(verifiedRole).catch(console.error);

            const introBtn = new ButtonBuilder().setCustomId("intro_open_modal").setLabel("📝 自己紹介を書く（任意）").setStyle(ButtonStyle.Success);

            await interaction.editReply({
                content: "✅ **画像認証に成功し、ロールが付与されました！サーバーへようこそ！**",
                components: [new ActionRowBuilder().addComponents(introBtn)]
            });

            const welcomeChannel = client.channels.cache.get(WELCOME_CHANNEL_ID);
            if (welcomeChannel && welcomeChannel.isTextBased()) {
                const humanCount = updateHumanCount(interaction.guild, 1);
                const welcomeMsg = await welcomeChannel.send({ content: `<@${interaction.user.id}> さんがサーバーに参加しました！\n現在のメンバー数は ${humanCount} 人です！` });
                await welcomeMsg.react("👍").catch(console.error);
                
                welcomeMessages.set(interaction.user.id, welcomeMsg.id);
            }
            return;
        }

        // 自己紹介ボタン
        if (interaction.isButton() && interaction.customId === "intro_open_modal") {
            const introModal = new ModalBuilder().setCustomId("intro_submit_modal").setTitle("自己紹介");
            const introInput = new TextInputBuilder().setCustomId("intro_text").setLabel("あなたの自己紹介を自由に書いてください").setStyle(TextInputStyle.Paragraph).setRequired(true);
            introModal.addComponents(new ActionRowBuilder().addComponents(introInput));
            await interaction.showModal(introModal);
            return;
        }

        // 自己紹介送信
        if (interaction.isModalSubmit() && interaction.customId === "intro_submit_modal") {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const introText = interaction.fields.getTextInputValue("intro_text").trim();
            const welcomeChannel = client.channels.cache.get(WELCOME_CHANNEL_ID);
            const savedMessageId = welcomeMessages.get(interaction.user.id);

            if (welcomeChannel && welcomeChannel.isTextBased()) {
                const humanCount = updateHumanCount(welcomeChannel.guild, 0);
                let edited = false;

                if (savedMessageId) {
                    try {
                        const originalMsg = await welcomeChannel.messages.fetch(savedMessageId);
                        if (originalMsg) {
                            await originalMsg.edit({
                                content: `<@${interaction.user.id}> さんがサーバーに参加しました！\n現在のメンバー数は ${humanCount} 人です！\n自己紹介も見てみましょう！\n⬇️`,
                                embeds: [{ title: `📝 ${interaction.user.username} さんの自己紹介`, description: introText, color: 0x3498db }]
                            });
                            await originalMsg.react("📝").catch(console.error);
                            edited = true;
                        }
                    } catch (e) {
                        console.log("メッセージ編集失敗により新規送信に切り替えます:", e);
                    }
                }

                if (!edited) {
                    await welcomeChannel.send({ 
                        content: `<@${interaction.user.id}> さんがサーバーに参加しました！\n現在のメンバー数は ${humanCount} 人です！`, 
                        embeds: [{ title: `📝 ${interaction.user.username} さんの自己紹介`, description: introText, color: 0x3498db }] 
                    });
                }
                
                welcomeMessages.delete(interaction.user.id);
            }
            await interaction.editReply("✅ 自己紹介を追加しました！楽しんでくださいね！");
            return;
        }

    } catch (error) {
        console.error(error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ flags: [MessageFlags.Ephemeral], content: "エラーが発生しました。" });
        }
    }
});

client.login(process.env.TOKEN);
