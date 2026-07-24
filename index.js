const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder,
    AuditLogEvent,
    PermissionFlagsBits 
} = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- クライアント初期化 ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModerations
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// --- Gemini API 初期化 (安全判定用) ---
let genAI = null;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

// ID定数定義
const REPORT_CHANNEL_ID = '1517865558136066201'; // 報告・通知・転送用チャンネル
const AD_CHANNEL_ID = '1517868958768693309';     // 宣伝許可チャンネル
const BOT_ROLE_ID = '1520422736126804150';        // Bot用初期ロール

// 違反記録用メモリデータ
const userMessageHistory = new Map();
const userSpamViolations = new Map();
const userAdViolations = new Map();
const userInappropriateViolations = new Map();

// グローバルエラーハンドラー（Botが停止するのを防止）
process.on('unhandledRejection', (reason) => {
    console.error('未処理のPromise拒否:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('未補獲の例外:', err);
});

client.once('ready', () => {
    console.log(`${client.user.tag} 起動完了（全機能・エラー耐性適用済み）`);
});

// -------------------------------------------------------------
// 1. サーバー参加時
// -------------------------------------------------------------
client.on('guildMemberAdd', async (member) => {
    try {
        if (member.user.bot) {
            try {
                await member.roles.add(BOT_ROLE_ID);
            } catch (err) {
                console.error('Botロール付与権限エラー:', err.message);
            }
        }

        const channel = member.guild.systemChannel || member.guild.channels.cache.find(
            c => c.isTextBased() && c.permissionsFor(member.guild.members.me)?.has(PermissionFlagsBits.SendMessages)
        );
        if (channel) {
            await channel.send(`${member.user.username} さんがサーバーに参加しました！`);
        }
    } catch (error) {
        console.error('guildMemberAdd エラー:', error);
    }
});

// -------------------------------------------------------------
// 2. サーバー退出・キック・BAN時
// -------------------------------------------------------------
client.on('guildMemberRemove', async (member) => {
    try {
        const channel = member.guild.systemChannel || member.guild.channels.cache.find(
            c => c.isTextBased() && c.permissionsFor(member.guild.members.me)?.has(PermissionFlagsBits.SendMessages)
        );
        if (!channel) return;

        try {
            await new Promise(resolve => setTimeout(resolve, 1500));
            if (member.guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
                const fetchedLogs = await member.guild.fetchAuditLogs({ limit: 1 });
                const firstEntry = fetchedLogs.entries.first();

                if (firstEntry && firstEntry.target?.id === member.id) {
                    if (firstEntry.action === AuditLogEvent.MemberKick && firstEntry.createdTimestamp > Date.now() - 5000) {
                        return await channel.send(`${member.user.username} さんがキックされました。`);
                    }
                    if (firstEntry.action === AuditLogEvent.MemberBanAdd && firstEntry.createdTimestamp > Date.now() - 5000) {
                        return await channel.send(`${member.user.username} さんがBANされました。`);
                    }
                }
            }
        } catch (auditError) {
            console.error('監査ログ取得スキップ:', auditError.message);
        }

        await channel.send(`${member.user.username} さんがサーバーを退出しました。`);
    } catch (error) {
        console.error('guildMemberRemove エラー:', error);
    }
});

// -------------------------------------------------------------
// 3. タイムアウト検知
// -------------------------------------------------------------
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        const channel = newMember.guild.systemChannel || newMember.guild.channels.cache.find(
            c => c.isTextBased() && c.permissionsFor(newMember.guild.members.me)?.has(PermissionFlagsBits.SendMessages)
        );
        if (!channel) return;

        const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
        const newTimeout = newMember.communicationDisabledUntilTimestamp;

        if (!oldTimeout && newTimeout && newTimeout > Date.now()) {
            const durationMinutes = Math.ceil((newTimeout - Date.now()) / (1000 * 60));
            await channel.send(`${newMember.user.username} さんが ${durationMinutes} 分間タイムアウトされました。`);
        }
    } catch (error) {
        console.error('guildMemberUpdate エラー:', error);
    }
});

