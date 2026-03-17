// ═══════════════════════════════════════════════════════════════
//  To7e Bot v2  —  Node.js
//  🎵 موسيقى (صوت فقط)  |  🎬 أفلام ومسلسلات (بث صوت + صورة)
// ═══════════════════════════════════════════════════════════════

"use strict";

const {
    Client, GatewayIntentBits, REST, Routes,
    SlashCommandBuilder, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require("discord.js");

const {
    joinVoiceChannel, createAudioPlayer, createAudioResource,
    AudioPlayerStatus, VoiceConnectionStatus, entersState,
    StreamType,
} = require("@discordjs/voice");

const { Streamer, playStream, prepareStream } = require("@dank074/discord-video-stream");
const ytdlp  = require("yt-dlp-exec");
const ffmpeg = require("ffmpeg-static");
const { spawn } = require("child_process");
const path   = require("path");
const fs     = require("fs");
const os     = require("os");

// ── Config ───────────────────────────────────────────────────────────────────
const TOKEN     = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || "1482952567179837541";
if (!TOKEN) { console.error("❌ TOKEN غير موجود! ضعه في متغيرات البيئة."); process.exit(1); }

// ── Client + Streamer ─────────────────────────────────────────────────────────
const client   = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const streamer = new Streamer(client);

// ── Per-guild state ───────────────────────────────────────────────────────────
const servers = new Map();
function getServer(gid) {
    if (!servers.has(gid)) servers.set(gid, { queue: [], current: null, player: null, connection: null, streaming: false, streamStopper: null, inactiveTimer: null, lastChannel: null });
    return servers.get(gid);
}

// ── Inactivity auto-leave (3 minutes) ────────────────────────────────────────
const INACTIVE_MS = 3 * 60 * 1000; // 3 minutes

function resetInactiveTimer(guildId) {
    const s = getServer(guildId);
    if (s.inactiveTimer) clearTimeout(s.inactiveTimer);
    s.inactiveTimer = setTimeout(async () => {
        const server = getServer(guildId);
        // Only leave if nothing is playing and not streaming
        if (server.player && server.player.state.status === AudioPlayerStatus.Playing) return;
        if (server.streaming) return;
        // Leave voice
        if (server.connection && server.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            server.connection.destroy();
        }
        server.connection = null;
        server.player     = null;
        server.queue      = [];
        server.current    = null;
        server.inactiveTimer = null;
        // Send message
        if (server.lastChannel) {
            try {
                await server.lastChannel.send("⏰ مرت **3 دقائق** بدون تشغيل شي، خرجت من الروم. استخدم `/play` للعودة.");
            } catch {}
        }
    }, INACTIVE_MS);
}

function cancelInactiveTimer(guildId) {
    const s = getServer(guildId);
    if (s.inactiveTimer) { clearTimeout(s.inactiveTimer); s.inactiveTimer = null; }
}

// ── Cache for search buttons (short-lived, music only) ───────────────────────
// For films/series we store the YouTube ID directly in the button customId
// so buttons survive bot restarts.
const searchCache = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDur(s) {
    if (!s) return "🔴 Live";
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
    return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${m}:${String(sec).padStart(2,"0")}`;
}
function fmtNum(n) {
    if (!n) return "—";
    return n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}K` : String(n);
}
function buildInfo(e, fb = "") {
    const id = e.id || "";
    return {
        title:    e.title       || "—",
        url:      e.webpage_url || e.url || (id ? `https://youtu.be/${id}` : fb),
        thumb:    e.thumbnail   || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ""),
        duration: e.duration    || 0,
        uploader: e.uploader    || e.channel || "—",
        views:    e.view_count  || 0,
        ytUrl:    e.url         || e.webpage_url || (id ? `https://www.youtube.com/watch?v=${id}` : fb),
        id:       id,
    };
}
function musicEmbed(info, label) {
    const e = new EmbedBuilder().setTitle(info.title).setURL(info.url).setAuthor({ name: label }).setColor(0x1DB954)
        .addFields({ name:"⏱ المدة", value:fmtDur(info.duration), inline:true },
                   { name:"🎤 الفنان", value:info.uploader, inline:true },
                   { name:"👁 مشاهدات", value:fmtNum(info.views), inline:true });
    if (info.thumb) e.setThumbnail(info.thumb);
    return e;
}

