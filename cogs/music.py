import discord
from discord import app_commands
from discord.ext import commands
import asyncio
import tomllib
import os
import yt_dlp

# 讀取 config.toml
with open("config.toml", "rb") as f:
    config = tomllib.load(f)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG_PATH = os.path.join(BASE_DIR, config["paths"]["ffmpeg"])

FFMPEG_OPTIONS = {
    'before_options': config["ffmpeg_options"]["before_options"],
    'options': config["ffmpeg_options"]["options"],
    'executable': FFMPEG_PATH
}

# YTDL 提取器設定
ytdl_format_options = {
    'format': 'bestaudio/best',
    'outtmpl': '%(extractor)s-%(id)s-%(title)s.%(ext)s',
    'restrictfilenames': True,
    'noplaylist': False,  # 改為 False 以支援播放清單
    'nocheckcertificate': True,
    'ignoreerrors': False,
    'logtostderr': False,
    'quiet': True,
    'no_warnings': True,
    'default_search': 'auto',
    'source_address': '0.0.0.0', # 綁定到 ipv4
    'extract_flat': 'in_playlist', # 本地提取播放清單元數據，加速反應
}

ytdl = yt_dlp.YoutubeDL(ytdl_format_options)

# 用於獲取真正直接流網址的提取器 (不使用 flat 模式)
ytdl_full_options = {
    'format': 'bestaudio/best',
    'noplaylist': True,
    'quiet': True,
    'no_warnings': True,
}
ytdl_full = yt_dlp.YoutubeDL(ytdl_full_options)

class YTDLSource(discord.PCMVolumeTransformer):
    def __init__(self, source, *, data, volume=0.5):
        super().__init__(source, volume)
        self.data = data
        self.title = data.get('title')
        self.url = data.get('url')

    @classmethod
    async def from_url(cls, search: str, *, loop=None, stream=True):
        loop = loop or asyncio.get_event_loop()
        
        # 決定搜尋方式
        if not search.startswith(('http://', 'https://')):
            search = f"ytsearch1:{search}"
            
        data = await loop.run_in_executor(None, lambda: ytdl.extract_info(search, download=not stream))

        if 'entries' in data:
            # 取得所有條目 (如果是搜尋結果，則視為列表)
            entries = data['entries']
        else:
            entries = [data]

        return entries

    @staticmethod
    async def get_direct_url(target_url, loop):
        """獲取直接串流地址 (真正可播放的網址)"""
        # 使用不帶 extract_flat 的提取器
        data = await loop.run_in_executor(None, lambda: ytdl_full.extract_info(target_url, download=False))
        return data.get('url')

class MusicPlayer:
    def __init__(self, interaction: discord.Interaction):
        self.interaction = interaction
        self.queue = asyncio.Queue()
        self.next = asyncio.Event()
        self.current = None
        self.voice_client = interaction.guild.voice_client
        self.loop = interaction.client.loop
        self.player_task = self.loop.create_task(self.player_loop())

    async def player_loop(self):
        await self.interaction.client.wait_until_ready()

        while not self.interaction.client.is_closed():
            self.next.clear()

            try:
                # 等待下一首歌，如果 5 分鐘沒動靜就離開
                async with asyncio.timeout(300):
                    source_data = await self.queue.get()
            except (asyncio.TimeoutError, TimeoutError, asyncio.CancelledError):
                return self.destroy()

            try:
                # 播放前檢查是否還連接在語音頻道
                if not self.voice_client or not self.voice_client.is_connected():
                    break

                # 獲取真正的流地址
                url = source_data.get('url')
                # 如果是從 flat playlist 來的，可能沒有直接網址，或者網址仍指向 YouTube 頁面
                if not url or 'youtube.com' in url or 'youtu.be' in url:
                    target = source_data.get('webpage_url') or source_data.get('url')
                    url = await YTDLSource.get_direct_url(target, self.loop)

                if not url:
                    await self.interaction.channel.send(f"⚠️ 無法讀取歌曲: **{source_data.get('title', '未知')}**，跳過中。")
                    continue

                source = discord.FFmpegPCMAudio(url, **FFMPEG_OPTIONS)
                self.current = YTDLSource(source, data=source_data)

                self.voice_client.play(self.current, after=lambda _: self.loop.call_soon_threadsafe(self.next.set))
                
                embed = discord.Embed(
                    title="🎵 正在播放", 
                    description=f"**{self.current.title}**", 
                    color=discord.Color.blue()
                )
                if 'webpage_url' in source_data:
                    embed.url = source_data['webpage_url']
                
                await self.interaction.channel.send(embed=embed)
                await self.next.wait()
            except Exception as e:
                await self.interaction.channel.send(f"播放時發生錯誤: {e}")
            
            self.current = None

    def destroy(self):
        """徹底清理播放器"""
        # 確保從緩存中移除
        cog = self.interaction.client.get_cog('Music')
        if cog and self.interaction.guild_id in cog.players:
            del cog.players[self.interaction.guild_id]

        # 1. 先停止語音輸出，這會觸發 ffmpeg 進程的關閉
        if self.voice_client and (self.voice_client.is_playing() or self.voice_client.is_paused()):
            self.voice_client.stop()

        # 2. 取消播放循環任務
        if self.player_task and not self.player_task.done():
            self.player_task.cancel()
        
        # 3. 斷開語音連接
        if self.voice_client and self.voice_client.is_connected():
            return self.loop.create_task(self.voice_client.disconnect())

