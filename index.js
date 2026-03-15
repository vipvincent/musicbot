require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags
} = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  console.error('❌ 缺少環境變數：請在 .env 中設定 DISCORD_BOT_TOKEN 與 DISCORD_CLIENT_ID');
  process.exit(1);
}

const lavalinkHost = process.env.LAVALINK_HOST || '127.0.0.1';
const lavalinkPort = process.env.LAVALINK_PORT || '2333';
const lavalinkPassword = process.env.LAVALINK_PASSWORD || 'youshallnotpass';
const lavalinkSecure = (process.env.LAVALINK_SECURE || 'false').toLowerCase() === 'true';

// ─── Logger ──────────────────────────────────────────────────────────────────
const log = {
  info:  (...a) => console.log (`[${new Date().toISOString()}] INFO `, ...a),
  warn:  (...a) => console.warn(`[${new Date().toISOString()}] WARN `, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] ERROR`, ...a),
};
function guildLabel(guildId) {
  const g = client?.guilds?.cache?.get(guildId);
  return g ? `[${g.name}]` : `[${guildId}]`;
}
// ─────────────────────────────────────────────────────────────────────────────

const nodes = [
  {
    name: 'default',
    url: `${lavalinkHost}:${lavalinkPort}`,
    auth: lavalinkPassword,
    secure: lavalinkSecure
  }
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

// reconnectTries: Infinity = 永不放棄重連（斷線後）
// reconnectInterval 單位為「秒」
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), nodes, {
  resume: true,
  resumeTimeout: 30,
  reconnectTries: 1,         // 最少需要 1 次才會觸發 disconnect
  reconnectInterval: 0       // 等待 0 秒，立即失敗交由我們的 handler
});

// patch addNode：每次加入節點後監聽 node 的 disconnect，實現無限重連
function attachNodeDisconnectHandler(nodeName) {
  const node = shoukaku.nodes.get(nodeName);
  if (!node) return;
  node.once('disconnect', () => {   // once：每個節點只觸發一次
    lavalinkReady = false;
    if (!isWaitingReconnect) {
      isWaitingReconnect = true;
      log.warn(`Lavalink 節點 [${nodeName}] 斷線，5 秒後重試...`);
    }
    setTimeout(() => {
      isWaitingReconnect = false;
      if (lavalinkReady) return;
      log.info(`正在重新加入 Lavalink 節點 [${nodeName}]...`);
      shoukaku.addNode({
        name: nodeName,
        url: `${lavalinkHost}:${lavalinkPort}`,
        auth: lavalinkPassword,
        secure: lavalinkSecure
      });
    }, 5000);
  });
}

const _origAddNode = shoukaku.addNode.bind(shoukaku);
shoukaku.addNode = function(options) {
  _origAddNode(options);
  setImmediate(() => attachNodeDisconnectHandler(options.name));
};

// 對初始節點（建構子已加入）補掛監聽
setImmediate(() => attachNodeDisconnectHandler('default'));

let isReconnecting = false;
let isWaitingReconnect = false;  // 已排程重連，避免重複印 log

const guildStates = new Map();
const pendingPlayChoices = new Map();
// key 格式：`${userId}:${guildId}`，避免同一使用者在不同 guild 互相覆蓋
let lavalinkReady = false;
let lavalinkEverReady = false;  // 是否曾經成功連線過
const NODE_STATE_CONNECTED = 1;

/** 將所有 guild 播放狀態暫停並通知文字頻道 */
async function pauseAllGuilds() {
  for (const [guildId, state] of guildStates.entries()) {
    try {
      clearIdle(state);
      // 標記為需要重連後繼續播放
      state._pendingResume = !!(state.current);
      state.stopping = true;          // 停止觸發 end 事件的自動播下一首
      if (state.player) {
        try { state.player.stopTrack(); } catch (_) {}
      }
    } catch (_) {}
  }
}

/** 重連成功後恢復各 guild 播放 */
async function resumeAllGuilds() {
  for (const [guildId, state] of guildStates.entries()) {
    try {
      if (!state._pendingResume) continue;
      state._pendingResume = false;
      state.stopping = false;

      // 重新加入語音頻道
      const channelId = state.player?.connection?.channelId
        || state.guild?.members?.me?.voice?.channelId;
      if (!channelId || !state.guild) continue;

      log.info(`${guildLabel(guildId)} 嘗試恢復播放，重新加入語音頻道 ${channelId}`);
      let player;
      try {
        // 先嘗試離開舊連線
        try { await shoukaku.leaveVoiceChannel(guildId); } catch (_) {}
        player = await shoukaku.joinVoiceChannel({
          guildId,
          channelId,
          shardId: state.guild.shardId,
          deaf: true
        });
      } catch (e) {
        log.error(`${guildLabel(guildId)} [resumeAllGuilds] 重新加入語音頻道失敗`, e);
        continue;
      }

      state.player = player;
      state.player._listenersAttached = false;

      // 將 current 放回 queue 最前端重新播放
      if (state.current) {
        state.queue.unshift(state.current);
        state.current = null;
      }

      await playNext(guildId);
    } catch (e) {
      log.error(`${guildLabel(guildId)} [resumeAllGuilds] 恢復時發生錯誤`, e);
    }
  }
}


const commandData = [
  new SlashCommandBuilder().setName('join').setDescription('讓機器人加入您目前的語音頻道'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('播放音樂 (支援網址、關鍵字、播放清單)')
    .addStringOption((opt) =>
      opt.setName('song').setDescription('請輸入網址、關鍵字或播放清單').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('搜尋並播放音樂 (與 /play 相同)')
    .addStringOption((opt) =>
      opt.setName('song').setDescription('請輸入網址、關鍵字或播放清單').setRequired(true)
    ),
  new SlashCommandBuilder().setName('skip').setDescription('跳過當前歌曲'),
  new SlashCommandBuilder().setName('next').setDescription('跳過當前歌曲'),
  new SlashCommandBuilder().setName('stop').setDescription('停止播放並清空隊列'),
  new SlashCommandBuilder().setName('leave').setDescription('離開語音頻道'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('查看當前待播清單')
    .addIntegerOption((opt) =>
      opt.setName('page').setDescription('要查看的頁數').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('查看當前待播清單')
    .addIntegerOption((opt) =>
      opt.setName('page').setDescription('要查看的頁數').setRequired(false)
    ),
  new SlashCommandBuilder().setName('clear').setDescription('清空待播清單'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('查看目前正在播放的歌曲資訊')
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commandData });
  log.info('全局指令註冊完成');
}

function getState(guildId) {
  if (!guildStates.has(guildId)) {
    guildStates.set(guildId, {
      queue: [],
      current: null,
      player: null,
      textChannelId: null,
      idleTimer: null,
      guild: null,
      stopping: false,
      nowPlayingMsg: null
    });
  }
  return guildStates.get(guildId);
}

function clearIdle(state) {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function startIdleTimer(state, guildId) {
  clearIdle(state);
  state.idleTimer = setTimeout(async () => {
    // 若 state 已被刪除（例如 /stop 後），直接忽略
    if (!guildStates.has(guildId)) return;
    state.idleTimer = null;
    log.info(`${guildLabel(guildId)} 閒置逾時（5 分鐘），自動離開語音頻道`);
    try {
      state.stopping = true;
      state.queue = [];
      state.current = null;
      if (state.textChannelId && state.guild) {
        const channel = state.guild.channels.cache.get(state.textChannelId);
        if (channel) {
          await channel.send(':wave: 等了一陣子都沒播放音樂，我先退下啦，有需要再叫我～ :musical_note:');
        }
      }
      if (state.player) {
        try { await state.player.destroy(); } catch (_) {}
      }
      await shoukaku.leaveVoiceChannel(guildId);
    } catch (_) {}
    guildStates.delete(guildId);
  }, 5 * 60 * 1000);
}

async function joinVoice(interaction) {
  const voice = interaction.member?.voice;
  if (!voice?.channelId) {
    return { ok: false, message: ':x: 你要先進入一個語音頻道，我才能過去找你呀！' };
  }

  const state = getState(interaction.guildId);
  const hasConnection = shoukaku.connections?.has(interaction.guildId);

  if (hasConnection) {
    log.info(`${guildLabel(interaction.guildId)} 已有連線，先離開再重新加入`);
    try {
      await shoukaku.leaveVoiceChannel(interaction.guildId);
    } catch (e) {
      log.error(`${guildLabel(interaction.guildId)} [joinVoice] 離開語音頻道時發生錯誤`, e);
    }
    state.player = null;
  }

  log.info(`${guildLabel(interaction.guildId)} 加入語音頻道 ${voice.channelId}（by ${interaction.user.tag}）`);
  let player;
  try {
    player = await shoukaku.joinVoiceChannel({
      guildId: interaction.guildId,
      channelId: voice.channelId,
      shardId: interaction.guild.shardId,
      deaf: true
    });
  } catch (e) {
    log.error(`${guildLabel(interaction.guildId)} [joinVoice] 加入語音頻道時發生錯誤`, e);
    return { ok: false, message: ':x: 發生一點錯誤，請再試一次看看！' };
  }

  state.player = player;
  state.player._listenersAttached = false;
  state.textChannelId = interaction.channelId;
  state.guild = interaction.guild;
  clearIdle(state);  // 清除可能殘留的 idle timer（例如 /stop 後再 /play）

  return { ok: true, player, voice };
}

async function ensureVoice(interaction) {
  const voice = interaction.member?.voice;

  if (!voice?.channelId) {
    return { ok: false, message: ':x: 你要先進入一個語音頻道，我才能過去找你呀！' };
  }

  const state = getState(interaction.guildId);
  const hasConnection = shoukaku.connections?.has(interaction.guildId);

  if (hasConnection && state.player) {
    const existingChannelId = state.player?.connection?.channelId
      || interaction.guild.members.me?.voice?.channelId
      || null;
    if (!existingChannelId || existingChannelId === voice.channelId) {
      // 更新文字頻道，確保 now playing 訊息發到使用者所在的頻道
      state.textChannelId = interaction.channelId;
      state.guild = interaction.guild;
      return { ok: true, message: null };
    }
    const channelMention = `<#${existingChannelId}>`;
    return { ok: false, message: `:x: 不好意思，我已經在 ${channelMention} 當 DJ 囉！` };
  }

  const result = await joinVoice(interaction);
  if (!result.ok) return result;

  // 確保 stopping 旗標被清除（例如舊連線殘留的狀態）
  getState(interaction.guildId).stopping = false;

  return { ok: true, message: joinedMessage(interaction.user.displayName, voice.channel) };
}