// ── yt-dlp helpers ────────────────────────────────────────────────────────────
async function ytSearch(query, count = 1) {
    const q    = count > 1 ? `ytsearch${count}:${query}` : `ytsearch:${query}`;
    const data = await ytdlp(q, { dumpSingleJson: true, noPlaylist: true, flatPlaylist: true, socketTimeout: 15 });
    if (data.entries) return count === 1 ? data.entries[0] : data.entries.filter(Boolean).slice(0, count);
    return data;
}
async function ytInfo(url) {
    const data = await ytdlp(url, { dumpSingleJson: true, noPlaylist: true, socketTimeout: 20 });
    return data.entries ? data.entries[0] : data;
}
async function getAudioUrl(url) {
    const r = await ytdlp(url, { format: "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best", noPlaylist: true, getUrl: true, socketTimeout: 20 });
    return String(r).trim();
}

// ── Film search — filters out reviews/trailers/reactions ─────────────────────
// Keywords that indicate NOT a full movie
const JUNK_WORDS = /review|reaction|trailer|clip|scene|interview|behind|making|facts|cast|explained|ending|recap|analysis|مراجعة|ملخص|مقطع|اعلان|إعلان/i;

async function searchMedia(name, isSeries) {
    const minDur = isSeries ? 600 : 3000; // 10min for series episodes, 50min for movies
    const results = [];

    const queries = isSeries
        ? [`ytsearch15:${name} مسلسل كامل مترجم`, `ytsearch15:${name} full episode arabic`, `ytsearch10:${name} series episode`]
        : [`ytsearch15:${name} فيلم كامل مترجم`,  `ytsearch15:${name} full movie`,          `ytsearch15:${name} فيلم كامل`];

    for (const q of queries) {
        try {
            const data = await ytdlp(q, { dumpSingleJson: true, flatPlaylist: true, socketTimeout: 18 });
            const entries = (data.entries || []).filter(e =>
                e &&
                (e.duration || 0) > minDur &&          // long enough
                !JUNK_WORDS.test(e.title || "") &&      // not a review/trailer
                e.id                                    // has valid ID
            );
            results.push(...entries);
            if (results.length >= 5) break;
        } catch {}
    }

    // fallback without junk filter if nothing found
    if (!results.length) {
        try {
            const q    = isSeries ? `ytsearch8:${name} full episode` : `ytsearch8:${name} full movie`;
            const data = await ytdlp(q, { dumpSingleJson: true, flatPlaylist: true, socketTimeout: 15 });
            results.push(...(data.entries || []).filter(e => e && e.id && (e.duration || 0) > minDur / 2).slice(0, 5));
        } catch {}
    }

    return results.slice(0, 5);
}

// ── Voice helpers ─────────────────────────────────────────────────────────────
async function connectVoice(interaction) {
    const ch = interaction.member.voice?.channel;
    if (!ch) throw new Error("ادخل روم صوتي أول!");
    const s = getServer(interaction.guildId);
    if (s.connection && s.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        if (s.connection.joinConfig.channelId === ch.id) return s.connection;
        s.connection.destroy();
    }
    s.connection  = joinVoiceChannel({ channelId: ch.id, guildId: interaction.guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true });
    s.lastChannel = interaction.channel;
    try { await entersState(s.connection, VoiceConnectionStatus.Ready, 20_000); }
    catch { s.connection.destroy(); s.connection = null; throw new Error("فشل الاتصال بالروم الصوتي."); }
    resetInactiveTimer(interaction.guildId);  // start 3-min countdown
    return s.connection;
}

// ── Music player ──────────────────────────────────────────────────────────────
async function playNext(channel, guildId, fail = 0) {
    const s = getServer(guildId);
    if (!s.connection || s.connection.state.status === VoiceConnectionStatus.Destroyed) { s.current = null; s.queue = []; return; }
    if (!s.queue.length) { s.current = null; resetInactiveTimer(guildId); await channel.send("✅ انتهت قائمة التشغيل."); return; }
    if (fail >= 3)       { s.current = null; s.queue = []; await channel.send("❌ فشل 3 مقاطع."); return; }
    const info = s.queue.shift(); s.current = info;
    try {
        const url  = await getAudioUrl(info.ytUrl);
        const res  = createAudioResource(url, { inputType: StreamType.Arbitrary, inlineVolume: true });
        res.volume?.setVolume(1);
        if (!s.player) {
            s.player = createAudioPlayer();
            s.player.on(AudioPlayerStatus.Idle, () => playNext(channel, guildId));
            s.player.on("error", err => { console.error("Player:", err); playNext(channel, guildId, fail + 1); });
        }
        cancelInactiveTimer(guildId);  // playing — cancel inactivity countdown
        s.connection.subscribe(s.player);
        s.player.play(res);
        await channel.send({ embeds: [musicEmbed(info, "يشغل الآن 🎵")] });
    } catch (e) {
        console.error("playNext:", e.message);
        await channel.send(`⚠️ تخطي **${info.title}**`);
        await playNext(channel, guildId, fail + 1);
    }
}

