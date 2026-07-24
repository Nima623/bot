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
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ID定数定義
const REPORT_CHANNEL_ID = '1517865558136066201'; // 報告・通知用チャンネル
const AD_CHANNEL_ID = '1517868958768693309';     // 宣伝許可チャンネル
const BOT_ROLE_ID = '1520422736126804150';        // Bot用初期ロール

// スパム・宣伝違反記録用メモリデータ
const userMessageHistory = new Map(); // { userId: { text: string, count: number } }
const userSpamViolations = new Map(); // { userId: count }
const userAdViolations = new Map();   // { userId: count }
const userInappropriateViolations = new Map(); // { userId: count }

client.once('ready', () => {
    console.log(`${client.user.tag} 起動完了`);
});

// -------------------------------------------------------------
// 1. サーバー参加時
// -------------------------------------------------------------
client.on('guildMemberAdd', async (member) => {
    // Botの場合は未認証ロールではなく指定のロールを付与
    if (member.user.bot) {
        try {
            await member.roles.add(BOT_ROLE_ID);
        } catch (err) {
            console.error('Botロール付与エラー:', err);
        }
    }

    // 参加ログメッセージ (✏️ リアクションなし)
    const channel = member.guild.systemChannel || member.guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(member.guild.members.me).has(PermissionFlagsBits.SendMessages));
    if (channel) {
        channel.send(`${member.user.username} さんがサーバーに参加しました！`);
    }
});

// -------------------------------------------------------------
// 2. サーバー退出・キック・BAN時
// -------------------------------------------------------------
client.on('guildMemberRemove', async (member) => {
    const channel = member.guild.systemChannel || member.guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(member.guild.members.me).has(PermissionFlagsBits.SendMessages));
    if (!channel) return;

    // 監査ログからBAN/キックされたか調べる
    try {
        await new Promise(resolve => setTimeout(resolve, 1000)); // ログ反映待ち
        const fetchedLogs = await member.guild.fetchAuditLogs({ limit: 1 });
        const firstEntry = fetchedLogs.entries.first();

        if (firstEntry && firstEntry.target?.id === member.id) {
            if (firstEntry.action === AuditLogEvent.MemberKick && firstEntry.createdTimestamp > Date.now() - 5000) {
                return channel.send(`${member.user.username} さんがキックされました。`);
            }
            if (firstEntry.action === AuditLogEvent.MemberBanAdd && firstEntry.createdTimestamp > Date.now() - 5000) {
                return channel.send(`${member.user.username} さんがBANされました。`);
            }
        }
    } catch (e) {
        console.error('監査ログ取得エラー:', e);
    }

    // 通常の退出
    channel.send(`${member.user.username} さんがサーバーを退出しました。`);
});

// -------------------------------------------------------------
// 3. タイムアウト検知 (メンバー更新時)
// -------------------------------------------------------------
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const channel = newMember.guild.systemChannel || newMember.guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(newMember.guild.members.me).has(PermissionFlagsBits.SendMessages));
    if (!channel) return;

    // タイムアウトが付与されたかチェック
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
    const newTimeout = newMember.communicationDisabledUntilTimestamp;

    if (!oldTimeout && newTimeout && newTimeout > Date.now()) {
        const durationMinutes = Math.ceil((newTimeout - Date.now()) / (1000 * 60));
        channel.send(`${newMember.user.username} さんが ${durationMinutes} 分間タイムアウトされました。`);
    }
});