function joinedMessage(displayName, channel) {
  return `:sound: \`${displayName}\` 呼叫我啦！已抵達保護區：${channel}`;
}

function isYoutubeUrl(query) {
  if (!/^https?:\/\//i.test(query)) return false;
  try {
    const host = new URL(query).hostname.replace(/^www\./, '');
    return host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com';
  } catch (_) {
    return false;
  }
}

function parseYoutubeUrl(query) {
  if (!isYoutubeUrl(query)) return { videoId: null, listId: null };
  try {
    const url = new URL(query);
    const host = url.hostname.replace(/^www\./, '');
    const videoId = host === 'youtu.be'
      ? (url.pathname.slice(1) || null)
      : (url.searchParams.get('v') || null);
    const listId = url.searchParams.get('list') || null;
    return { videoId, listId };
  } catch (_) {
    return { videoId: null, listId: null };
  }
}

async function resolveTracks(query, mode = 'auto') {
  const node = shoukaku.getIdealNode();
  if (!lavalinkReady || !node || node.state !== NODE_STATE_CONNECTED) {
    log.error('[resolveTracks] Lavalink 尚未就緒，無法解析曲目');
    return { type: 'error', error: 'Resolve error' };
  }
  if (!node.rest || typeof node.rest.resolve !== 'function') {
    log.error('[resolveTracks] node.rest.resolve 無法使用');
    return { type: 'error', error: 'Resolve error' };
  }

  const isUrl = /^https?:\/\//i.test(query);
  let search = isUrl ? query : `ytsearch:${query}`;

  if (isUrl && isYoutubeUrl(query)) {
    try {
      const url = new URL(query);
      const host = url.hostname.replace(/^www\./, '');
      const videoId = host === 'youtu.be'
        ? (url.pathname.slice(1) || null)
        : (url.searchParams.get('v') || null);
      const listId = url.searchParams.get('list') || null;

      if (mode === 'playlist' && listId) {
        search = `https://www.youtube.com/playlist?list=${listId}`;
      } else if (mode === 'single' && videoId) {
        search = `https://www.youtube.com/watch?v=${videoId}`;
      } else if (mode === 'auto' && listId && !videoId) {
        search = `https://www.youtube.com/playlist?list=${listId}`;
      }
    } catch (_) {}
  }

  let result;
  try {
    result = await node.rest.resolve(search);
  } catch (e) {
    log.error(`[resolveTracks] 解析 "${query}" 時發生例外錯誤`, e);
    return { type: 'error', error: e?.message || 'Resolve error' };
  }

  if (!result || result.loadType === 'empty') {
    log.info(`[resolveTracks] 搜尋 "${query}" 無結果`);
    return { type: 'empty', tracks: [] };
  }
  if (result.loadType === 'error') {
    log.error(`[resolveTracks] loadType 回傳 error，query="${query}"`, result);
    return { type: 'error', error: result.data?.message || 'Resolve error' };
  }
  if (result.loadType === 'playlist') {
    log.info(`[resolveTracks] playlist 解析成功，共 ${result.data.tracks?.length ?? 0} 首，query="${query}"`);
    return { type: 'playlist', tracks: result.data.tracks || [], info: result.data.info };
  }
  if (result.loadType === 'search') {
    const track = (result.data || [])[0];
    if (track) log.info(`[resolveTracks] search 找到："${track.info?.title}"`);
    return { type: track ? 'track' : 'empty', tracks: track ? [track] : [] };
  }
  if (result.loadType === 'track') {
    log.info(`[resolveTracks] track 解析成功："${result.data?.info?.title}"`);
    return { type: 'track', tracks: [result.data] };
  }

  return { type: 'empty', tracks: [] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function playNext(guildId) {
  const state = getState(guildId);
  if (!state.player || state.stopping) return;

  if (state.queue.length === 0) {
    state.current = null;
    log.info(`${guildLabel(guildId)} 播放佇列已清空，啟動閒置計時器`);
    startIdleTimer(state, guildId);
    if (state.textChannelId && state.guild) {
      try {
        const channel = state.guild.channels.cache.get(state.textChannelId);
        if (channel) {
          await channel.send(':white_check_mark: 全部播完啦，想繼續聽的話歡迎隨時點歌～ :musical_note: ');
        }
      } catch (_) {}
    }
    return;
  }

  clearIdle(state);
  const item = state.queue.shift();
  state.current = item;
  const title = item?.info?.title || '未知';
  log.info(`${guildLabel(guildId)} 開始播放："${title}"，剩餘佇列 ${state.queue.length} 首`);

  const connection = state.player.connection;
  if (connection && connection.state !== NODE_STATE_CONNECTED) {
    log.warn(`${guildLabel(guildId)} 連線尚未就緒，等待最多 3 秒...`);
    const start = Date.now();
    while (Date.now() - start < 3000 && connection.state !== NODE_STATE_CONNECTED) {
      await sleep(250);
    }
  }

  try {
    const encoded = item?.encoded || item?.track?.encoded || item?.track?.track;
    if (!encoded) throw new Error('Missing encoded track');
    state.nowPlayingMsg = null;
    await state.player.playTrack({ track: { encoded } });
    await sendNowPlaying(state, state.guild, true);
  } catch (e) {
    log.error(`${guildLabel(guildId)} [playNext] 播放 "${title}" 失敗`, e);
    await editOrSendError(state, ':x: 嗚嗚，我拿不到這首歌的播放資訊耶，暫時沒辦法唱給你聽喔！');
    state.current = null;
    // 用 setImmediate 避免 queue 中連續壞歌造成 call stack overflow
    setImmediate(() => playNext(guildId));
    return;
  }

  if (!state.player._listenersAttached) {
    bindPlayerEvents(state.player, guildId);
  }
}

function bindPlayerEvents(player, guildId) {
  if (player._listenersAttached) return;
  player._listenersAttached = true;

  const getLatestState = () => guildStates.get(guildId);

  player.on('end', async (data) => {
    const s = getLatestState();
    if (!s || data.reason === 'replaced' || s.stopping) return;
    // exception / stuck 已主動呼叫 playNext 並清掉 current，避免重複驅動
    if (!s.current) return;
    log.info(`${guildLabel(guildId)} 曲目結束："${s.current?.info?.title || '未知'}"，reason=${data.reason}`);
    await deleteNowPlayingMsg(s);
    await playNext(guildId);
  });

  player.on('exception', async () => {
    const s = getLatestState();
    if (!s || s.stopping) return;
    const title = s.current?.info?.title || '未知';
    log.error(`${guildLabel(guildId)} 播放例外（exception）："${title}"`);
    // 先清掉 nowPlayingMsg，再送錯誤訊息（不能用 editOrSendError，因為上面 delete 後 nowPlayingMsg 已是 null）
    await deleteNowPlayingMsg(s);
    if (s.textChannelId && s.guild) {
      try {
        const ch = s.guild.channels.cache.get(s.textChannelId);
        if (ch) await ch.send(`:x: 哎呀，我拿不到 **${title}** 的播放資訊耶，這首可能要先跳過囉！`);
      } catch (_) {}
    }
    s.current = null;
    // exception 後 end 有時不來，主動驅動下一首；end 若來了會因 s.current===null 而忽略
    setImmediate(() => playNext(guildId));
  });

  player.on('stuck', async () => {
    const s = getLatestState();
    if (!s || s.stopping) return;
    log.warn(`${guildLabel(guildId)} 播放卡住（stuck）："${s.current?.info?.title || '未知'}"`);
    await deleteNowPlayingMsg(s);
    if (s.textChannelId && s.guild) {
      try {
        const ch = s.guild.channels.cache.get(s.textChannelId);
        if (ch) await ch.send(':x: 嗚嗚，這首歌卡住了，幫你跳到下一首！');
      } catch (_) {}
    }
    s.current = null;
    // stuck 事件不保證會觸發 end，必須主動驅動下一首
    setImmediate(() => playNext(guildId));
  });

  player.on('closed', async () => {
    const s = getLatestState();
    if (!s || s.stopping) return;
    log.warn(`${guildLabel(guildId)} 語音連線關閉（closed），5 秒後檢查狀態`);

    // 延遲 5 秒，給底層重連機制一點時間（這是處理地區切換的必要緩衝）
    setTimeout(async () => {
      // 1. 檢查 Discord 端：機器人的人頭是否還在頻道裡？
      const botInVoice = client.guilds.cache.get(guildId)?.members.me?.voice?.channelId;

      // 2. 檢查 Lavalink 端：Shoukaku 是否還持有這個伺服器的連線實例？
      const hasLavalinkConnection = shoukaku.connections.has(guildId);

      log.info(`${guildLabel(guildId)} [closed] botInVoice=${!!botInVoice} hasLavalinkConnection=${hasLavalinkConnection}`);

      // 判斷邏輯：
      if (!botInVoice && !hasLavalinkConnection) {
        // 情況 A：Discord 沒人，且 Lavalink 也徹底斷開了 -> 確定是真的離開，清除記憶
        log.info(`${guildLabel(guildId)} [closed] 情況A：Discord 及 Lavalink 均已斷開，清除狀態`);
        const cs = guildStates.get(guildId);
        if (cs) clearIdle(cs);
        guildStates.delete(guildId);
      }
      else if (botInVoice && !hasLavalinkConnection) {
        // 情況 B：「幽靈連線」！Discord 有人，但 Lavalink 放棄了。
        // 清除記憶並讓機器人主動退出 Discord 頻道，避免卡死。
        log.warn(`${guildLabel(guildId)} [closed] 情況B：幽靈連線，強制離開語音頻道`);
        const cs = guildStates.get(guildId);
        if (cs) clearIdle(cs);
        guildStates.delete(guildId);
        try { await shoukaku.leaveVoiceChannel(guildId); } catch (_) {}
      }
    }, 5000);
  });
}

function buildNowPlayingEmbed(state, guild) {
  const current = state.current;
  if (!current) return null;
  const title = current.info.title || '未知';
  const uri = current.info.uri || '';
  const author = current.info.author || '未知';
  const requester = current.requesterId ? `<@${current.requesterId}>` : '未知';
  const channelName = guild.members.me?.voice?.channel?.toString() || '未知';

  const embed = new EmbedBuilder()
    .setTitle(':musical_note:  正在播放')
    .setDescription(uri ? `**[${title}](${uri})**\n${author}` : `**${title}**\n${author}`)
    .addFields({ name: ' ', value: `${requester} | ${channelName}` })
    .setColor(0x3498db);

  if (current.info.artworkUrl) {
    embed.setThumbnail(current.info.artworkUrl);
  }

  return embed;
}

function buildControls() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_skip').setLabel('下一首').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music_queue').setLabel('待播清單').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_clear').setLabel('清空').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('music_leave').setLabel('離開').setEmoji('🚪').setStyle(ButtonStyle.Danger)
  );
}