async function doPlayMusic(interaction, query) {
    const conn = await connectVoice(interaction);
    let entry;
    if (query.startsWith("http")) { entry = await ytInfo(query); }
    else { entry = await ytSearch(query, 1); }
    const info = buildInfo(entry, query);
    const s    = getServer(interaction.guildId);
    const isActive = s.player && [AudioPlayerStatus.Playing, AudioPlayerStatus.Paused].includes(s.player.state.status);
    if (isActive) {
        s.queue.push(info);
        return interaction.followUp({ embeds: [musicEmbed(info, `✅ أضيف للقائمة #${s.queue.length}`)] });
    }
    s.current = info;
    await interaction.followUp({ embeds: [musicEmbed(info, "⏳ جاري التحميل...")] });
    const url = await getAudioUrl(info.ytUrl);
    const res = createAudioResource(url, { inputType: StreamType.Arbitrary, inlineVolume: true });
    res.volume?.setVolume(1);
    if (!s.player) {
        s.player = createAudioPlayer();
        s.player.on(AudioPlayerStatus.Idle, () => {
            resetInactiveTimer(interaction.guildId);   // queue empty — start 3-min countdown
            playNext(interaction.channel, interaction.guildId);
        });
        s.player.on("error", err => console.error("Player:", err));
    }
    cancelInactiveTimer(interaction.guildId);   // playing — cancel countdown
    conn.subscribe(s.player);
    s.player.play(res);
    await interaction.channel.send({ embeds: [musicEmbed(info, "يشغل الآن 🎵")] });
}

