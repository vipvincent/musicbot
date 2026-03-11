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
  console.error('Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const lavalinkHost = process.env.LAVALINK_HOST || '127.0.0.1';
const lavalinkPort = process.env.LAVALINK_PORT || '2333';
const lavalinkPassword = process.env.LAVALINK_PASSWORD || 'youshallnotpass';
const lavalinkSecure = (process.env.LAVALINK_SECURE || 'false').toLowerCase() === 'true';

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

const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), nodes, {
  resume: true,
  resumeTimeout: 30,
  reconnectTries: 2
});

const guildStates = new Map();
let lavalinkReady = false;
const NODE_STATE_CONNECTED = 1;

const commandData = [
  new SlashCommandBuilder().setName('join').setDescription('讓機器人加入您目前的語音頻道'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('播放音樂 (支援網址、關鍵字、播放清單)')
    .addStringOption((opt) =>
      opt.setName('song').setDescription('請輸入網址、關鍵字或播放清單').setRequired(true)
    ),
  new SlashCommandBuilder().setName('skip').setDescription('跳過當前歌曲'),
  new SlashCommandBuilder().setName('next').setDescription('跳過當前歌曲'),
  new SlashCommandBuilder().setName('stop').setDescription('停止播放並清空隊列'),
  new SlashCommandBuilder().setName('leave').setDescription('離開語音頻道'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('查看當前待待播清單')
    .addIntegerOption((opt) =>
      opt.setName('page').setDescription('要查看的頁數').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('查看當前待待播清單')
    .addIntegerOption((opt) =>
      opt.setName('page').setDescription('要查看的頁數').setRequired(false)
    ),
  new SlashCommandBuilder().setName('clear').setDescription('清空待播清單'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('查看目前正在播放的歌曲資訊')
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commandData });
  console.log('Registered global commands');
  // Remove any leftover guild-specific commands to prevent duplicates
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: [] });
      console.log(`Cleared guild commands for ${guild.id}`);
    } catch (e) {
      console.error(`[registerCommands] failed to clear guild commands for ${guild.id}`, e);
    }
  }
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
      stopping: false
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
    try {
      state.stopping = true;
      state.queue = [];
      state.current = null;
      if (state.textChannelId && state.guild) {
        const channel = state.guild.channels.cache.get(state.textChannelId);
        if (channel) {
          await channel.send('⏰ 偵測到長時間未播放音樂，機器人已自動離開語音頻道。');
        }
      }
      if (state.player) {
        try {
          await state.player.destroy();
        } catch (_) {}
      }
      await shoukaku.leaveVoiceChannel(guildId);
    } catch (_) {}
    guildStates.delete(guildId);
  }, 5 * 60 * 1000);
}

async function ensureVoice(interaction, allowMove) {
  const member = interaction.member;
  const voice = member.voice;

  if (!voice || !voice.channelId) {
    return { ok: false, message: ':x: 你要先進入一個語音頻道，我才能過去找你呀！' };
  }

  const existing = interaction.guild.members.me?.voice?.channelId;
  if (existing && existing !== voice.channelId && !allowMove) {
    const name = interaction.guild.channels.cache.get(existing)?.name || '未知';
    return { ok: false, message: `:x: 不好意思，我已經在 **${name}** 當 DJ 囉！` };
  }

  const state = getState(interaction.guildId);
  const existingChannelId = state.player?.connection?.channelId || interaction.guild.members.me?.voice?.channelId;
  const hasConnection = shoukaku.connections?.has(interaction.guildId);
  const needsJoin = !state.player || !hasConnection;
  if (!needsJoin && (existingChannelId || hasConnection)) {
    if (existingChannelId === voice.channelId) {
      return { ok: true, message: null };
    }
    if (!allowMove) {
      const name = interaction.guild.channels.cache.get(existingChannelId)?.name || '未知';
      return { ok: false, message: `:x: 不好意思，我已經在 **${name}** 當 DJ 囉！` };
    }
    try {
      await shoukaku.leaveVoiceChannel(interaction.guildId);
    } catch (e) {
      console.error('[ensureVoice] leaveVoiceChannel error', e);
    }
  }

  let player;
  try {
    player = await shoukaku.joinVoiceChannel({
      guildId: interaction.guildId,
      channelId: voice.channelId,
      shardId: interaction.guild.shardId,
      deaf: true
    });
  } catch (e) {
    console.error('[ensureVoice] joinVoiceChannel error', e);
    return { ok: false, message: ':x: 發生一點錯誤，請再試一次看看！' };
  }

  state.player = player;
  state.textChannelId = interaction.channelId;
  state.guild = interaction.guild;

  if (existing && existing !== voice.channelId) {
    return { ok: true, message: `:sound: \`${interaction.user.displayName}\` 把我拉過來囉！已移動至：**${voice.channel.name}**` };
  }
  return { ok: true, message: `:sound: \`${interaction.user.displayName}\` 呼叫我啦！已抵達保護區：**${voice.channel.name}**` };
}