function buildQueueEmbed(state, page, withIcon) {
  const perPage = 10;
  const total = state.queue.length;
  const maxPage = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const items = state.queue.slice(start, start + perPage);
  const lines = items.map((t, i) => `${start + i + 1}. ${t.info.title || '未知'}`).join('\n');
  const titleBase = `待播清單 (第 ${page}/${maxPage} 頁，共 ${total} 首)`;
  const title = withIcon ? `:scroll: ${titleBase}` : titleBase;

  return {
    embed: new EmbedBuilder().setTitle(title).setDescription(lines).setColor(0x2ecc71),
    maxPage
  };
}

function buildQueueControls(page, maxPage) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_prev:${page - 1}`)
      .setLabel('上一頁')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`queue_next:${page + 1}`)
      .setLabel('下一頁')
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= maxPage),
    new ButtonBuilder()
      .setCustomId('queue_clear')
      .setLabel('清空')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
  );
}

async function sendQueueMessage(interaction, state, page) {
  const total = state.queue.length;
  if (total === 0) {
    return interaction.reply({ content: ':x: 待播清單目前空空如也喔。', flags: MessageFlags.Ephemeral });
  }
  const perPage = 10;
  const maxPage = Math.max(1, Math.ceil(total / perPage));
  if (page < 1 || page > maxPage) {
    return interaction.reply({ content: `:x: 頁數超出範圍囉，請輸入 1 ~ ${maxPage} 之間的數字。`, flags: MessageFlags.Ephemeral });
  }

  const { embed } = buildQueueEmbed(state, page, true);
  const controls = buildQueueControls(page, maxPage);
  return interaction.reply({ embeds: [embed], components: [controls], flags: MessageFlags.Ephemeral });
}

async function sendNowPlaying(state, guild, silent) {
  if (!state?.current || !state.textChannelId || !guild) return;
  const channel = guild.channels.cache.get(state.textChannelId);
  if (!channel) return;
  const embed = buildNowPlayingEmbed(state, guild);
  if (!embed) return;
  const payload = { embeds: [embed], components: [buildControls()] };
  if (silent) payload.flags = MessageFlags.SuppressNotifications;
  const msg = await channel.send(payload);
  state.nowPlayingMsg = msg;
}

async function editOrSendError(state, msg) {
  try {
    if (state.nowPlayingMsg) {
      await state.nowPlayingMsg.edit({ content: msg, embeds: [], components: [] });
      state.nowPlayingMsg = null;
    } else if (state.textChannelId && state.guild) {
      const channel = state.guild.channels.cache.get(state.textChannelId);
      if (channel) await channel.send(msg);
    }
  } catch (_) {}
}

async function deleteNowPlayingMsg(state) {
  if (!state.nowPlayingMsg) return;
  try {
    await state.nowPlayingMsg.delete();
  } catch (_) {}
  state.nowPlayingMsg = null;
}

async function handlePlay(interaction) {
  await interaction.deferReply();
  const res = await ensureVoice(interaction);
  if (!res.ok) return interaction.editReply(res.message);
  const state = getState(interaction.guildId);
  if (!state.player) return interaction.editReply(':x: 發生一點錯誤，請再試一次看看！');

  const query = interaction.options.getString('song', true);
  let searchMessage;
  if (res.message) {
    await interaction.editReply(res.message);
    searchMessage = await interaction.followUp({ content: ':mag_right: 正在搜尋音樂中...' });
  } else {
    searchMessage = await interaction.editReply(':mag_right: 正在搜尋音樂中...');
  }

  const { videoId, listId } = parseYoutubeUrl(query);
  if (videoId && listId) {
    const [singleResolved, playlistResolved] = await Promise.all([
      resolveTracks(query, 'single'),
      resolveTracks(query, 'playlist')
    ]);
    const videoTitle = singleResolved.tracks?.[0]?.info?.title || '此影片';
    const playlistCount = playlistResolved.tracks?.length ?? 0;
    const TIMEOUT_MS = 10_000;

    const pendingKey = `${interaction.user.id}:${interaction.guildId}`;
    pendingPlayChoices.set(pendingKey, {
      query,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      userName: interaction.user.displayName || interaction.user.username,
      singleResolved,
      playlistResolved,
      expiresAt: Date.now() + TIMEOUT_MS,
      timeoutId: null
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('play_single')
        .setLabel(`只加入 ${videoTitle}`.slice(0, 80))
        .setEmoji('🎵')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('play_playlist')
        .setLabel(`加入整個播放清單共 ${playlistCount} 首`.slice(0, 80))
        .setEmoji('📋')
        .setStyle(ButtonStyle.Success)
    );

    const msg = `<@${interaction.user.id}> \n此影片連結同時包含播放清單，\n要只加入 **${videoTitle}**，還是加入整個播放清單共 **${playlistCount}** 首？\n-# 10 秒後將只加入 **${videoTitle}**。`;
    const choiceMsg = await searchMessage.edit({ content: msg, components: [row] });

    const timeoutId = setTimeout(async () => {
      const p = pendingPlayChoices.get(pendingKey);
      if (!p || p.timeoutId !== timeoutId) return;
      pendingPlayChoices.delete(pendingKey);
      try {
        await choiceMsg.edit({ components: [] });
        const autoState = getState(p.guildId);
        if (!autoState.guild) autoState.guild = interaction.guild;
        await finalizePlay({
          interaction,
          state: autoState,
          resolved: p.singleResolved,
          query,
          editMessage: choiceMsg,
          overrideUser: { id: p.userId, name: p.userName },
          guildId: p.guildId
        });
      } catch (e) {
        log.error(`${guildLabel(p.guildId)} [autoPlay] 自動加入單首時發生錯誤`, e);
      }
    }, TIMEOUT_MS);

    pendingPlayChoices.get(pendingKey).timeoutId = timeoutId;
    return;
  }

  const resolved = await resolveTracks(query, 'auto');
  return finalizePlay({ interaction, state, resolved, query, searchMessage });
}