// ── Film/Series stream ────────────────────────────────────────────────────────
async function streamMedia(interaction, videoId, isSeries = false) {
    const s       = getServer(interaction.guildId);
    const voiceCh = interaction.member.voice?.channel;
    if (!voiceCh) throw new Error("ادخل روم صوتي أول!");

    // Stop previous stream
    if (s.streamStopper) { try { s.streamStopper(); } catch {} s.streamStopper = null; }
    if (s.streaming)     { try { await streamer.stopStream(); } catch {} s.streaming = false; }

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    await interaction.followUp({ content: "⏳ جاري جلب معلومات البث..." });

    // Get video info
    let entry;
    try { entry = await ytInfo(url); }
    catch (e) { throw new Error(`فشل جلب معلومات الفيلم: ${e.message}`); }

    const info = buildInfo(entry, url);

    // Get video+audio URLs
    let videoUrl, audioUrl;
    try {
        const data = await ytdlp(url, {
            dumpSingleJson: true, noPlaylist: true,
            format: "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best",
            socketTimeout: 25,
        });
        if (data.requested_formats?.length >= 2) {
            videoUrl = data.requested_formats[0].url;
            audioUrl = data.requested_formats[1].url;
        } else {
            videoUrl = audioUrl = data.url;
        }
    } catch (e) { throw new Error(`فشل جلب رابط البث: ${e.message}`); }

    // Download Arabic subtitles
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "to7e-"));
    let subsPath = null;
    try {
        await ytdlp(url, { writeAutoSubs: true, writeSubs: true, subLangs: "ar", convertSubs: "srt", skipDownload: true, output: path.join(tmpDir, "media"), socketTimeout: 15 });
        const sf = fs.readdirSync(tmpDir).find(f => /\.(srt|vtt|ass)$/.test(f));
        if (sf) subsPath = path.join(tmpDir, sf);
    } catch {}

    if (subsPath) await interaction.channel.send("✅ تم العثور على الترجمة العربية!");
    else          await interaction.channel.send("⚠️ لا تتوفر ترجمة عربية.");

    // Join voice via discord-video-stream
    try { await streamer.joinVoice(interaction.guildId, voiceCh.id); }
    catch (e) { throw new Error(`فشل الانضمام للروم: ${e.message}`); }

    s.streaming = true;

    // Build ffmpeg args for subtitle support
    const ffArgs = ["-re", "-i", videoUrl];
    if (audioUrl !== videoUrl) ffArgs.push("-i", audioUrl);
    if (subsPath) {
        const safe = subsPath.replace(/\\/g, "/").replace(/:/g, "\\:");
        ffArgs.push("-vf", `subtitles='${safe}':force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H000000FF,Outline=2,Alignment=2'`);
    }
    if (audioUrl !== videoUrl) ffArgs.push("-map", "0:v:0", "-map", "1:a:0");
    ffArgs.push("-c:v","libx264","-preset","ultrafast","-tune","zerolatency","-b:v","1500k","-maxrate","2500k","-bufsize","5000k","-pix_fmt","yuv420p","-g","60","-c:a","aac","-b:a","192k","-ar","48000","-f","mpegts","pipe:1");

    const ffProc = spawn(ffmpeg, ffArgs, { stdio: ["ignore", "pipe", "pipe"] });
    s.streamStopper = () => { try { ffProc.kill("SIGKILL"); } catch {} };
    ffProc.stderr.on("data", d => { const l = d.toString(); if (l.includes("Error")) console.error("[ffmpeg]", l.trim()); });
    ffProc.on("close", () => { s.streaming = false; try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    // Use v5 API: playStream(input, streamer, options)
    try {
        await playStream(ffProc.stdout, streamer, {
            width:                      1280,
            height:                     720,
            frameRate:                  30,
            bitrateVideo:               1500,
            bitrateVideoMax:            2500,
            bitrateAudio:               192,
            includeAudio:               true,
            hardwareAcceleratedDecoding: false,
            videoCodec:                 "H264",
            h26xPreset:                 "ultrafast",
        });
    } catch (e) { console.error("playStream:", e.message); }

    // Announcement embed
    const embed = new EmbedBuilder()
        .setTitle(`${isSeries ? "📺" : "🎬"} ${info.title}`)
        .setDescription(`**البث مباشر في الروم الصوتي!**\n\nاضغط **Go Live (📡)** بجانب اسم البوت في الروم للمشاهدة`)
        .setColor(isSeries ? 0x0099FF : 0xFF0000)
        .addFields(
            { name: "⏱ المدة",   value: fmtDur(info.duration),           inline: true },
            { name: "📺 القناة", value: info.uploader,                    inline: true },
            { name: "🔤 ترجمة",  value: subsPath ? "✅ عربي" : "❌ لا",  inline: true },
        );
    if (info.thumb) embed.setThumbnail(info.thumb);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`stopstream_${interaction.guildId}`).setLabel("🛑 إيقاف البث").setStyle(ButtonStyle.Danger)
    );
    await interaction.channel.send({ embeds: [embed], components: [row] });
}