// -------------------------------------------------------------
// 4. メッセージ受信時の処理（通報・提案・不具合受信 & 各種モデレーション）
// -------------------------------------------------------------
client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot || !message.guild) return;

        const userId = message.author.id;
        const content = message.content || '';
        const reportChannel = message.guild.channels.cache.get(REPORT_CHANNEL_ID);

        // --- ★A. ユーザーからの通報・提案・質問・不具合メッセージの転送処理 ---
        const prefixes = ['!通報', '!提案', '!質問', '!不具合', '!相談'];
        const matchedPrefix = prefixes.find(p => content.startsWith(p));

        if (matchedPrefix) {
            const bodyText = content.slice(matchedPrefix.length).trim();
            
            if (!bodyText) {
                await message.reply(`⚠️ ${matchedPrefix} の後に内容を入力して送信してください。（例: \`${matchedPrefix} ○○について相談です\`）`).catch(() => {});
                return;
            }

            if (reportChannel) {
                const embed = new EmbedBuilder()
                    .setTitle(`📩 新しい ${matchedPrefix.replace('!', '')} メッセージ`)
                    .setColor(matchedPrefix === '!通報' ? 0xFF0000 : 0x00FF99)
                    .addFields(
                        { name: '送信者', value: `<@${userId}> (${message.author.tag})`, inline: true },
                        { name: '送信場所', value: `<#${message.channel.id}>`, inline: true },
                        { name: '内容', value: bodyText }
                    )
                    .setTimestamp();

                await reportChannel.send({ embeds: [embed] }).catch(() => {});
            }

            // 元のメッセージを消去し、送信者に案内を通知
            try { if (message.deletable) await message.delete(); } catch (_) {}
            await message.channel.send(`✅ <@${userId}> さんのメッセージ（${matchedPrefix.replace('!', '')}）を管理用チャンネルに送信しました！`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000)).catch(() => {});
            return;
        }

        // --- B. スパム検知 ---
        const userHistory = userMessageHistory.get(userId) || { text: '', count: 0 };
        if (userHistory.text === content && content.trim() !== '') {
            userHistory.count += 1;
        } else {
            userHistory.text = content;
            userHistory.count = 1;
        }
        userMessageHistory.set(userId, userHistory);

        if (userHistory.count >= 10) {
            userMessageHistory.set(userId, { text: '', count: 0 });
            try { if (message.deletable) await message.delete(); } catch (_) {}

            const violations = (userSpamViolations.get(userId) || 0) + 1;
            userSpamViolations.set(userId, violations);

            if (reportChannel) {
                await reportChannel.send(`⚠️ **スパム検知**: <@${userId}> が同じ連投を10回行いました。`).catch(() => {});
            }

            if (violations >= 2) {
                try {
                    if (message.member?.moderatable) {
                        await message.member.timeout(24 * 60 * 60 * 1000, 'スパム連投2回目');
                    }
                    await message.author.send('⚠️ スパム連投が2回続いたため、1日間タイムアウトされました。').catch(() => {});
                } catch (e) { console.error('タイムアウト失敗:', e.message); }
                userSpamViolations.set(userId, 0);
            } else {
                await message.author.send('⚠️ **注意**: 連投（スパム行為）が検知されました。次行うと1日間タイムアウトになります。').catch(() => {});
            }
            return;
        }

        // --- C. 宣伝検知 ---
        const isDiscordInvite = /(discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9]+/i.test(content);
        if (isDiscordInvite && message.channel.id !== AD_CHANNEL_ID) {
            try { if (message.deletable) await message.delete(); } catch (_) {}

            const violations = (userAdViolations.get(userId) || 0) + 1;
            userAdViolations.set(userId, violations);

            if (reportChannel) {
                await reportChannel.send(`⚠️ **宣伝違反**: <@${userId}> が許可されていないチャンネルで宣伝を行いました。`).catch(() => {});
            }

            if (violations >= 2) {
                try {
                    if (message.member?.moderatable) {
                        await message.member.timeout(24 * 60 * 60 * 1000, '他サーバー宣伝2回目');
                    }
                    await message.author.send('⚠️ 許可されていない場所での宣伝が2回続いたため、1日間タイムアウトされました。').catch(() => {});
                } catch (e) { console.error('タイムアウト失敗:', e.message); }
                userAdViolations.set(userId, 0);
            } else {
                await message.author.send(`⚠️ **注意**: サーバーの宣伝は <#${AD_CHANNEL_ID}> で行ってください。次行うと1日間タイムアウトになります。`).catch(() => {});
            }
            return;
        }

        // --- D. AIによる不適切判定 ---
        if (genAI && (content.length > 5 || message.attachments.size > 0)) {
            const isSafe = await checkContentSafety(content, message.attachments);
            if (!isSafe) {
                try { if (message.deletable) await message.delete(); } catch (_) {}

                const violations = (userInappropriateViolations.get(userId) || 0) + 1;
                userInappropriateViolations.set(userId, violations);

                if (reportChannel) {
                    await reportChannel.send(`🚨 **不適切コンテンツ検知**: <@${userId}> の投稿が削除されました。`).catch(() => {});
                }

                if (violations >= 2) {
                    try {
                        if (message.member?.moderatable) {
                            await message.member.timeout(3 * 24 * 60 * 60 * 1000, '不適切コンテンツの繰り返し投稿');
                        }
                        await message.author.send('🚨 不適切な投稿が複数回確認されたため、3日間タイムアウトされました。').catch(() => {});
                    } catch (e) { console.error('タイムアウト失敗:', e.message); }
                } else {
                    await message.author.send('⚠️ **注意**: 投稿された内容（文章またはファイル）が不適切と判定され削除されました。').catch(() => {});
                }
            }
        }
    } catch (error) {
        console.error('messageCreate エラー:', error);
    }
});

// -------------------------------------------------------------
// Gemini API を使用した不適切コンテンツ判定関数
// -------------------------------------------------------------
async function checkContentSafety(text, attachments) {
    if (!genAI) return true;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const prompt = "以下のテキストおよび画像が、公序良俗に反する内容、暴力的、過度に性的な表現、スパム、あるいは深刻な誹謗中傷を含んでいるか判定してください。「SAFE」または「UNSAFE」の一言だけを返してください。";

        let contents = [prompt, text || ""];

        if (attachments && attachments.size > 0) {
            const firstAttachment = attachments.first();
            if (firstAttachment.contentType && firstAttachment.contentType.startsWith('image/')) {
                const response = await fetch(firstAttachment.url);
                if (response.ok) {
                    const arrayBuffer = await response.arrayBuffer();
                    const base64Data = Buffer.from(arrayBuffer).toString('base64');
                    contents.push({
                        inlineData: {
                            data: base64Data,
                            mimeType: firstAttachment.contentType
                        }
                    });
                }
            }
        }

        const result = await model.generateContent(contents);
        const responseText = result.response.text().trim().toUpperCase();
        return !responseText.includes("UNSAFE");
    } catch (e) {
        console.error('AI安全判定エラー(安全側に倒して続行):', e.message);
        return true;
    }
}

client.login(process.env.DISCORD_TOKEN);