async function finalizePlay({ interaction, state, resolved, query, searchMessage, editMessage, overrideUser, guildId }) {
  const userName = overrideUser?.name || interaction?.user?.displayName || interaction?.user?.username || '未知';
  const userId = overrideUser?.id || interaction?.user?.id;

  const reply = async (msg) => {
    if (editMessage) return editMessage.edit({ content: msg, components: [] });
    if (searchMessage) return searchMessage.edit(msg);
    return interaction.followUp(msg);
  };

  if (resolved.type === 'empty') {
    log.info(`[finalizePlay] 搜尋無結果：query="${query}"`);
    return reply(`:x: 抱歉，我翻遍了也找不到跟 \`${query}\` 相關的音樂耶...`);
  }

  if (resolved.type === 'error') {
    log.error(`[finalizePlay] 搜尋發生錯誤：query="${query}"`);
    return reply(`:x: 搜尋時發生錯誤，請稍後再試看看！`);
  }

  const wasIdle = !state.current;
  const added = [];
  for (const track of resolved.tracks) {
    const item = {
      encoded: track?.encoded || track?.track || (typeof track === 'string' ? track : null),
      track,
      info: track.info || {},
      requesterId: userId,
      requesterName: userName
    };
    state.queue.push(item);
    added.push(item);
  }

  if (resolved.type === 'playlist') {
    log.info(`${guildLabel(guildId || state.guild?.id)} ${userName} 加入播放清單，共 ${added.length} 首，query="${query}"`);
    await reply(`:white_check_mark: \`${userName}\` 一口氣點了 **${added.length}** 首音樂，已經通通塞進清單啦！`);
  } else {
    const title = added[0]?.info?.title || '未知';
    log.info(`${guildLabel(guildId || state.guild?.id)} ${userName} 加入單曲："${title}"`);
    await reply(`:white_check_mark: \`${userName}\` 點的 **${title}** 已經加入隊列排隊囉！`);
  }

  if (wasIdle) {
    await playNext(guildId || state.guild?.id || interaction?.guildId);
  }
}