class Music(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.players = {}

    def get_player(self, interaction: discord.Interaction):
        if interaction.guild_id in self.players:
            return self.players[interaction.guild_id]

        player = MusicPlayer(interaction)
        self.players[interaction.guild_id] = player
        return player

    @app_commands.command(name="play", description="播放 YouTube 音樂 (支援網址、關鍵字、播放清單)")
    async def play(self, interaction: discord.Interaction, song: str):
        await interaction.response.defer()

        # 檢查用戶是否在語音頻道
        if not interaction.user.voice:
            return await interaction.followup.send("你必須先加入一個語音頻道！")

        # 連接語音頻道
        if not interaction.guild.voice_client:
            await interaction.user.voice.channel.connect()
        elif interaction.guild.voice_client.channel != interaction.user.voice.channel:
            return await interaction.followup.send("機器人已經在另一個頻道中播放了。")

        player = self.get_player(interaction)

        try:
            # 取得音樂資訊 (支援播放清單)
            sources = await YTDLSource.from_url(song, loop=self.bot.loop, stream=True)
            
            for source_data in sources:
                await player.queue.put(source_data)

            if len(sources) > 1:
                await interaction.followup.send(f"已加入播放清單：**{len(sources)}** 首音樂至隊列。")
            else:
                await interaction.followup.send(f"已加入隊列：**{sources[0]['title']}**")

        except Exception as e:
            await interaction.followup.send(f"播放時發生錯誤: {e}")

    @app_commands.command(name="skip", description="跳過當前歌曲")
    async def skip(self, interaction: discord.Interaction):
        if not interaction.guild.voice_client or not interaction.guild.voice_client.is_playing():
            return await interaction.response.send_message("目前沒有正在播放的音樂。")
        
        interaction.guild.voice_client.stop()
        await interaction.response.send_message("已跳過歌曲。")

    @app_commands.command(name="stop", description="停止播放並清空隊列")
    async def stop(self, interaction: discord.Interaction):
        if not interaction.guild.voice_client:
            return await interaction.response.send_message("機器人不在語音頻道中。")

        # 取得播放器並執行銷毀邏輯 (包含取消任務、清空、斷開連接)
        player = self.players.get(interaction.guild_id)
        if player:
            player.destroy()
        else:
            await interaction.guild.voice_client.disconnect()
        
        await interaction.response.send_message("已停止播放並離開頻道。")

    @app_commands.command(name="queue", description="查看當前待播放清單")
    async def queue_info(self, interaction: discord.Interaction):
        player = self.players.get(interaction.guild_id)
        if not player or player.queue.empty():
            return await interaction.response.send_message("目前隊列是空的。")

        upcoming = list(player.queue._queue)
        fmt = "\n".join([f"{i+1}. {item['title']}" for i, item in enumerate(upcoming[:10])])
        embed = discord.Embed(title=f"待播放清單 (前 {len(upcoming[:10])} 首)", description=fmt, color=discord.Color.green())
        await interaction.response.send_message(embed=embed)

async def setup(bot: commands.Bot):
    await bot.add_cog(Music(bot))
