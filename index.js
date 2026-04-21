require('dotenv').config({ quiet: true });

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
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');

const token = process.env.DISCORD_BOT_TOKEN;

if (!token) {
  console.error('❌ 缺少環境變數：請在 .env 中設定 DISCORD_BOT_TOKEN');
  process.exit(1);
}

const lavalinkHost = process.env.LAVALINK_HOST || '127.0.0.1';
const lavalinkPort = process.env.LAVALINK_PORT || '2333';
const lavalinkPassword = process.env.LAVALINK_PASSWORD || 'youshallnotpass';
const lavalinkSecure = (process.env.LAVALINK_SECURE || 'false').toLowerCase() === 'true';

// ─── Logger ──────────────────────────────────────────────────────────────────
function getLocalISOString() {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  if (offset === 0) return now.toISOString().slice(0, 23) + 'Z';
  const sign = offset >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const offsetStr = `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 23) + offsetStr;
}
const log = {
  info: (...a) => console.log(`[${getLocalISOString()}] INFO `, ...a),
  warn: (...a) => console.warn(`[${getLocalISOString()}] WARN `, ...a),
  error: (...a) => console.error(`[${getLocalISOString()}] ERROR`, ...a),
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

// reconnectTries: 1 最低值，讓 disconnect 事件能正常觸發，其餘由我們的重連迴圈接手
// reconnectInterval 單位為「秒」
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), [], {
  resume: true,
  resumeTimeout: 30,
  reconnectTries: 1,
  reconnectInterval: 0
});

// ── 單一全域重連迴圈 ──────────────────────────────────────────────────────────
// 用一個 setInterval 取代「每次 addNode 都掛 disconnect listener」的設計，
// 避免多次 addNode 導致 listener 累積、ready 事件重複觸發。
let _reconnectTimer = null;

function startReconnectLoop(nodeName) {
  if (_reconnectTimer) return;   // 防止重複啟動
  isReconnecting = true;
  isWaitingReconnect = true;
  log.warn(`[Lavalink] 節點斷線，開始每 5 秒重試`);

  _reconnectTimer = setInterval(() => {
    if (lavalinkReady) {
      stopReconnectLoop();
      return;
    }
    // 先移除可能殘留的舊節點，避免積累
    try { shoukaku.nodes.delete(nodeName); } catch (_) { }
    log.info(`[Lavalink] 重試連接節點`);
    try {
      _origAddNode({
        name: nodeName,
        url: `${lavalinkHost}:${lavalinkPort}`,
        auth: lavalinkPassword,
        secure: lavalinkSecure
      });
    } catch (e) {
      log.error(`[Lavalink] addNode [${nodeName}] 失敗：`, e?.message || e);
    }
  }, 5000);
}

function stopReconnectLoop() {
  if (!_reconnectTimer) return;
  clearInterval(_reconnectTimer);
  _reconnectTimer = null;
  isWaitingReconnect = false;
}

// 監聽節點斷線，啟動重連迴圈（只掛一次）
function attachNodeDisconnectHandler(nodeName) {
  const node = shoukaku.nodes.get(nodeName);
  if (!node) return;
  node.once('disconnect', () => {
    lavalinkReady = false;
    if (lavalinkEverReady) {
      pauseAllGuilds().catch(() => { });
    }
    startReconnectLoop(nodeName);
  });
}

const _origAddNode = shoukaku.addNode.bind(shoukaku);
shoukaku.addNode = function (options) {
  _origAddNode(options);
  // 重連迴圈期間不重複掛 listener（由 startReconnectLoop 統一管理）
  if (!_reconnectTimer) {
    setImmediate(() => attachNodeDisconnectHandler(options.name));
  }
};

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
      if (state.stopping) continue;   // 冪等防護：已暫停過就跳過，避免重複呼叫蓋掉 _pendingResume
      clearIdle(state);
      // 標記為需要重連後繼續播放
      state._pendingResume = !!(state.current);
      state.stopping = true;          // 停止觸發 end 事件的自動播下一首
      if (state.player) {
        try { state.player.stopTrack(); } catch (_) { }
      }
    } catch (_) { }
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

      log.info(`${guildLabel(guildId)} [resumeAllGuilds] 嘗試恢復播放，重新加入語音頻道 ${channelId}`);
      let player;
      try {
        // 先嘗試離開舊連線
        try { await shoukaku.leaveVoiceChannel(guildId); } catch (_) { }
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

      // 移除舊 player 的監聽器，防止孤兒 listener 操作過時的 state
      if (state.player) {
        try { state.player.removeAllListeners(); } catch (_) { }
        state.player._listenersAttached = false;
      }
      state.player = player;
      state.player._listenersAttached = false;

      // 將 current 放回 queue 最前端重新播放
      if (state.current) {
        state.queue.unshift(state.current);
        state.current = null;
      }

      // 重連後重置重入旗標，避免殘留的 true 擋住 playNext
      state._playNextRunning = false;

      await playNext(guildId);
    } catch (e) {
      log.error(`${guildLabel(guildId)} [resumeAllGuilds] 恢復時發生錯誤`, e);
    }
  }
}


const commandData = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('讓機器人加入您目前的語音頻道'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('播放音樂 (支援網址、關鍵字、播放清單)')
    .addStringOption((opt) =>
      opt
        .setName('song')
        .setDescription('請輸入網址、關鍵字或播放清單')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('搜尋並播放音樂 (與 /play 相同)')
    .addStringOption((opt) =>
      opt
        .setName('song')
        .setDescription('請輸入網址、關鍵字或播放清單')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('跳過當前歌曲'),
  new SlashCommandBuilder()
    .setName('next')
    .setDescription('跳過當前歌曲'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('停止播放並清空隊列'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('離開語音頻道'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('查看當前待播清單')
    .addIntegerOption((opt) =>
      opt
        .setName('page')
        .setDescription('要查看的頁數')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('查看當前待播清單')
    .addIntegerOption((opt) =>
      opt
        .setName('page')
        .setDescription('要查看的頁數')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('清空待播清單'),
  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('查看目前正在播放的歌曲資訊'),
  new SlashCommandBuilder()
    .setName('autorecommend')
    .setDescription('開啟或關閉自動推薦（佇列播完後自動推薦相似歌曲）')
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(client.application.id), { body: commandData });
  log.info('[Main] 全局指令註冊完成');
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
      nowPlayingMsg: null,
      _playNextRunning: false,
      autoRecommend: true,
      lastPlayedTitle: null,
      lastPlayedUri: null,
      seedTrackTitle: null,
      seedTrackUri: null,
      recommendCache: [], // 存放種子歌曲產生的推薦清單 (快取)
      history: [] // 紀錄最近播放過的歌曲，避免重複推薦
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
    log.info(`${guildLabel(guildId)} [idleTimer] 閒置逾時（30 分鐘），自動離開語音頻道`);
    state.stopping = true;
    state.queue = [];
    state.current = null;
    // 刪除正在播放訊息
    try { await deleteNowPlayingMsg(state); } catch (_) { }
    // 發送通知訊息
    if (state.textChannelId && state.guild) {
      try {
        const channel = state.guild.channels.cache.get(state.textChannelId);
        if (channel) {
          await channel.send('👋 等了一陣子都沒播放音樂，我先退下啦，有需要再叫我～ 🎵');
        }
      } catch (e) {
        log.warn(`${guildLabel(guildId)} [idleTimer] 發送通知訊息失敗`, e);
      }
    }
    // 離開語音頻道（獨立 try/catch，確保上面任何失敗都不影響離開動作）
    try {
      if (state.player) await state.player.destroy();
    } catch (_) { }
    try {
      await shoukaku.leaveVoiceChannel(guildId);
    } catch (e) {
      log.error(`${guildLabel(guildId)} [idleTimer] 離開語音頻道失敗`, e);
    }
    guildStates.delete(guildId);
  }, 30 * 60 * 1000);
}

async function joinVoice(interaction) {
  const voice = interaction.member?.voice;
  if (!voice?.channelId) {
    return { ok: false, message: '❌ 你要先進入一個語音頻道，我才能過去找你呀！' };
  }

  const state = getState(interaction.guildId);
  const hasConnection = shoukaku.connections?.has(interaction.guildId);

  if (hasConnection) {
    if (state.player) {
      try { state.player.removeAllListeners(); } catch (_) { }
      state.player._listenersAttached = false;
    }
    try {
      await shoukaku.leaveVoiceChannel(interaction.guildId);
    } catch (e) {
      log.error(`${guildLabel(interaction.guildId)} [joinVoice] 離開語音頻道時發生錯誤`, e);
    }
    state.player = null;
  }

  log.info(`${guildLabel(interaction.guildId)} [joinVoice] 加入語音頻道 ${voice.channelId}（by ${interaction.user.username}）`);
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
    return { ok: false, message: '❌ 發生一點錯誤，請再試一次看看！' };
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
    return { ok: false, message: '❌ 你要先進入一個語音頻道，我才能過去找你呀！' };
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
      // 確保 stopping 被清除，這樣即使之前進入閒置或暫停狀態，新的播放也能順利開始
      state.stopping = false;
      return { ok: true, message: null };
    }
    const channelMention = `<#${existingChannelId}>`;
    return { ok: false, message: `❌ 不好意思，我已經在 ${channelMention} 當 DJ 囉！` };
  }

  const result = await joinVoice(interaction);
  if (!result.ok) return result;

  // 確保 stopping 旗標被清除（例如舊連線殘留的狀態）
  getState(interaction.guildId).stopping = false;

  return { ok: true, message: joinedMessage(interaction.user.displayName, voice.channel) };
}