client.once(Events.ClientReady, async () => {
  await registerCommands();
  log.info(`機器人已上線，登入身份：${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const state = getState(interaction.guildId);
      state.guild = interaction.guild;

      if (interaction.commandName === 'join') {
        const voice = interaction.member?.voice;
        if (!voice?.channelId) {
          return interaction.reply({ content: ':x: 你要先進入一個語音頻道，我才能過去找你呀！' });
        }

        const hasConnection = shoukaku.connections?.has(interaction.guildId);
        const existingChannelId = state.player?.connection?.channelId
          || interaction.guild.members.me?.voice?.channelId
          || null;

        if (hasConnection && existingChannelId === voice.channelId) {
          return interaction.reply({ content: ':x: 哎呀，我早就在這個頻道裡面等你囉！' });
        }

        if (hasConnection && existingChannelId) {
          try {
            state.stopping = true;
            log.info(`${guildLabel(interaction.guildId)} /join：從 ${existingChannelId} 移動至 ${voice.channelId}（by ${interaction.user.tag}）`);

            // 記住舊頻道資訊，移動前先處理
            const oldTextChannelId = state.textChannelId;
            const oldTextChannel = oldTextChannelId ? interaction.guild.channels.cache.get(oldTextChannelId) : null;

            // 刪除舊頻道的正在播放訊息
            await deleteNowPlayingMsg(state);

            // 在舊頻道送出「被拉走」通知（只在不同頻道時才送）
            if (oldTextChannel && oldTextChannelId !== interaction.channelId) {
              const newChannelMention = `<#${interaction.channelId}>`;
              await oldTextChannel.send(
                `:wave: \`${interaction.user.displayName}\` 把我拉走囉！如要繼續聆聽音樂，請前往 ${newChannelMention}。`
              ).catch(() => {});
            }

            // 直接透過 Discord gateway 移動頻道，不重建 player，Lavalink 繼續播放
            interaction.guild.shard.send({
              op: 4,
              d: {
                guild_id: interaction.guildId,
                channel_id: voice.channelId,
                self_mute: false,
                self_deaf: true
              }
            });
            await sleep(500);
            state.stopping = false;
            state.textChannelId = interaction.channelId;
            state.guild = interaction.guild;
            await interaction.reply({
              content: `:sound: \`${interaction.user.displayName}\` 把我拉過來囉！已移動至：${voice.channel}`
            });
            if (state.current) {
              await sendNowPlaying(state, interaction.guild, true);
            }
            return;
          } catch (e) {
            state.stopping = false;
            log.error(`${guildLabel(interaction.guildId)} [join] 移動頻道時發生錯誤`, e);
            return interaction.reply({ content: ':x: 發生一點錯誤，請再試一次看看！' });
          }
        }

        await interaction.deferReply();
        state.stopping = false;

        const joined = await joinVoice(interaction);
        if (!joined.ok) return interaction.editReply(joined.message);

        return interaction.editReply(
          joinedMessage(interaction.user.displayName, joined.voice.channel)
        );
      }

      if (interaction.commandName === 'play' || interaction.commandName === 'search') {
        return handlePlay(interaction);
      }

      if (interaction.commandName === 'skip' || interaction.commandName === 'next') {
        if (!state.player || !state.current) {
          return interaction.reply(':x: 現在很安靜唷，沒有音樂可以跳過啦！');
        }
        const title = state.current.info?.title || '未知歌曲';
        log.info(`${guildLabel(interaction.guildId)} /skip："${title}"（by ${interaction.user.tag}）`);
        await interaction.reply(`:track_next: \`${interaction.user.displayName}\` 卡歌啦！已幫您跳過 **${title}**。`);
        await deleteNowPlayingMsg(state);
        return state.player.stopTrack();
      }

      if (interaction.commandName === 'stop' || interaction.commandName === 'leave') {
        if (!state.player && !shoukaku.connections?.has(interaction.guildId)) return interaction.reply(':x: 我現在不在頻道裡喔！');
        log.info(`${guildLabel(interaction.guildId)} /${interaction.commandName}：停止並離開（by ${interaction.user.tag}）`);
        await interaction.reply(`:wave: \`${interaction.user.displayName}\` 讓我先退下了，停止播放並退出頻道囉！`);
        state.stopping = true;
        state.queue = [];
        state.current = null;
        clearIdle(state);
        await deleteNowPlayingMsg(state);
        try { await state.player.destroy(); } catch (_) {}
        await shoukaku.leaveVoiceChannel(interaction.guildId);
        guildStates.delete(interaction.guildId);
        return;
      }

      if (interaction.commandName === 'clear') {
        if (state.queue.length === 0) return interaction.reply(':x: 待播清單本來就是空的啦！');
        log.info(`${guildLabel(interaction.guildId)} /clear：清空 ${state.queue.length} 首（by ${interaction.user.tag}）`);
        state.queue = [];
        return interaction.reply(`:white_check_mark: 痛快！\`${interaction.user.displayName}\` 把待播清單通通清空了！`);
      }

      if (interaction.commandName === 'nowplaying') {
        const embed = buildNowPlayingEmbed(state, interaction.guild);
        if (!embed) return interaction.reply({ content: ':x: 目前沒有播放任何音樂喔。', flags: MessageFlags.Ephemeral });
        return interaction.reply({ embeds: [embed], components: [buildControls()], flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === 'queue' || interaction.commandName === 'playlist') {
        const page = interaction.options.getInteger('page') || 1;
        return sendQueueMessage(interaction, state, page);
      }
    }

    if (interaction.isButton()) {
      const state = getState(interaction.guildId);

      if (interaction.customId === 'play_single' || interaction.customId === 'play_playlist') {
        const pendingKey = `${interaction.user.id}:${interaction.guildId}`;
        const pending = pendingPlayChoices.get(pendingKey);

        if (!pending) {
          return interaction.reply({ content: ':x: 這不是你的選擇喔，或選擇已逾時！', flags: MessageFlags.Ephemeral });
        }

        if (Date.now() > pending.expiresAt || pending.guildId !== interaction.guildId) {
          pendingPlayChoices.delete(pendingKey);
          clearTimeout(pending.timeoutId);
          return interaction.update({ content: ':x: 這個選擇已經逾時（10 秒）或無效，請重新使用指令。', components: [] });
        }

        clearTimeout(pending.timeoutId);
        pendingPlayChoices.delete(pendingKey);

        await interaction.update({ content: ':mag_right: 正在搜尋音樂中...', components: [] });
        const updatedMsg = await interaction.fetchReply();

        const resolved = interaction.customId === 'play_single'
          ? pending.singleResolved
          : pending.playlistResolved;

        return finalizePlay({
          state,
          resolved,
          query: pending.query,
          editMessage: updatedMsg,
          overrideUser: { id: pending.userId, name: pending.userName },
          guildId: pending.guildId
        });
      }

      if (interaction.customId === 'music_skip') {
        if (!state.player || !state.current) {
          return interaction.reply({ content: ':x: 現在很安靜唷，沒有音樂可以跳過啦！' });
        }
        const title = state.current.info?.title || '未知歌曲';
        log.info(`${guildLabel(interaction.guildId)} [btn] 跳過："${title}"（by ${interaction.user.tag}）`);
        await interaction.reply({ content: `:track_next: \`${interaction.user.displayName}\` 卡歌啦！已幫您跳過 **${title}**。` });
        await deleteNowPlayingMsg(state);
        return state.player.stopTrack();
      }

      if (interaction.customId === 'music_queue') {
        return sendQueueMessage(interaction, state, 1);
      }

      if (interaction.customId === 'music_clear') {
        if (state.queue.length === 0) {
          return interaction.reply({ content: ':x: 待播清單本來就是空的啦！' });
        }
        log.info(`${guildLabel(interaction.guildId)} [btn] 清空佇列 ${state.queue.length} 首（by ${interaction.user.tag}）`);
        state.queue = [];
        return interaction.reply({ content: `:white_check_mark: 痛快！\`${interaction.user.displayName}\` 把待播清單通通清空了！` });
      }

      if (interaction.customId === 'music_leave') {
        if (!state.player) return interaction.reply({ content: ':x: 我現在不在頻道裡喔！' });
        log.info(`${guildLabel(interaction.guildId)} [btn] 離開語音頻道（by ${interaction.user.tag}）`);
        await interaction.reply({ content: `:wave: \`${interaction.user.displayName}\` 按下了離開，我先退下囉！` });
        state.stopping = true;
        state.queue = [];
        state.current = null;
        clearIdle(state);
        await deleteNowPlayingMsg(state);
        try { await state.player.destroy(); } catch (_) {}
        await shoukaku.leaveVoiceChannel(interaction.guildId);
        guildStates.delete(interaction.guildId);
        return;
      }

      if (interaction.customId.startsWith('queue_prev:') || interaction.customId.startsWith('queue_next:')) {
        const page = Number(interaction.customId.split(':')[1]);
        const total = state.queue.length;
        const perPage = 10;
        const maxPage = Math.max(1, Math.ceil(total / perPage));
        if (total === 0) {
          return interaction.update({ content: ':x: 待播清單目前空空如也喔。', embeds: [], components: [] });
        }
        const safePage = Math.min(Math.max(page, 1), maxPage);
        const { embed } = buildQueueEmbed(state, safePage, false);
        const controls = buildQueueControls(safePage, maxPage);
        return interaction.update({ embeds: [embed], components: [controls] });
      }

      if (interaction.customId === 'queue_clear') {
        if (state.queue.length === 0) {
          return interaction.update({ content: ':x: 待播清單目前空空如也喔。', embeds: [], components: [] });
        }
        state.queue = [];
        await interaction.deferUpdate();
        await interaction.followUp({ content: `:white_check_mark: 痛快！\`${interaction.user.displayName}\` 把待播清單通通清空了！` });
        return interaction.editReply({ content: ':white_check_mark: 待播清單被你清空了喔！', embeds: [], components: [] });
      }
    }
  } catch (e) {
    log.error('[interaction] 處理互動時發生未預期錯誤', e);
    if (interaction?.isRepliable?.()) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: ':x: 發生一點錯誤，請再試一次看看！' });
        } else {
          await interaction.reply({ content: ':x: 發生一點錯誤，請再試一次看看！' });
        }
      } catch (_) {}
    }
  }
});