// -------------------------------------------------------------
// 4. メッセージ受信時の処理（スパム・宣伝・AI不適切検知）
// -------------------------------------------------------------
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;
    const content = message.content;
    const reportChannel = message.guild.channels.cache.get(REPORT_CHANNEL_ID);

    // --- A. スパム検知（同じ発言10回）---
    const userHistory = userMessageHistory.get(userId) || { text: '', count: 0 };
    if (userHistory.text === content && content.trim() !== '') {
        userHistory.count += 1;
    } else {
        userHistory.text = content;
        userHistory.count = 1;
    }
    userMessageHistory.set(userId, userHistory);

    if (userHistory.count >= 10) {
        userMessageHistory.set(userId, { text: '', count: 0 }); // リセット
        try { await message.delete(); } catch (_) {}

        const violations = (userSpamViolations.get(userId) || 0) + 1;
        userSpamViolations.set(userId, violations);

        if (reportChannel) {
            reportChannel.send(`⚠️ **スパム検知**: <@${userId}> が同じ連投を10回行いました。`);
        }

        if (violations >= 2) {
            // 2回目：1日タイムアウト
            try {
                await message.member.timeout(24 * 60 * 60 * 1000, 'スパム連投2回目');
                await message.author.send('⚠️ スパム連投が2回続いたため、1日間タイムアウトされました。');
            } catch (e) { console.error('タイムアウト失敗:', e); }
            userSpamViolations.set(userId, 0);
        } else {
            // 1回目：注意喚起
            try {
                await message.author.send('⚠️ **注意**: 連投（スパム行為）が検知されました。お控えください。次行うと1日間タイムアウトになります。');
            } catch (_) {}
        }
        return;
    }

    // --- B. 宣伝検知（指定チャンネル以外でのDiscord招待リンク・URL）---
    const isDiscordInvite = /(discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9]+/i.test(content);
    if (isDiscordInvite && message.channel.id !== AD_CHANNEL_ID) {
        try { await message.delete(); } catch (_) {}

        const violations = (userAdViolations.get(userId) || 0) + 1;
        userAdViolations.set(userId, violations);

        if (reportChannel) {
            reportChannel.send(`⚠️ **宣伝違反**: <@${userId}> が許可されていないチャンネルでサーバー宣伝を行いました。`);
        }

        if (violations >= 2) {
            try {
                await message.member.timeout(24 * 60 * 60 * 1000, '他サーバー宣伝2回目');
                await message.author.send('⚠️ 許可されていない場所での宣伝が2回続いたため、1日間タイムアウトされました。');
            } catch (e) { console.error('タイムアウト失敗:', e); }
            userAdViolations.set(userId, 0);
        } else {
            try {
                await message.author.send(`⚠️ **注意**: サーバーの宣伝は <#${AD_CHANNEL_ID}> で行ってください。次行うと1日間タイムアウトになります。`);
            } catch (_) {}
        }
        return;
    }

    // --- C. AIによる不適切なテキスト・画像検知 ---
    let hasAttachment = message.attachments.size > 0;
    if (content.length > 5 || hasAttachment) {
        try {
            const isSafe = await checkContentSafety(content, message.attachments);
            if (!isSafe) {
                try { await message.delete(); } catch (_) {}

                const violations = (userInappropriateViolations.get(userId) || 0) + 1;
                userInappropriateViolations.set(userId, violations);

                if (reportChannel) {
                    reportChannel.send(`🚨 **不適切コンテンツ検知**: <@${userId}> の投稿（メッセージまたはファイル）が削除されました。`);
                }

                if (violations >= 2) {
                    // 繰り返しの不適切投稿：3日間タイムアウト
                    try {
                        await message.member.timeout(3 * 24 * 60 * 60 * 1000, '不適切コンテンツの繰り返し投稿');
                        await message.author.send('🚨 不適切な投稿が複数回確認されたため、3日間タイムアウトされました。');
                    } catch (e) { console.error('タイムアウト失敗:', e); }
                } else {
                    try {
                        await message.author.send('⚠️ **注意**: 投稿された内容（文章またはファイル）が不適切と判定され削除されました。ルールを守って投稿してください。');
                    } catch (_) {}
                }
            }
        } catch (err) {
            console.error('安全チェックエラー:', err);
        }
    }
});

// -------------------------------------------------------------
// Gemini API を使用した不適切コンテンツ判定関数
// -------------------------------------------------------------
async function checkContentSafety(text, attachments) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const prompt = "以下のテキストおよび画像が、公序良俗に反する内容、暴力的、過度に性的な表現、スパム、あるいは深刻な誹謗中傷を含んでいるか判定してください。「SAFE」または「UNSAFE」の一言だけを返してください。";

        let contents = [prompt, text || ""];

        // 添付画像の処理（1枚目のみ判定）
        if (attachments.size > 0) {
            const firstAttachment = attachments.first();
            if (firstAttachment.contentType && firstAttachment.contentType.startsWith('image/')) {
                const response = await fetch(firstAttachment.url);
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

        const result = await model.generateContent(contents);
        const responseText = result.response.text().trim().toUpperCase();
        return !responseText.includes("UNSAFE");
    } catch (e) {
        console.error('AI安全判定エラー:', e);
        return true; // エラー時は安全と判定して誤削除を防ぐ
    }
}

client.login(process.env.DISCORD_TOKEN);