// ══════════════════════════════════════════════════════════════════════════════
//  Slash commands list
// ══════════════════════════════════════════════════════════════════════════════
const CMDS = [
    new SlashCommandBuilder().setName("play").setDescription("🎵 شغّل أغنية في الروم الصوتي").addStringOption(o => o.setName("query").setDescription("اسم الأغنية أو رابط").setRequired(true)),
    new SlashCommandBuilder().setName("search").setDescription("🔍 ابحث عن أغنية (5 نتائج)").addStringOption(o => o.setName("query").setDescription("اسم الأغنية").setRequired(true)),
    new SlashCommandBuilder().setName("url").setDescription("🌐 شغّل من أي رابط (يوتيوب، ساوند كلاود...)").addStringOption(o => o.setName("link").setDescription("الرابط الكامل").setRequired(true)),
    new SlashCommandBuilder().setName("pause").setDescription("⏸️ إيقاف مؤقت"),
    new SlashCommandBuilder().setName("resume").setDescription("▶️ استئناف"),
    new SlashCommandBuilder().setName("skip").setDescription("⏭️ تخطي الأغنية"),
    new SlashCommandBuilder().setName("stop").setDescription("⏹️ إيقاف كامل والخروج"),
    new SlashCommandBuilder().setName("queue").setDescription("📋 قائمة التشغيل"),
    new SlashCommandBuilder().setName("nowplaying").setDescription("🎵 ماذا يشتغل الآن"),
    new SlashCommandBuilder().setName("volume").setDescription("🔊 مستوى الصوت 1-100").addIntegerOption(o => o.setName("level").setDescription("1-100").setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName("clear").setDescription("🗑️ مسح قائمة التشغيل"),
    new SlashCommandBuilder().setName("join").setDescription("🎤 انضمام للروم الصوتي"),
    new SlashCommandBuilder().setName("leave").setDescription("👋 مغادرة الروم"),
    new SlashCommandBuilder().setName("film").setDescription("🎬 ابحث عن فيلم وابثه في الروم (صوت+صورة+ترجمة)").addStringOption(o => o.setName("name").setDescription("اسم الفيلم").setRequired(true)),
    new SlashCommandBuilder().setName("series").setDescription("📺 ابحث عن مسلسل وابثه في الروم (صوت+صورة+ترجمة)").addStringOption(o => o.setName("name").setDescription("اسم المسلسل").setRequired(true)),
    new SlashCommandBuilder().setName("stream").setDescription("📡 ابث أي رابط مباشرة في الروم").addStringOption(o => o.setName("url").setDescription("الرابط الكامل").setRequired(true)),
    new SlashCommandBuilder().setName("stopstream").setDescription("🛑 إيقاف البث الحالي"),
    new SlashCommandBuilder().setName("help").setDescription("📖 جميع الأوامر مع أزرار التحكم"),
].map(c => c.toJSON());

// ══════════════════════════════════════════════════════════════════════════════
//  Ready
// ══════════════════════════════════════════════════════════════════════════════
client.once("ready", async () => {
    console.log(`✅ Ready: ${client.user.tag}`);
    try {
        await new REST({ version: "10" }).setToken(TOKEN).put(Routes.applicationCommands(CLIENT_ID), { body: CMDS });
        console.log(`✅ Synced ${CMDS.length} commands`);
    } catch (e) { console.error("Sync error:", e); }
    client.user.setActivity("/play | /film | /series", { type: 2 });
});

// ══════════════════════════════════════════════════════════════════════════════
//  Interactions
// ══════════════════════════════════════════════════════════════════════════════
client.on("interactionCreate", async interaction => {
    try {
        if      (interaction.isChatInputCommand()) await handleCmd(interaction);
        else if (interaction.isButton())           await handleBtn(interaction);
    } catch (e) {
        console.error("Error:", e);
        const msg = `❌ خطأ: \`${e.message}\``;
        try { interaction.deferred || interaction.replied ? await interaction.followUp({ content: msg, ephemeral: true }) : await interaction.reply({ content: msg, ephemeral: true }); } catch {}
    }
});

// ══════════════════════════════════════════════════════════════════════════════
//  Command handlers
// ══════════════════════════════════════════════════════════════════════════════
async function handleCmd(i) {
    const cmd = i.commandName;

    // ── Music ────────────────────────────────────────────────────────────────
    if (cmd === "play") {
        if (!i.member.voice?.channel) return i.reply({ content: "❌ ادخل روم صوتي أول!", ephemeral: true });
        await i.deferReply();
        return doPlayMusic(i, i.options.getString("query"));
    }

    if (cmd === "search") {
        await i.deferReply();
        const entries = await ytSearch(i.options.getString("query"), 5);
        const arr = Array.isArray(entries) ? entries : [entries];
        if (!arr.length) return i.followUp({ content: "❌ لا نتائج.", ephemeral: true });
        const nums  = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣"];
        const embed = new EmbedBuilder().setTitle(`🔍 ${i.options.getString("query")}`).setColor(0x1DB954).setDescription("اضغط زر لتشغيل الأغنية 👇");
        arr.forEach((e, idx) => embed.addFields({ name: `${nums[idx]} ${e.title||"—"}`, value: `⏱ ${fmtDur(e.duration)} | 🎤 ${e.uploader||e.channel||"—"}`, inline: false }));
        searchCache.set(i.id, arr);
        setTimeout(() => searchCache.delete(i.id), 120_000);
        const row = new ActionRowBuilder();
        arr.slice(0,5).forEach((e, idx) => row.addComponents(new ButtonBuilder().setCustomId(`s_${idx}_${i.id}`).setLabel(`${nums[idx]} ${(e.title||"").substring(0,30)}`).setStyle(ButtonStyle.Primary)));
        return i.followUp({ embeds: [embed], components: [row] });
    }

    if (cmd === "url") {
        const link = i.options.getString("link");
        if (!link.startsWith("http")) return i.reply({ content: "❌ رابط غير صالح.", ephemeral: true });
        if (!i.member.voice?.channel) return i.reply({ content: "❌ ادخل روم صوتي أول!", ephemeral: true });
        await i.deferReply();
        return doPlayMusic(i, link);
    }

    if (cmd === "pause") {
        const s = getServer(i.guildId);
        return s.player?.state?.status === AudioPlayerStatus.Playing
            ? (s.player.pause(), i.reply("⏸️ تم الإيقاف المؤقت."))
            : i.reply({ content: "❌ لا يوجد شيء يشتغل.", ephemeral: true });
    }
    if (cmd === "resume") {
        const s = getServer(i.guildId);
        return s.player?.state?.status === AudioPlayerStatus.Paused
            ? (s.player.unpause(), i.reply("▶️ تم الاستئناف."))
            : i.reply({ content: "❌ لا يوجد شيء موقوف.", ephemeral: true });
    }
    if (cmd === "skip") {
        const s = getServer(i.guildId);
        return s.player && s.player.state.status !== AudioPlayerStatus.Idle
            ? (s.player.stop(), i.reply("⏭️ تم التخطي."))
            : i.reply({ content: "❌ لا يوجد شيء يشتغل.", ephemeral: true });
    }
    if (cmd === "stop") {
        const s = getServer(i.guildId);
        cancelInactiveTimer(i.guildId);
        s.queue = []; s.current = null; s.player?.stop(); s.connection?.destroy(); s.connection = null; s.player = null;
        return i.reply("⏹️ تم الإيقاف والخروج.");
    }
    if (cmd === "queue") {
        const s = getServer(i.guildId);
        if (!s.current && !s.queue.length) return i.reply({ content: "📭 القائمة فارغة.", ephemeral: true });
        const embed = new EmbedBuilder().setTitle("📋 قائمة التشغيل").setColor(0x1DB954);
        if (s.current) embed.addFields({ name: "▶️ يشغل الآن", value: `[${s.current.title}](${s.current.url}) — ${fmtDur(s.current.duration)}`, inline: false });
        if (s.queue.length) embed.addFields({ name: "التالي", value: s.queue.slice(0,10).map((it,j) => `\`${j+1}.\` [${it.title}](${it.url}) — ${fmtDur(it.duration)}`).join("\n"), inline: false });
        return i.reply({ embeds: [embed] });
    }
    if (cmd === "nowplaying") {
        const s = getServer(i.guildId);
        return s.current ? i.reply({ embeds: [musicEmbed(s.current, "يشغل الآن 🎵")] }) : i.reply({ content: "❌ لا شيء يشتغل.", ephemeral: true });
    }
    if (cmd === "volume") {
        const s = getServer(i.guildId), level = i.options.getInteger("level");
        if (!s.player || s.player.state.status === AudioPlayerStatus.Idle) return i.reply({ content: "❌ لا شيء يشتغل.", ephemeral: true });
        s.player.state.resource?.volume?.setVolume(level / 100);
        return i.reply(`🔊 الصوت: ${level}%`);
    }
    if (cmd === "clear") { getServer(i.guildId).queue = []; return i.reply("🗑️ تم مسح القائمة."); }
    if (cmd === "join") {
        if (!i.member.voice?.channel) return i.reply({ content: "❌ ادخل روم صوتي أول!", ephemeral: true });
        await i.deferReply();
        const conn = await connectVoice(i);
        return i.followUp(`✅ انضممت إلى **${i.member.voice.channel.name}**`);
    }
    if (cmd === "leave") {
        const s = getServer(i.guildId);
        if (!s.connection) return i.reply({ content: "❌ البوت مو في روم صوتي.", ephemeral: true });
        cancelInactiveTimer(i.guildId);
        s.queue = []; s.current = null; s.player?.stop(); s.connection.destroy(); s.connection = null; s.player = null;
        return i.reply("👋 تمت المغادرة.");
    }

    // ── Films & Series ───────────────────────────────────────────────────────
    if (cmd === "film" || cmd === "series") {
        const isSeries = cmd === "series";
        if (!i.member.voice?.channel) return i.reply({ content: "❌ ادخل روم صوتي أول!", ephemeral: true });
        await i.deferReply();
        const name  = i.options.getString("name");
        const items = await searchMedia(name, isSeries);
        if (!items.length) return i.followUp({ content: "❌ ما وجدنا أفلام كاملة. جرب الاسم بالإنجليزي.", ephemeral: true });

        const nums  = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣"];
        const icon  = isSeries ? "📺" : "🎬";
        const embed = new EmbedBuilder().setTitle(`${icon} نتائج: ${name}`).setDescription("اختر للبث المباشر في الروم (صوت + صورة + ترجمة) 👇").setColor(isSeries ? 0x0099FF : 0xFF0000);
        if (items[0]?.thumbnail) embed.setThumbnail(items[0].thumbnail);

        const row = new ActionRowBuilder();
        items.forEach((f, idx) => {
            const dur  = f.duration || 0;
            const h = Math.floor(dur/3600), m = Math.floor((dur%3600)/60), s = Math.floor(dur%60);
            const ds = dur ? (h ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`) : "—";
            embed.addFields({ name: `${nums[idx]} ${f.title||"—"}`, value: `⏱ ${ds} | 📺 ${f.uploader||f.channel||"—"}`, inline: false });

            // ── KEY FIX: store YouTube ID in button customId — survives restarts ──
            const vid = f.id || "";
            const series_flag = isSeries ? "1" : "0";
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`m_${vid}_${series_flag}`)   // max ~25 chars — well within 100 limit
                    .setLabel(`${nums[idx]} ${(f.title||"—").substring(0,30)}`)
                    .setStyle(isSeries ? ButtonStyle.Primary : ButtonStyle.Danger)
            );
        });

        embed.setFooter({ text: "الأزرار تعمل دائماً حتى بعد إعادة تشغيل البوت ✅" });
        return i.followUp({ embeds: [embed], components: [row] });
    }

    if (cmd === "stream") {
        const link = i.options.getString("url");
        if (!link.startsWith("http")) return i.reply({ content: "❌ رابط غير صالح.", ephemeral: true });
        if (!i.member.voice?.channel) return i.reply({ content: "❌ ادخل روم صوتي أول!", ephemeral: true });
        await i.deferReply();
        const entry = await ytInfo(link);
        const info  = buildInfo(entry, link);
        if (!info.id) throw new Error("لم نتمكن من جلب معلومات الرابط.");
        return streamMedia(i, info.id, false);
    }

    if (cmd === "stopstream") {
        const s = getServer(i.guildId);
        if (!s.streaming && !s.streamStopper) return i.reply({ content: "❌ لا يوجد بث يشتغل.", ephemeral: true });
        if (s.streamStopper) { s.streamStopper(); s.streamStopper = null; }
        s.streaming = false; try { await streamer.stopStream(); } catch {}
        return i.reply("🛑 تم إيقاف البث.");
    }

    if (cmd === "help") {
        const embed = new EmbedBuilder().setTitle("📖 أوامر To7e Bot").setColor(0x5865F2)
            .addFields(
                { name: "🎵 الموسيقى", value: ["`/play` — تشغيل أغنية (يدخل الروم تلقائياً)", "`/search` — بحث 5 نتائج بأزرار", "`/url` — من أي موقع", "`/pause` `/resume` `/skip` `/stop`", "`/queue` `/nowplaying` `/volume` `/clear`", "`/join` `/leave`"].join("\n"), inline: false },
                { name: "🎬 أفلام ومسلسلات (صوت + صورة + ترجمة عربية)", value: ["`/film <اسم>` — بث فيلم كامل في الروم", "`/series <اسم>` — بث مسلسل في الروم", "`/stream <رابط>` — بث من أي رابط", "`/stopstream` — إيقاف البث", "↳ بعد البث: اضغط **Go Live 📡** بجانب البوت"].join("\n"), inline: false }
            )
            .setFooter({ text: "To7e Bot • الموسيقى والأفلام منفصلة تماماً" });

        const r1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("hp").setLabel("⏸ وقف").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("hr").setLabel("▶ استئناف").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("hsk").setLabel("⏭ تخطي").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("hst").setLabel("⏹ إيقاف").setStyle(ButtonStyle.Danger),
        );
        const r2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("hq").setLabel("📋 القائمة").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("hn").setLabel("🎵 الآن").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("hss").setLabel("🛑 وقف البث").setStyle(ButtonStyle.Danger),
        );
        return i.reply({ embeds: [embed], components: [r1, r2] });
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Button handlers
// ══════════════════════════════════════════════════════════════════════════════
async function handleBtn(i) {
    const id = i.customId;

    // Music search result button: s_{idx}_{interactionId}
    if (id.startsWith("s_")) {
        const parts = id.split("_");
        const idx   = parseInt(parts[1]);
        const oid   = parts[2];
        const arr   = searchCache.get(oid);
        if (!arr) return i.reply({ content: "❌ انتهت صلاحية الأزرار (دقيقتان). استخدم /search مرة أخرى.", ephemeral: true });
        if (!i.member.voice?.channel) return i.reply({ content: "❌ ادخل روم صوتي أول!", ephemeral: true });
        await i.deferReply();
        const e   = arr[idx];
        const url = e.url || e.webpage_url || `https://www.youtube.com/watch?v=${e.id}`;
        return doPlayMusic(i, url);
    }

    // Film/Series button: m_{videoId}_{0|1} — no cache needed, ID stored in customId
    if (id.startsWith("m_")) {
        const parts    = id.split("_");
        const videoId  = parts[1];
        const isSeries = parts[2] === "1";
        if (!i.member.voice?.channel) return i.reply({ content: "❌ ادخل روم صوتي أول!", ephemeral: true });
        if (!videoId) return i.reply({ content: "❌ معرّف الفيلم غير صالح.", ephemeral: true });
        await i.deferReply();
        return streamMedia(i, videoId, isSeries);
    }

    // Stop stream button
    if (id.startsWith("stopstream_")) {
        const s = getServer(i.guildId);
        if (s.streamStopper) { s.streamStopper(); s.streamStopper = null; }
        s.streaming = false; try { await streamer.stopStream(); } catch {}
        return i.reply("🛑 تم إيقاف البث.");
    }

    // Help buttons
    const s = getServer(i.guildId);
    if (id==="hp")  { s.player?.state?.status===AudioPlayerStatus.Playing  ? (s.player.pause(),    i.reply({content:"⏸️ تم.",ephemeral:true})) : i.reply({content:"❌ لا شيء.",ephemeral:true}); }
    if (id==="hr")  { s.player?.state?.status===AudioPlayerStatus.Paused   ? (s.player.unpause(),  i.reply({content:"▶️ تم.",ephemeral:true})) : i.reply({content:"❌ لا شيء.",ephemeral:true}); }
    if (id==="hsk") { s.player&&s.player.state.status!==AudioPlayerStatus.Idle ? (s.player.stop(), i.reply({content:"⏭️ تم.",ephemeral:true})) : i.reply({content:"❌ لا شيء.",ephemeral:true}); }
    if (id==="hst") { s.queue=[]; s.current=null; s.player?.stop(); s.connection?.destroy(); s.connection=null; s.player=null; i.reply({content:"⏹️ تم.",ephemeral:true}); }
    if (id==="hq")  {
        if (!s.current && !s.queue.length) return i.reply({content:"📭 فارغة.",ephemeral:true});
        const e = new EmbedBuilder().setTitle("📋 القائمة").setColor(0x1DB954);
        if (s.current) e.addFields({name:"▶️ الآن",value:`[${s.current.title}](${s.current.url}) — ${fmtDur(s.current.duration)}`,inline:false});
        if (s.queue.length) e.addFields({name:"التالي",value:s.queue.slice(0,10).map((it,j)=>`\`${j+1}.\` ${it.title}`).join("\n"),inline:false});
        i.reply({embeds:[e],ephemeral:true});
    }
    if (id==="hn")  { s.current ? i.reply({embeds:[musicEmbed(s.current,"يشغل الآن 🎵")],ephemeral:true}) : i.reply({content:"❌ لا شيء.",ephemeral:true}); }
    if (id==="hss") {
        if (s.streamStopper) { s.streamStopper(); s.streamStopper=null; }
        s.streaming=false; try{await streamer.stopStream();}catch{}
        i.reply({content:"🛑 تم.",ephemeral:true});
    }
}

// ── Start ─────────────────────────────────────────────────────────────────────
client.login(TOKEN);