function joinedMessage(displayName, channel) {
  return `🔉 \`${displayName}\` 呼叫我啦！已抵達保護區：${channel}`;
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
      const { videoId, listId } = parseYoutubeUrl(query);
      if (mode === 'playlist' && listId) {
        search = `https://www.youtube.com/playlist?list=${listId}`;
      } else if (mode === 'single' && videoId) {
        search = `https://www.youtube.com/watch?v=${videoId}`;
      } else if (mode === 'auto' && listId && !videoId) {
        search = `https://www.youtube.com/playlist?list=${listId}`;
      }
    } catch (_) { }
  }

  let result;
  try {
    result = await node.rest.resolve(search);
  } catch (e) {
    log.error(`[resolveTracks] 解析時發生例外錯誤，query="${query}"`, e);
    return { type: 'error', error: e?.message || 'Resolve error' };
  }

  if (!result || result.loadType === 'empty') {
    return { type: 'empty', tracks: [] };
  }
  if (result.loadType === 'error') {
    log.error(`[resolveTracks] loadType 回傳 error，query="${query}"`, result);
    return { type: 'error', error: result.data?.message || 'Resolve error' };
  }
  if (result.loadType === 'playlist') {
    return { type: 'playlist', tracks: result.data.tracks || [], info: result.data.info };
  }
  if (result.loadType === 'search') {
    const track = (result.data || [])[0];
    return { type: track ? 'track' : 'empty', tracks: track ? [track] : [] };
  }
  if (result.loadType === 'track') {
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
  // 防止重入：若已有一次 playNext 正在執行中，直接忽略
  if (state._playNextRunning) return;
  state._playNextRunning = true;
  let scheduleRetry = false;
  try {
    scheduleRetry = await _playNextInner(guildId, state);
  } finally {
    state._playNextRunning = false;
    // _playNextInner 回傳 true 代表播放失敗需要重試下一首
    // 必須在 _playNextRunning 清除後才能重新觸發，否則 guard 會擋住
    if (scheduleRetry) setImmediate(() => playNext(guildId));
  }
}