async function resolveTracks(query) {
  const node = shoukaku.getIdealNode();
  if (!lavalinkReady || !node || node.state !== NODE_STATE_CONNECTED) {
    console.error('[resolveTracks] Lavalink not ready');
    return { type: 'error', error: 'Resolve error' };
  }
  if (!node.rest || typeof node.rest.resolve !== 'function') {
    console.error('[resolveTracks] node.rest.resolve is not available');
    return { type: 'error', error: 'Resolve error' };
  }
  const isUrl = /^https?:\/\//i.test(query);
  let search = isUrl ? query : `ytsearch:${query}`;
  if (isUrl && query.includes('list=')) {
    try {
      const url = new URL(query);
      const listId = url.searchParams.get('list');
      if (listId) {
        search = `https://www.youtube.com/playlist?list=${listId}`;
      }
    } catch (_) {}
  }
  let result;
  try {
    result = await node.rest.resolve(search);
  } catch (e) {
    console.error('[resolveTracks] resolve exception', e);
    return { type: 'error', error: e?.message || 'Resolve error' };
  }
  if (result?.loadType === 'error') {
    console.error('[resolveTracks] loadType=error', result);
  }

  if (!result || result.loadType === 'empty') {
    return { type: 'empty', tracks: [] };
  }

  if (result.loadType === 'error') {
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

  if (state.queue.length === 0) {
    state.current = null;
    startIdleTimer(state, guildId);
    return;
  }

  clearIdle(state);
  const item = state.queue.shift();
  state.current = item;

  const connection = state.player.connection;
  if (connection && connection.state !== NODE_STATE_CONNECTED) {
    const start = Date.now();
    while (Date.now() - start < 3000 && connection.state !== NODE_STATE_CONNECTED) {
      await sleep(250);
    }
  }

  try {
    const encoded = item?.encoded || item?.track?.encoded || item?.track?.track;
    if (!encoded) {
      throw new Error('Missing encoded track');
    }
    await state.player.playTrack({ track: { encoded } });
    await sendNowPlaying(state, state.guild, true);
  } catch (e) {
    console.error('[playNext] playTrack error', e);
    try {
      if (state.textChannelId && state.guild) {
        const channel = state.guild.channels.cache.get(state.textChannelId);
        if (channel) {
          await channel.send(':x: 嗚嗚，我拿不到這首歌的播放資訊耶，暫時沒辦法唱給你聽喔！');
        }
      }
    } catch (_) {}
    state.current = null;
    return playNext(guildId);
  }
  if (!state.player._listenersAttached) {
    state.player._listenersAttached = true;

    state.player.on('end', async (data) => {
      if (data.reason === 'replaced') return;
      if (state.stopping) return;
      await playNext(guildId);
    });

    state.player.on('exception', async () => {
      if (state.stopping) return;
      try {
        if (state.textChannelId && state.guild) {
          const channel = state.guild.channels.cache.get(state.textChannelId);
          if (channel) {
            const title = state.current?.info?.title || '未知';
            await channel.send(`:x: 哎呀，我拿不到 **${title}** 的播放資訊耶，這首可能要先跳過囉！`);
          }
        }
      } catch (_) {}
      await playNext(guildId);
    });

    state.player.on('stuck', async () => {
      if (state.stopping) return;
      try {
        if (state.textChannelId && state.guild) {
          const channel = state.guild.channels.cache.get(state.textChannelId);
          if (channel) {
            await channel.send(':x: 嗚嗚，我拿不到這首歌的播放資訊耶，暫時沒辦法唱給你聽喔！');
          }
        }
      } catch (_) {}
      await playNext(guildId);
    });

    state.player.on('closed', async () => {
      guildStates.delete(guildId);
    });
  }
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
    return interaction.reply(':x: 待播清單目前空空如也喔。');
  }
  const perPage = 10;
  const maxPage = Math.max(1, Math.ceil(total / perPage));
  if (page < 1 || page > maxPage) {
    return interaction.reply(`:x: 頁數超出範圍囉，請輸入 1 ~ ${maxPage} 之間的數字。`);
  }

  const { embed } = buildQueueEmbed(state, page, true);
  const controls = buildQueueControls(page, maxPage);
  return interaction.reply({ embeds: [embed], components: [controls] });
}