shoukaku.on('error', (name, error) => {
  // 重連/等待重試期間靜默，訊息由 disconnect handler 統一處理
  if (!lavalinkReady || isReconnecting || isWaitingReconnect) return;
  log.error(`Lavalink 節點 [${name}] 發生錯誤：`, error?.message || error);
});

shoukaku.on('ready', async (name) => {
  lavalinkReady = true;
  lavalinkEverReady = true;
  isWaitingReconnect = false;
  log.info(`Lavalink 節點已就緒：${name}`);

  if (isReconnecting) {
    isReconnecting = false;
    log.info('Lavalink 重連成功，正在恢復各頻道播放...');
    await resumeAllGuilds();
  }
});

shoukaku.on('reconnecting', (name) => {
  lavalinkReady = false;
  // 啟動時從未就緒過，不算「斷線」，靜默即可
  if (!isReconnecting && lavalinkEverReady) {
    isReconnecting = true;
    log.warn(`Lavalink 節點 [${name}] 斷線，自動重連中...`);
    pauseAllGuilds().catch(() => {});
  }
});

shoukaku.on('close', (name) => {
  lavalinkReady = [...shoukaku.nodes.values()].some((n) => n.state === NODE_STATE_CONNECTED);
  log.warn(`Lavalink 節點 [${name}] 連線關閉，lavalinkReady=${lavalinkReady}`);
});

client.login(token);