// 回傳 true 表示需要排程重試（呼叫方負責在 _playNextRunning=false 後執行）
async function _playNextInner(guildId, state) {
  if (state.queue.length === 0) {
    state.current = null;
    // 佇列清空時刪除「正在播放」訊息
    try { await deleteNowPlayingMsg(state); } catch (_) { }

    // ── 自動推薦：佇列播完後，若已開啟則搜尋相似歌曲 ──────────────────────────
    if (state.autoRecommend && state.seedTrackTitle) {
      try {
        const normalizeTitle = (t) => (t || '')
          .toLowerCase()
          .replace(/\((official|lyric|video|hd|4k|audio|music|mv).*?\)/gi, '')
          .replace(/\[(official|lyric|video|hd|4k|audio|music|mv).*?\]/gi, '')
          .replace(/\(.*?\)|\[.*?\]/g, '')
          .replace(/[^\w\s\u3000-\u9fff]/g, '')
          .replace(/\s+/g, ' ')
          .trim();

        const seedNorm = normalizeTitle(state.seedTrackTitle);
        const seedId = parseYoutubeUrl(state.seedTrackUri).videoId;
        const historyIds = state.history.map(h => h.id).filter(Boolean);
        const historyTitles = state.history.map(h => normalizeTitle(h.title));

        const isDuplicate = (t) => {
          const tid = t.info?.identifier || t.id;
          const ttitle = normalizeTitle(t.info?.title || t.title);
          return (tid && (historyIds.includes(tid) || tid === seedId)) ||
            historyTitles.includes(ttitle) ||
            ttitle === seedNorm;
        };

        // 如果快取裡沒歌了，才去取得新的 Mix
        if (state.recommendCache.length === 0) {
          const { videoId } = parseYoutubeUrl(state.seedTrackUri);
          if (videoId) {
            const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
            const node = shoukaku.getIdealNode();
            let mixResult = null;
            try { mixResult = await node.rest.resolve(mixUrl); } catch (_) { }

            if (mixResult?.loadType === 'playlist' && mixResult.data?.tracks?.length > 1) {
              state.recommendCache = mixResult.data.tracks
                .slice(1) // 跳過種子原曲
                .filter(t => !isDuplicate(t))
                .map(t => ({
                  encoded: t?.encoded || t?.track || null,
                  track: t,
                  info: t.info || {},
                  requesterId: null,
                  requesterName: '自動推薦',
                  autoRecommended: true
                }));

              log.info(`${guildLabel(guildId)} [autoRecommend] 已為種子歌曲「${state.seedTrackTitle}」更新推薦快取 (${state.recommendCache.length} 首)`);
            }
          }
        }

        // 從快取中取出下一首，取出時再次檢查是否重複 (防範快取期間手動點了重複的歌)
        let foundItem = null;
        while (state.recommendCache.length > 0) {
          const candidate = state.recommendCache.shift();
          if (!isDuplicate(candidate)) {
            foundItem = candidate;
            break;
          }
        }

        if (foundItem) {
          state.queue.push(foundItem);
        } else if (state.recommendCache.length === 0) {
          // 如果快取清空後仍找不到適合的歌，下一首會再次觸發重新抓取
          log.info(`${guildLabel(guildId)} [autoRecommend] 快取候選曲目均已撥放或重複`);
        }
      } catch (e) {
        log.warn(`${guildLabel(guildId)} [autoRecommend] 推薦過程發生錯誤`, e);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // 若推薦成功加入佇列，直接繼續播放（跳過 idle）；否則才進入 idle
    if (state.queue.length === 0) {
      startIdleTimer(state, guildId);
      if (state.textChannelId && state.guild) {
        try {
          const channel = state.guild.channels.cache.get(state.textChannelId);
          if (channel) {
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('music_add')
                .setLabel('新增歌曲')
                .setStyle(ButtonStyle.Success)
                .setEmoji('➕'),
              new ButtonBuilder()
                .setCustomId('music_leave')
                .setLabel('離開')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('👋')
            );
            await channel.send({
              content: '✅ 全部播完啦，想繼續聽的話歡迎隨時點歌～ 🎵 ',
              components: [row]
            });
          }
        } catch (_) { }
      }
      return false;
    }
    // 佇列有推薦歌曲，往下繼續播放
  }

  clearIdle(state);
  const item = state.queue.shift();
  state.current = item;
  // 紀錄歷史與最後播放資訊
  if (item?.info?.title) {
    state.lastPlayedTitle = item.info.title;
    // 更新歷史紀錄 (保持最近 20 首)
    state.history.push({
      title: item.info.title,
      id: item.info.identifier,
      uri: item.info.uri
    });
    if (state.history.length > 20) state.history.shift();
  }
  if (item?.info?.uri) state.lastPlayedUri = item.info.uri;

  // 如果這首歌不是自動推薦的，就將它設為「種子歌曲」，並清空先前的推薦快取
  if (!item.autoRecommended) {
    state.seedTrackTitle = item.info?.title || null;
    state.seedTrackUri = item.info?.uri || null;
    state.recommendCache = [];
  }
  const title = item?.info?.title || '未知';
  log.info(`${guildLabel(guildId)} [playNext] ${item.autoRecommended ? '開始播放推薦' : '開始播放'}："${title}"`);

  const connection = state.player.connection;
  const isConnected = () => connection.state === 'CONNECTED';
  if (connection && !isConnected()) {
    log.warn(`${guildLabel(guildId)} [playNext] 連線尚未就緒（state=${connection.state}），等待最多 3 秒`);
    const start = Date.now();
    while (Date.now() - start < 3000 && !isConnected()) {
      await sleep(250);
    }
  }

  // 必須在 playTrack 之前掛上 listener
  if (!state.player._listenersAttached) {
    bindPlayerEvents(state.player, guildId);
  }

  const encoded = item?.encoded || item?.track?.encoded || item?.track?.track;
  if (!encoded) {
    // encoded 不存在，Lavalink 不會送任何事件，必須自己排程重試
    log.error(`${guildLabel(guildId)} [playNext] 播放 "${title}" 失敗：Missing encoded track`);
    await editOrSendError(state, '❌ 嗚嗚，我拿不到這首歌的播放資訊耶，暫時沒辦法播放給你聽喔！');
    state.current = null;
    return true;
  }

  try {
    await state.player.playTrack({ track: { encoded } });
    await sendNowPlaying(state, state.guild, true);
  } catch (e) {
    // playTrack 在 JS 呼叫層就失敗，Lavalink 不會送 exception 事件，必須自己排程重試
    log.error(`${guildLabel(guildId)} [playNext] playTrack 呼叫失敗："${title}"`, e);
    await editOrSendError(state, '❌ 嗚嗚，我拿不到這首歌的播放資訊耶，暫時沒辦法播放給你聽喔！');
    state.current = null;
    return true;
  }
  // playTrack 成功送出，後續由 Lavalink exception / end 事件負責
  return false;
}

function bindPlayerEvents(player, guildId) {
  if (player._listenersAttached) return;
  player._listenersAttached = true;

  const getLatestState = () => guildStates.get(guildId);
  // 跨事件共用的旗標：防止 exception + end 同時驅動兩次 playNext
  let playNextScheduled = false;

  const schedulePlayNext = () => {
    if (playNextScheduled) return;
    playNextScheduled = true;
    setImmediate(async () => {
      playNextScheduled = false;
      await playNext(guildId);
    });
  };

  const getCurrentEncoded = (s) => s?.current?.encoded || s?.current?.track?.encoded || s?.current?.track?.track;

  player.on('end', async (data) => {
    const s = getLatestState();
    if (!s || data.reason === 'replaced' || data.reason === 'stopped' || s.stopping) return;
    if (!s.current) return;  // current 已被清空代表已經跳過

    // 【防錯機制】只在非正常結束時才比對 encoded，防範前一首失敗歌曲殘留的 end 事件
    // 正常播完（finished）不做比對：encoded 編碼路徑可能因 Lavalink 版本而異，比對失敗會誤擋自動切歌
    if (data.reason !== 'finished') {
      const eventEncoded = getEventEncoded(data);
      const currEncoded = getCurrentEncoded(s);
      if (currEncoded && eventEncoded && currEncoded !== eventEncoded) {
        return;
      }
    }

    const title = s.current?.info?.title || '未知';

    // 若有未捕獲的例外導致直接以 end 失敗結束，在此補報錯
    if (data.reason === 'loadFailed' || data.reason === 'cleanup') {
      log.error(`${guildLabel(guildId)} [player:end] 播放失敗（${data.reason}）："${title}"`);
      if (s.textChannelId && s.guild) {
        try {
          const ch = s.guild.channels.cache.get(s.textChannelId);
          if (ch) ch.send(`❌ 哎呀，**${title}** 無法播放，這首先跳過囉！`).catch(() => { });
        } catch (_) { }
      }
    }

    s.current = null;        // 先清空，防止後續重複的 end 再次進入
    await deleteNowPlayingMsg(s);
    schedulePlayNext();
  });

  player.on('exception', async (data) => {
    const s = getLatestState();
    if (!s || s.stopping) return;

    const currentTrack = s.current;
    const title = currentTrack?.info?.title || '未知';
    if (currentTrack) {
      log.error(`${guildLabel(guildId)} [player:exception] 播放例外："${title}"`);
    }

    s.current = null;

    if (currentTrack && s.textChannelId && s.guild) {
      try {
        const ch = s.guild.channels.cache.get(s.textChannelId);
        if (ch) ch.send(`❌ 哎呀，**${title}** 無法播放，這首先跳過囉！`).catch(() => { });
      } catch (_) { }
    }

    await deleteNowPlayingMsg(s);

    // exception 代表 playTrack 成功送出（JS 層無例外），但 Lavalink 端播放失敗
    // 需等 _playNextRunning 釋放後再排程，確保不與 playNext 的 finally 競爭。
    const waitAndSchedule = () => {
      const latest = getLatestState();
      if (!latest || latest.stopping) return;
      if (latest._playNextRunning) { setTimeout(waitAndSchedule, 50); return; }
      schedulePlayNext();
    };
    waitAndSchedule();
  });

  player.on('stuck', (data) => {
    const s = getLatestState();
    if (!s || s.stopping || !s.current) return;

    const eventEncoded = getEventEncoded(data);
    const currEncoded = getCurrentEncoded(s);
    if (currEncoded && eventEncoded && currEncoded !== eventEncoded) return;

    const title = s.current?.info?.title || '未知';
    log.warn(`${guildLabel(guildId)} [player:stuck] 播放緩衝卡住："${title}"，30 秒後若無 end/exception 將強制跳過`);

    const stuckTrack = s.current;
    setTimeout(async () => {
      const latest = getLatestState();
      // 若 current 已換（代表已正常結束/跳過），不做任何處理
      if (!latest || latest.current !== stuckTrack || latest.stopping) return;
      log.error(`${guildLabel(guildId)} [player:stuck] 逾時 30 秒，強制跳過："${title}"`);
      latest.current = null;
      await deleteNowPlayingMsg(latest);
      // 等待 _playNextRunning 釋放後再排程，防止靜默被擋
      const tryPlay = () => {
        if (latest._playNextRunning) { setTimeout(tryPlay, 100); return; }
        schedulePlayNext();
      };
      tryPlay();
    }, 30_000);
  });

  player.on('closed', async () => {
    const s = getLatestState();
    if (!s || s.stopping) return;

    setTimeout(async () => {
      const botInVoice = client.guilds.cache.get(guildId)?.members.me?.voice?.channelId;
      const hasLavalinkConnection = shoukaku.connections.has(guildId);

      if (!botInVoice && !hasLavalinkConnection) {
        log.warn(`${guildLabel(guildId)} [player:closed] 連線已斷開，清除狀態`);
        const cs = guildStates.get(guildId);
        if (cs) { clearIdle(cs); try { await deleteNowPlayingMsg(cs); } catch (_) { } }
        guildStates.delete(guildId);
      }
      else if (botInVoice && !hasLavalinkConnection) {
        log.warn(`${guildLabel(guildId)} [player:closed] 幽靈連線，強制離開語音頻道`);
        const cs = guildStates.get(guildId);
        if (cs) { clearIdle(cs); try { await deleteNowPlayingMsg(cs); } catch (_) { } }
        guildStates.delete(guildId);
        try { await shoukaku.leaveVoiceChannel(guildId); } catch (_) { }
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
  const requester = current.autoRecommended ? '🤖 推薦歌曲' : (current.requesterId ? `<@${current.requesterId}>` : '未知');
  const channelName = guild.members.me?.voice?.channel?.toString() || '未知';

  const embed = new EmbedBuilder()
    .setTitle('🎵  正在播放')
    .setDescription(uri ? `**[${title}](${uri})**\n${author}` : `**${title}**\n${author}`)
    .addFields({ name: ' ', value: `${requester} | ${channelName}` })
    .setColor(0x3498db);

  if (current.info.artworkUrl) {
    embed.setThumbnail(current.info.artworkUrl);
  }

  return embed;
}

function buildControls(autoRecommend = true) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_add')
      .setLabel('新增歌曲')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('music_skip')
      .setLabel('下一首')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('music_queue')
      .setLabel('待播清單')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('music_autorecommend')
      .setLabel(autoRecommend ? '自動推薦：開' : '自動推薦：關')
      .setEmoji('🤖')
      .setStyle(autoRecommend ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music_clear')
      .setLabel('清空')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music_leave')
      .setLabel('離開')
      .setEmoji('👋')
      .setStyle(ButtonStyle.Danger)
  );

  return [row1, row2];
}

function buildQueueEmbed(state, page, withIcon) {
  const perPage = 10;
  const total = state.queue.length;
  const maxPage = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const items = state.queue.slice(start, start + perPage);
  const lines = items.length > 0
    ? items.map((t, i) => `${start + i + 1}. ${t.info.title || '未知'}`).join('\n')
    : '（無項目）';
  const titleBase = `待播清單 (第 ${page}/${maxPage} 頁，共 ${total} 首)`;
  const title = withIcon ? `📜 ${titleBase}` : titleBase;

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
    return interaction.reply({ content: '❌ 待播清單目前空空如也喔。', flags: MessageFlags.Ephemeral });
  }
  const perPage = 10;
  const maxPage = Math.max(1, Math.ceil(total / perPage));
  if (page < 1 || page > maxPage) {
    return interaction.reply({ content: `❌ 頁數超出範圍囉，請輸入 1 ~ ${maxPage} 之間的數字。`, flags: MessageFlags.Ephemeral });
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
  // 先刪除上一首的「正在播放」訊息，再送新的
  if (state.nowPlayingMsg) {
    try { await state.nowPlayingMsg.delete(); } catch (_) { }
    state.nowPlayingMsg = null;
  }
  const payload = { embeds: [embed], components: buildControls(state.autoRecommend) };
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
  } catch (_) { }
}

async function deleteNowPlayingMsg(state) {
  if (!state.nowPlayingMsg) return;
  try {
    await state.nowPlayingMsg.delete();
  } catch (_) { }
  state.nowPlayingMsg = null;
}

async function handlePlay(interaction) {
  await interaction.deferReply();
  const res = await ensureVoice(interaction);
  if (!res.ok) return interaction.editReply(res.message);
  const state = getState(interaction.guildId);
  if (!state.player) return interaction.editReply('❌ 發生一點錯誤，請再試一次看看！');

  const query = interaction.options.getString('song', true);
  let searchMessage;
  if (res.message) {
    await interaction.editReply(res.message);
    searchMessage = await interaction.followUp({ content: `🔎 正在搜尋 \`${query}\` 中...` });
  } else {
    searchMessage = await interaction.editReply(`🔎 正在搜尋 \`${query}\` 中...`);
  }

  return handlePlayRequest(interaction, query, state, searchMessage);
}

async function handlePlayRequest(interaction, query, state, searchMessage) {
  const guildId = interaction.guildId;
  const userName = interaction.user.displayName || interaction.user.username;
  log.info(`${guildLabel(guildId)} [handlePlayRequest] 開始處理查詢："${query}" (by ${userName})`);

  const { videoId, listId } = parseYoutubeUrl(query);
  if (videoId && listId) {
    log.info(`${guildLabel(guildId)} [handlePlayRequest] 偵測到混合連結，顯示選擇選單`);
    const [singleResolved, playlistResolved] = await Promise.all([
      resolveTracks(query, 'single'),
      resolveTracks(query, 'playlist')
    ]);
    const videoTitle = singleResolved.tracks?.[0]?.info?.title || '此影片';
    const playlistName = playlistResolved.info?.name || '此播放清單';
    const playlistCount = playlistResolved.tracks?.length ?? 0;
    const TIMEOUT_MS = 10_000;

    const pendingKey = `${interaction.user.id}:${interaction.guildId}`;
    pendingPlayChoices.set(pendingKey, {
      query,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      userName,
      singleResolved,
      playlistResolved,
      expiresAt: Date.now() + TIMEOUT_MS,
      timeoutId: null
    });

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('play_single')
        .setLabel(`只加入 ${videoTitle}`.slice(0, 80))
        .setEmoji('🎵')
        .setStyle(ButtonStyle.Primary)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('play_playlist')
        .setLabel(`加入整個播放清單共 ${playlistCount} 首`.slice(0, 80))
        .setEmoji('📋')
        .setStyle(ButtonStyle.Success)
    );

    const msg = `<@${interaction.user.id}> \n此影片連結同時包含播放清單，\n要只加入 **${videoTitle}**，\n還是加入整個播放清單共 **${playlistCount}** 首？\n-# 10 秒後將只加入 **${videoTitle}**。`;
    const choiceMsg = await searchMessage.edit({ content: msg, components: [row1, row2] });

    const timeoutId = setTimeout(async () => {
      const p = pendingPlayChoices.get(pendingKey);
      if (!p || p.timeoutId !== timeoutId) return;
      pendingPlayChoices.delete(pendingKey);
      log.info(`${guildLabel(guildId)} [handlePlayRequest] 選擇選單已逾時，自動選擇播放單曲`);
      try { await choiceMsg.edit({ components: [] }); } catch (_) { }
      try {
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
        log.error(`${guildLabel(p.guildId)} [finalizePlay] 自動加入單首時發生錯誤`, e);
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
    return reply(`❌ 抱歉，我翻遍了也找不到跟 \`${query}\` 相關的音樂耶...`);
  }

  if (resolved.type === 'error') {
    log.error(`[finalizePlay] 搜尋發生錯誤，query="${query}"`);
    return reply(`❌ 搜尋時發生錯誤，請稍後再試看看！`);
  }

  // wasIdle：佇列空且沒有正在播放的曲目，才需要主動觸發 playNext
  // 同時排除 _playNextRunning 的情況，避免兩個 playNext 並行跑
  const wasIdle = !state.current && state.queue.length === 0 && !state._playNextRunning;
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
    const playlistName = resolved.info?.name || '此播放清單';
    log.info(`${guildLabel(guildId || state.guild?.id)} [finalizePlay] 加入播放清單："${playlistName}" (${added.length} 首) (by ${userName})`);
    await reply(`✅ \`${userName}\` 一口氣點了 **${added.length}** 首歌曲(**${playlistName}**)，已經通通塞進清單啦！`);
  } else {
    const title = added[0]?.info?.title || '未知';
    log.info(`${guildLabel(guildId || state.guild?.id)} [finalizePlay] 加入單曲："${title}" (by ${userName})`);
    await reply(`✅ \`${userName}\` 點的 **${title}** 已經加入隊列排隊囉！`);
  }

  if (wasIdle) {
    const resolvedGuildId = guildId || state.guild?.id || interaction?.guildId;
    if (!resolvedGuildId) {
      log.error('[finalizePlay] 無法取得 guildId，跳過 playNext');
      return;
    }
    await playNext(resolvedGuildId);
  }
}

client.once(Events.ClientReady, async () => {
  await client.application.fetch();
  await registerCommands();
  log.info(`[Main] 機器人已上線，登入身份：${client.user.tag}`);

  // 機器人上線後，初始化 Lavalink 連線
  try {
    shoukaku.addNode({
      name: 'default',
      url: `${lavalinkHost}:${lavalinkPort}`,
      auth: lavalinkPassword,
      secure: lavalinkSecure
    });
    setImmediate(() => attachNodeDisconnectHandler('default'));
  } catch (e) {
    log.error('[Lavalink] 初始化節點失敗：', e?.message || e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'add_song_modal') {
        const query = interaction.fields.getTextInputValue('song_query');
        log.info(`${guildLabel(interaction.guildId)} [Interaction:Modal] 提交「新增歌曲」表單，查詢內容："${query}" (by ${interaction.user.username})`);
        if (!query) return interaction.reply({ content: '❌ 請輸入歌曲網址或關鍵字！', flags: MessageFlags.Ephemeral });

        await interaction.deferReply();
        const res = await ensureVoice(interaction);
        if (!res.ok) return interaction.editReply(res.message);

        const state = getState(interaction.guildId);
        if (!state.player) return interaction.editReply('❌ 發生一點錯誤，請再試一次看看！');

        let searchMessage;
        if (res.message) {
          await interaction.editReply(res.message);
          searchMessage = await interaction.followUp({ content: `🔎 正在搜尋 \`${query}\` 中...` });
        } else {
          searchMessage = await interaction.editReply(`🔎 正在搜尋 \`${query}\` 中...`);
        }

        return handlePlayRequest(interaction, query, state, searchMessage);
      }
    }

    if (interaction.isChatInputCommand()) {
      const state = getState(interaction.guildId);
      state.guild = interaction.guild;
      log.info(`${guildLabel(interaction.guildId)} [Interaction:Command] 執行指令：/${interaction.commandName} (by ${interaction.user.username})`);

      if (interaction.commandName === 'join') {
        const voice = interaction.member?.voice;
        if (!voice?.channelId) {
          return interaction.reply({ content: '❌ 你要先進入一個語音頻道，我才能過去找你呀！' });
        }

        const hasConnection = shoukaku.connections?.has(interaction.guildId);
        const existingChannelId = state.player?.connection?.channelId
          || interaction.guild.members.me?.voice?.channelId
          || null;

        if (hasConnection && existingChannelId === voice.channelId) {
          return interaction.reply({ content: '❌ 哎呀，我早就在這個頻道裡面等你囉！' });
        }

        if (hasConnection && existingChannelId) {
          try {
            // 移動頻道時不設 stopping=true，避免 end 事件忽略 playNext
            // 僅暫時忽略玩家事件（Lavalink 繼續播放，不中斷）
            log.info(`${guildLabel(interaction.guildId)} [Interaction:Command] /join 從 ${existingChannelId} 移動至 ${voice.channelId} (by ${interaction.user.username})`);

            // 記住舊頻道資訊，移動前先處理
            const oldTextChannelId = state.textChannelId;
            const oldTextChannel = oldTextChannelId ? interaction.guild.channels.cache.get(oldTextChannelId) : null;

            // 刪除舊頻道的正在播放訊息
            await deleteNowPlayingMsg(state);

            // 在舊頻道送出「被拉走」通知（只在不同頻道時才送）
            if (oldTextChannel && oldTextChannelId !== interaction.channelId) {
              const newChannelMention = `<#${interaction.channelId}>`;
              await oldTextChannel.send(
                `👋 \`${interaction.user.displayName}\` 把我拉走囉！如要繼續聆聽音樂，請前往 ${newChannelMention}。`
              ).catch(() => { });
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
            state.textChannelId = interaction.channelId;
            state.guild = interaction.guild;
            await interaction.reply({
              content: `🔉 \`${interaction.user.displayName}\` 把我拉過來囉！已移動至：${voice.channel}`
            });
            if (state.current) {
              await sendNowPlaying(state, interaction.guild, true);
            }
            return;
          } catch (e) {
            log.error(`${guildLabel(interaction.guildId)} [Interaction:Command] 移動頻道時發生錯誤`, e);
            try { await interaction.reply({ content: '❌ 發生一點錯誤，請再試一次看看！' }); } catch (_) { }
            return;
          }
        }

        await interaction.deferReply();
        state.stopping = false;

        const joined = await joinVoice(interaction);
        if (!joined.ok) return interaction.editReply(joined.message);

        log.info(`${guildLabel(interaction.guildId)} [Interaction:Command] /join 加入頻道：${joined.voice.channel.name} (by ${interaction.user.username})`);
        return interaction.editReply(
          joinedMessage(interaction.user.displayName, joined.voice.channel)
        );
      }

      if (interaction.commandName === 'play' || interaction.commandName === 'search') {
        return handlePlay(interaction);
      }

      if (interaction.commandName === 'skip' || interaction.commandName === 'next') {
        if (!state.player || !state.current) {
          return interaction.reply('❌ 現在很安靜唷，沒有音樂可以跳過啦！');
        }
        const title = state.current.info?.title || '未知歌曲';
        log.info(`${guildLabel(interaction.guildId)} [playNext] 使用者請求跳過："${title}" (by ${interaction.user.username})`);
        await interaction.reply(`⏭️ \`${interaction.user.displayName}\` 卡歌啦！已幫您跳過 **${title}**。`);
        // 先停止當前播放
        try { state.player.stopTrack(); } catch (_) { }
        state.current = null;
        await deleteNowPlayingMsg(state);
        return playNext(interaction.guildId);
      }

      if (interaction.commandName === 'stop' || interaction.commandName === 'leave') {
        if (!state.player && !shoukaku.connections?.has(interaction.guildId)) return interaction.reply('❌ 我現在不在頻道裡喔！');
        log.info(`${guildLabel(interaction.guildId)} [guildState] 停止播放並離開語音頻道`);
        await interaction.reply(`👋 \`${interaction.user.displayName}\` 讓我先退下了，停止播放並退出頻道囉！`);
        state.stopping = true;
        state.queue = [];
        state.current = null;
        clearIdle(state);
        await deleteNowPlayingMsg(state);
        try { await state.player.destroy(); } catch (_) { }
        try { await shoukaku.leaveVoiceChannel(interaction.guildId); } catch (_) { }
        guildStates.delete(interaction.guildId);
        return;
      }

      if (interaction.commandName === 'clear') {
        if (state.queue.length === 0) return interaction.reply('❌ 待播清單本來就是空的啦！');
        log.info(`${guildLabel(interaction.guildId)} [queue] 清空待播清單（共 ${state.queue.length} 首）`);
        state.queue = [];
        return interaction.reply(`✅ 痛快！\`${interaction.user.displayName}\` 把待播清單通通清空了！`);
      }

      if (interaction.commandName === 'nowplaying') {
        log.info(`${guildLabel(interaction.guildId)} [Interaction:Command] /${interaction.commandName} 查看目前播放`);
        const embed = buildNowPlayingEmbed(state, interaction.guild);
        if (!embed) return interaction.reply({ content: '❌ 目前沒有播放任何音樂喔。', flags: MessageFlags.Ephemeral });
        return interaction.reply({ embeds: [embed], components: buildControls(state.autoRecommend), flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === 'autorecommend') {
        state.autoRecommend = !state.autoRecommend;
        log.info(`${guildLabel(interaction.guildId)} [guildState] 自動推薦設定改為：${state.autoRecommend ? '開啟' : '關閉'}`);
        if (state.nowPlayingMsg) {
          try { await state.nowPlayingMsg.edit({ components: buildControls(state.autoRecommend) }); } catch (_) { }
        }
        return interaction.reply({
          content: state.autoRecommend
            ? `🤖 \`${interaction.user.displayName}\` 開啟了自動推薦！佇列播完後將自動推薦相似歌曲～`
            : `🤖 \`${interaction.user.displayName}\` 關閉了自動推薦。`
        });
      }

      if (interaction.commandName === 'queue' || interaction.commandName === 'playlist') {
        const page = interaction.options.getInteger('page') || 1;
        return sendQueueMessage(interaction, state, page);
      }
    }

    if (interaction.isButton()) {
      const state = getState(interaction.guildId);
      log.info(`${guildLabel(interaction.guildId)} [Interaction:Button] 點擊按鈕：${interaction.customId} (by ${interaction.user.username})`);

      if (interaction.customId === 'play_single' || interaction.customId === 'play_playlist') {
        const pendingKey = `${interaction.user.id}:${interaction.guildId}`;
        const pending = pendingPlayChoices.get(pendingKey);

        if (!pending) {
          return interaction.reply({ content: '❌ 這不是你的選擇喔，或選擇已逾時！', flags: MessageFlags.Ephemeral });
        }

        if (Date.now() > pending.expiresAt) {
          pendingPlayChoices.delete(pendingKey);
          clearTimeout(pending.timeoutId);
          return interaction.update({ content: '❌ 這個選擇已經逾時（10 秒）或無效，請重新使用指令。', components: [] });
        }

        clearTimeout(pending.timeoutId);
        pendingPlayChoices.delete(pendingKey);

        // 確保 state.guild 有值（按鈕互動不會走 slash command 的 state.guild 賦值路徑）
        if (!state.guild) state.guild = interaction.guild;

        await interaction.update({ content: '📥 正在加入歌曲中...', components: [] });
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
          return interaction.reply({ content: '❌ 現在很安靜唷，沒有音樂可以跳過啦！' });
        }
        const title = state.current.info?.title || '未知歌曲';
        log.info(`${guildLabel(interaction.guildId)} [playNext] 跳過："${title}" (by ${interaction.user.username})`);
        await interaction.reply({ content: `⏭️ \`${interaction.user.displayName}\` 卡歌啦！已幫您跳過 **${title}**。` });
        // 先停止當前播放
        try { state.player.stopTrack(); } catch (_) { }
        state.current = null;
        await deleteNowPlayingMsg(state);
        return playNext(interaction.guildId);
      }

      if (interaction.customId === 'music_queue') {
        return sendQueueMessage(interaction, state, 1);
      }

      if (interaction.customId === 'music_clear') {
        if (state.queue.length === 0) {
          return interaction.reply({ content: '❌ 待播清單本來就是空的啦！' });
        }
        log.info(`${guildLabel(interaction.guildId)} [queue] 清空待播清單（共 ${state.queue.length} 首） (by ${interaction.user.username})`);
        state.queue = [];
        return interaction.reply({ content: `✅ 痛快！\`${interaction.user.displayName}\` 把待播清單通通清空了！` });
      }

      if (interaction.customId === 'music_autorecommend') {
        state.autoRecommend = !state.autoRecommend;
        log.info(`${guildLabel(interaction.guildId)} [autoRecommend] 切換自動推薦：${state.autoRecommend ? '開啟' : '關閉'} (by ${interaction.user.username})`);
        if (state.nowPlayingMsg) {
          try { await state.nowPlayingMsg.edit({ components: buildControls(state.autoRecommend) }); } catch (_) { }
        }
        return interaction.reply({
          content: state.autoRecommend
            ? `🤖 \`${interaction.user.displayName}\` 開啟了自動推薦！佇列播完後將自動推薦相似歌曲～`
            : `🤖 \`${interaction.user.displayName}\` 關閉了自動推薦。`
        });
      }

      if (interaction.customId === 'music_leave') {
        if (!state.player) return interaction.reply({ content: '❌ 我現在不在頻道裡喔！' });
        log.info(`${guildLabel(interaction.guildId)} [guildState] 離開語音頻道 (by ${interaction.user.username})`);
        await interaction.reply({ content: `👋 \`${interaction.user.displayName}\` 按下了離開，我先退下囉！` });
        state.stopping = true;
        state.queue = [];
        state.current = null;
        clearIdle(state);
        await deleteNowPlayingMsg(state);
        try { await state.player.destroy(); } catch (_) { }
        try { await shoukaku.leaveVoiceChannel(interaction.guildId); } catch (_) { }
        guildStates.delete(interaction.guildId);
        return;
      }

      if (interaction.customId === 'music_add') {
        const modal = new ModalBuilder()
          .setCustomId('add_song_modal')
          .setTitle('新增歌曲');

        const songInput = new TextInputBuilder()
          .setCustomId('song_query')
          .setLabel('歌曲網址或關鍵字')
          .setPlaceholder('在此貼上 YouTube 連結或輸入關鍵字...')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder()
          .addComponents(songInput);
        modal.addComponents(row);

        return interaction.showModal(modal);
      }

      if (interaction.customId.startsWith('queue_prev:') || interaction.customId.startsWith('queue_next:')) {
        const page = Number(interaction.customId.split(':')[1]);
        const total = state.queue.length;
        const perPage = 10;
        const maxPage = Math.max(1, Math.ceil(total / perPage));
        if (total === 0) {
          return interaction.update({ content: '❌ 待播清單目前空空如也喔。', embeds: [], components: [] });
        }
        const safePage = Math.min(Math.max(page, 1), maxPage);
        const { embed } = buildQueueEmbed(state, safePage, false);
        const controls = buildQueueControls(safePage, maxPage);
        return interaction.update({ embeds: [embed], components: [controls] });
      }

      if (interaction.customId === 'queue_clear') {
        if (state.queue.length === 0) {
          return interaction.update({ content: '❌ 待播清單目前空空如也喔。', embeds: [], components: [] });
        }
        state.queue = [];
        await interaction.deferUpdate();
        await interaction.followUp({ content: `✅ 痛快！\`${interaction.user.displayName}\` 把待播清單通通清空了！` });
        return interaction.editReply({ content: '✅ 待播清單被你清空了喔！', embeds: [], components: [] });
      }
    }
  } catch (e) {
    log.error('[interaction] 處理互動時發生未預期錯誤', e);
    if (interaction?.isRepliable?.()) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: '❌ 發生一點錯誤，請再試一次看看！' });
        } else {
          await interaction.reply({ content: '❌ 發生一點錯誤，請再試一次看看！' });
        }
      } catch (_) { }
    }
  }
});

shoukaku.on('error', (name, error) => {
  // 重連迴圈期間靜默（由 startReconnectLoop 統一處理重試）
  if (isReconnecting || isWaitingReconnect) return;
  log.error(`[Lavalink] 節點發生錯誤：`, error?.message || error);
});

shoukaku.on('ready', async (name) => {
  if (lavalinkReady) return;   // 防止重複觸發（多個殘留連線同時就緒）
  lavalinkReady = true;
  lavalinkEverReady = true;
  stopReconnectLoop();
  log.info(`[Lavalink] 節點已就緒`);

  if (isReconnecting) {
    isReconnecting = false;
    log.info(`[Lavalink] 節點重連成功，正在恢復各頻道播放`);
    await resumeAllGuilds();
  }
});

shoukaku.on('reconnecting', (name) => {
  lavalinkReady = false;
  // 啟動時從未就緒過，不算「斷線」，靜默即可
  if (!isReconnecting && lavalinkEverReady) {
    isReconnecting = true;
    pauseAllGuilds().catch(() => { });
  }
});

shoukaku.on('close', (name) => {
  lavalinkReady = [...shoukaku.nodes.values()].some((n) => n.state === NODE_STATE_CONNECTED);
  log.warn(`[Lavalink] 節點連線關閉，lavalinkReady=${lavalinkReady}`);
});

log.info(`[Main] 程式啟動`);

process.on('SIGINT', () => { log.info(`[Main] 程式停止`); process.exit(0); });
process.on('SIGTERM', () => { log.info(`[Main] 程式停止`); process.exit(0); });

// 捕獲所有未處理的 Promise rejection（防禦性保護）
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason?.message || String(reason);
  // Shoukaku 內部發送 API 請求時若剛好遇到 Lavalink 關閉，會產生無法捕獲的 fetch failed
  // 由於這不影響我們的重連邏輯，將其過濾靜默以保持版面整潔
  if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
    // 若需要除錯可改為 log.warn，一般情況下可直接忽略此噪音
    return;
  }
  log.error('[unhandledRejection] 未預期的 Promise 異常（不中斷程式）：', msg);
});

// 捕獲所有未預期的同步例外（防禦性保護）
process.on('uncaughtException', (err) => {
  log.error('[uncaughtException] 捕獲未預期例外（不中斷程式）：', err?.message || err);
});

client.login(token);