async function sendNowPlaying(state, guild, silent) {
  if (!state || !state.current) return;
  if (!state.textChannelId || !guild) return;
  const channel = guild.channels.cache.get(state.textChannelId);
  if (!channel) return;
  const embed = buildNowPlayingEmbed(state, guild);
  const payload = { embeds: [embed], components: [buildControls()] };
  if (silent) {
    payload.flags = MessageFlags.SuppressNotifications;
  }
  await channel.send(payload);
}

client.once(Events.ClientReady, async () => {
  await registerCommands();
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const state = getState(interaction.guildId);
      state.guild = interaction.guild;

    if (interaction.commandName === 'join') {
      const res = await ensureVoice(interaction, true);
      if (!res.ok) {
        return interaction.reply({ content: res.message });
      }
      if (!res.message) {
        return interaction.reply({ content: ':x: 哎呀，我早就在這個頻道裡面等你囉！' });
      }
      return interaction.reply({ content: res.message });
    }

    if (interaction.commandName === 'play') {
      await interaction.deferReply();
      const res = await ensureVoice(interaction, false);
      if (!res.ok) return interaction.editReply(res.message);
      const stateAfterJoin = getState(interaction.guildId);
      if (!stateAfterJoin.player) {
        return interaction.editReply(':x: 發生一點錯誤，請再試一次看看！');
      }

      const query = interaction.options.getString('song', true);
      let searchMessage = null;
      if (res.message) {
        await interaction.editReply(res.message);
        searchMessage = await interaction.followUp({ content: ':mag_right: 正在搜尋音樂中...' });
      } else {
        searchMessage = await interaction.editReply(':mag_right: 正在搜尋音樂中...');
      }

      const resolved = await resolveTracks(query);
      if (resolved.type === 'empty') {
        const msg = `:x: 抱歉，我翻遍了也找不到跟 \`${query}\` 相關的音樂耶...`;
        return searchMessage ? searchMessage.edit(msg) : interaction.followUp(msg);
      }
      if (resolved.type === 'error') {
        const msg = resolved.error.includes('DRM')
          ? ':x: 嗚嗚，這個平台因為版權保護不支援喔。'
          : ':x: 糟糕，解析這首歌的資訊時出了點差錯，我可能沒辦法播放它喔！';
        return searchMessage ? searchMessage.edit(msg) : interaction.followUp(msg);
      }

      const added = [];
      for (const track of resolved.tracks) {
        const item = {
          encoded: track?.encoded || track?.track || (typeof track === 'string' ? track : null),
          track,
          info: track.info || {},
          requesterId: interaction.user.id,
          requesterName: interaction.user.displayName || interaction.user.username
        };
        state.queue.push(item);
        added.push(item);
      }

      if (!state.current) {
        await playNext(interaction.guildId);
      }

      if (resolved.type === 'playlist') {
        const msg = `:white_check_mark: \`${interaction.user.displayName}\` 一口氣點了 **${added.length}** 首音樂，已經通通塞進清單啦！`;
        return searchMessage ? searchMessage.edit(msg) : interaction.followUp(msg);
      }

      const title = added[0]?.info?.title || '未知';
      const msg = `:white_check_mark: \`${interaction.user.displayName}\` 點的 **${title}** 已經加入隊列排隊囉！`;
      return searchMessage ? searchMessage.edit(msg) : interaction.followUp(msg);
    }

    if (interaction.commandName === 'skip' || interaction.commandName === 'next') {
      if (!state.player || !state.current) {
        return interaction.reply(':x: 現在很安靜唷，沒有音樂可以跳過啦！');
      }
      const title = state.current.info?.title || '未知歌曲';
      await interaction.reply(`:track_next: \`${interaction.user.displayName}\` 卡歌啦！已幫您跳過 **${title}**。`);
      return state.player.stopTrack();
    }

    if (interaction.commandName === 'stop' || interaction.commandName === 'leave') {
      if (!state.player) return interaction.reply(':x: 我現在不在頻道裡喔！');
      const msg = `:wave: \`${interaction.user.displayName}\` 讓我先退下了，停止播放並退出頻道囉！`;
      await interaction.reply(msg);
      state.stopping = true;
      state.queue = [];
      state.current = null;
      try {
        await state.player.destroy();
      } catch (_) {}
      await shoukaku.leaveVoiceChannel(interaction.guildId);
      guildStates.delete(interaction.guildId);
      return;
    }

    if (interaction.commandName === 'clear') {
      if (state.queue.length === 0) return interaction.reply(':x: 待播清單本來就是空的啦！');
      state.queue = [];
      return interaction.reply(`:white_check_mark: 痛快！\`${interaction.user.displayName}\` 把待播清單通通清空了！`);
    }

    if (interaction.commandName === 'nowplaying') {
      const embed = buildNowPlayingEmbed(state, interaction.guild);
      if (!embed) return interaction.reply(':x: 目前沒有播放任何音樂喔。');
      return interaction.reply({ embeds: [embed], components: [buildControls()] });
    }

      if (interaction.commandName === 'queue' || interaction.commandName === 'playlist') {
        const page = interaction.options.getInteger('page') || 1;
        return sendQueueMessage(interaction, state, page);
      }
    }
  
    if (interaction.isButton()) {
      const state = getState(interaction.guildId);

    if (interaction.customId === 'music_skip') {
      if (!state.player || !state.current) {
        return interaction.reply({ content: ':x: 現在很安靜唷，沒有音樂可以跳過啦！' });
      }
      const title = state.current.info?.title || '未知歌曲';
      await interaction.reply({ content: `:track_next: \`${interaction.user.displayName}\` 卡歌啦！已幫您跳過 **${title}**。` });
      return state.player.stopTrack();
    }

    if (interaction.customId === 'music_queue') {
      return sendQueueMessage(interaction, state, 1);
    }

    if (interaction.customId === 'music_clear') {
      if (state.queue.length === 0) {
        return interaction.reply({ content: ':x: 待播清單本來就是空的啦！' });
      }
      state.queue = [];
      return interaction.reply({ content: `:white_check_mark: 痛快！\`${interaction.user.displayName}\` 把待播清單通通清空了！` });
    }

    if (interaction.customId === 'music_leave') {
      if (!state.player) return interaction.reply({ content: ':x: 我現在不在頻道裡喔！' });
      await interaction.reply({ content: `:wave: \`${interaction.user.displayName}\` 按下了離開，我先退下囉！` });
      state.stopping = true;
      state.queue = [];
      state.current = null;
      try {
        await state.player.destroy();
      } catch (_) {}
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
          return interaction.reply({ content: ':x: 待播清單本來就是空的啦！' });
        }
        state.queue = [];
        return interaction.reply({ content: `:white_check_mark: 痛快！\`${interaction.user.displayName}\` 把待播清單通通清空了！` });
      }
    }
  } catch (e) {
    console.error('[interaction] error', e);
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

shoukaku.on('error', (_, error) => console.error('Lavalink error:', error));
shoukaku.on('ready', (name) => {
  lavalinkReady = true;
  console.log(`Lavalink ready: ${name}`);
});
shoukaku.on('close', () => {
  const anyConnected = [...shoukaku.nodes.values()].some((node) => node.state === NODE_STATE_CONNECTED);
  lavalinkReady = anyConnected;
});

client.login(token);
