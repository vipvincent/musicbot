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
                
                # 取得歌曲資訊
                title = self.current.title or '未知'
                author = source_data.get('uploader', '未知')
                url = source_data.get('webpage_url')
                # 饠覬：嚡控從 thumbnails 列表中加載，或直接從 thumbnail 字段中加載
                thumbnail = None
                if 'thumbnails' in source_data and source_data['thumbnails']:
                    thumbnail = source_data['thumbnails'][-1].get('url')
                if not thumbnail:
                    thumbnail = source_data.get('thumbnail')
                requester = self.interaction.user.mention
                voice_channel = self.interaction.user.voice.channel.name if self.interaction.user.voice else '未知'

                # 標題格式：標題 - 作者
                display_title = f"{title} - {author}" if author else title

                embed = discord.Embed(title="🎵 正在播放", color=discord.Color.blue())
                embed.description = display_title
                embed.url = url
                if thumbnail:
                    embed.set_thumbnail(url=thumbnail)
                embed.add_field(name=" ", value=f"{requester}  \u200b |  \uD83D\uDD0A {voice_channel}", inline=False)

                # 定義互動按鈕
                class NowPlayingView(discord.ui.View):
                    def __init__(self, music_cog, guild_id):
                        super().__init__(timeout=None)
                        self.music_cog = music_cog
                        self.guild_id = guild_id

                    @discord.ui.button(label="下一首", style=discord.ButtonStyle.primary, custom_id="music_skip")
                    async def skip_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                        try:
                            await interaction.response.defer(thinking=False)
                            if not interaction.guild.voice_client or not interaction.guild.voice_client.is_playing():
                                await interaction.channel.send("目前沒有正在播放的音樂。")
                                return
                            interaction.guild.voice_client.stop()
                            await interaction.channel.send("已跳過歌曲。")
                        except Exception as e:
                            print("[skip 按鈕錯誤]", e)

                    @discord.ui.button(label="列出播放清單", style=discord.ButtonStyle.secondary, custom_id="music_queue")
                    async def queue_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                        try:
                            await interaction.response.defer(thinking=False)
                            player = self.music_cog.players.get(self.guild_id)
                            if not player or player.queue.empty():
                                await interaction.channel.send("目前隊列是空的。")
                                return
                            upcoming = list(player.queue._queue)
                            per_page = 10
                            total = len(upcoming)
                            max_page = (total - 1) // per_page + 1
                            
                            # 定義分頁 View
                            class QueueView(discord.ui.View):
                                def __init__(self, queue_data, page, max_page):
                                    super().__init__(timeout=None)
                                    self.queue_data = queue_data
                                    self.current_page = page
                                    self.max_page = max_page
                                    self.update_buttons()
                                
                                def update_buttons(self):
                                    # 動態更新按鈕狀態
                                    if self.current_page <= 1:
                                        self.children[0].disabled = True
                                    else:
                                        self.children[0].disabled = False
                                    if self.current_page >= self.max_page:
                                        self.children[1].disabled = True
                                    else:
                                        self.children[1].disabled = False
                                
                                @discord.ui.button(label="⬅️ 上一頁", style=discord.ButtonStyle.secondary, custom_id="queue_prev")
                                async def prev_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                                    if self.current_page > 1:
                                        self.current_page -= 1
                                        self.update_buttons()
                                        await self.update_message(interaction)
                                
                                @discord.ui.button(label="下一頁 ➡️", style=discord.ButtonStyle.secondary, custom_id="queue_next")
                                async def next_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                                    if self.current_page < self.max_page:
                                        self.current_page += 1
                                        self.update_buttons()
                                        await self.update_message(interaction)
                                
                                async def update_message(self, interaction: discord.Interaction):
                                    try:
                                        await interaction.response.defer(thinking=False)
                                        per_page = 10
                                        start = (self.current_page - 1) * per_page
                                        end = start + per_page
                                        fmt = "\n".join([f"{i+1}. {item['title']}" for i, item in enumerate(self.queue_data[start:end], start=start)])
                                        embed = discord.Embed(title=f"待播放清單 (第 {self.current_page}/{self.max_page} 頁，共 {len(self.queue_data)} 首)", description=fmt, color=discord.Color.green())
                                        await interaction.edit_original_response(embed=embed, view=self)
                                    except Exception as e:
                                        print("[queue 分頁錯誤]", e)
                            
                            start = 0
                            end = min(per_page, total)
                            fmt = "\n".join([f"{i+1}. {item['title']}" for i, item in enumerate(upcoming[start:end], start=start)])
                            embed = discord.Embed(title=f"待播放清單 (第 1/{max_page} 頁，共 {total} 首)", description=fmt, color=discord.Color.green())
                            view = QueueView(upcoming, 1, max_page)
                            await interaction.channel.send(embed=embed, view=view)
                        except Exception as e:
                            print("[queue 按鈕錯誤]", e)

                    @discord.ui.button(label="清空", style=discord.ButtonStyle.danger, custom_id="music_clear")
                    async def clear_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                        try:
                            await interaction.response.defer(thinking=False)
                            player = self.music_cog.players.get(self.guild_id)
                            if not player or player.queue.empty():
                                await interaction.channel.send("播放清單已經是空的。")
                                return
                            while not player.queue.empty():
                                try:
                                    player.queue.get_nowait()
                                except Exception:
                                    break
                            await interaction.channel.send("已清空播放清單。")
                        except Exception as e:
                            print("[clear 按鈕錯誤]", e)

                    @discord.ui.button(label="離開", style=discord.ButtonStyle.danger, custom_id="music_leave")
                    async def leave_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                        try:
                            await interaction.response.defer(thinking=False)
                            if not interaction.guild.voice_client:
                                await interaction.channel.send("機器人不在語音頻道中。")
                                return
                            player = self.music_cog.players.get(self.guild_id)
                            if player:
                                player.destroy()
                            else:
                                await interaction.guild.voice_client.disconnect()
                            await interaction.channel.send("已離開語音頻道。")
                        except Exception as e:
                            print("[leave 按鈕錯誤]", e)

                # 取得 Music Cog 實例
                music_cog = self.interaction.client.get_cog('Music')
                view = NowPlayingView(music_cog, self.interaction.guild_id)
                await self.interaction.channel.send(embed=embed, view=view)
                await self.next.wait()
            except Exception as e:
                print("[播放時發生錯誤]", e)
                await self.interaction.channel.send("播放時發生錯誤，請稍後再試。")
            
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
    @app_commands.describe(song="請輸入網址、關鍵字或播放清單")
    async def play(self, interaction: discord.Interaction, song: str):
        try:
            await interaction.response.defer()
            if not interaction.user.voice:
                return await interaction.followup.send("你必須先加入一個語音頻道！")
            if not interaction.guild.voice_client:
                await interaction.user.voice.channel.connect()
            elif interaction.guild.voice_client.channel != interaction.user.voice.channel:
                return await interaction.followup.send("機器人已經在另一個頻道中播放了。")
            player = self.get_player(interaction)
            try:
                sources = await YTDLSource.from_url(song, loop=self.bot.loop, stream=True)
                for source_data in sources:
                    await player.queue.put(source_data)
                if len(sources) > 1:
                    await interaction.followup.send(f"已加入播放清單：**{len(sources)}** 首音樂至隊列。")
                else:
                    await interaction.followup.send(f"已加入隊列：**{sources[0]['title']}**")
            except Exception as e:
                print("[play 指令發生錯誤]", e)
                await interaction.followup.send("播放時發生錯誤，請稍後再試。")
        except Exception as e:
            print("[play 指令外層錯誤]", e)
            try:
                await interaction.followup.send("發生錯誤，請稍後再試。")
            except Exception:
                pass

    @app_commands.command(name="skip", description="跳過當前歌曲")
    async def skip(self, interaction: discord.Interaction):
        try:
            if not interaction.guild.voice_client or not interaction.guild.voice_client.is_playing():
                return await interaction.response.send_message("目前沒有正在播放的音樂。")
            interaction.guild.voice_client.stop()
            await interaction.response.send_message("已跳過歌曲。")
        except Exception as e:
            print("[skip 指令錯誤]", e)
            try:
                await interaction.response.send_message("發生錯誤，請稍後再試。")
            except Exception:
                pass

    @app_commands.command(name="stop", description="停止播放並清空隊列")
    async def stop(self, interaction: discord.Interaction):
        try:
            if not interaction.guild.voice_client:
                return await interaction.response.send_message("機器人不在語音頻道中。")
            player = self.players.get(interaction.guild_id)
            if player:
                player.destroy()
            else:
                await interaction.guild.voice_client.disconnect()
            await interaction.response.send_message("已停止播放並離開頻道。")
        except Exception as e:
            print("[stop 指令錯誤]", e)
            try:
                await interaction.response.send_message("發生錯誤，請稍後再試。")
            except Exception:
                pass


    @app_commands.command(name="queue", description="查看當前待播放清單（支援翻頁，每頁 10 首）")
    @app_commands.describe(page="要查看的頁數（預設第 1 頁）")
    async def queue_info(self, interaction: discord.Interaction, page: int = 1):
        try:
            player = self.players.get(interaction.guild_id)
            if not player or player.queue.empty():
                return await interaction.response.send_message("目前隊列是空的。")
            upcoming = list(player.queue._queue)
            per_page = 10
            total = len(upcoming)
            max_page = (total - 1) // per_page + 1
            if page < 1 or page > max_page:
                return await interaction.response.send_message(f"頁數超出範圍，請輸入 1 ~ {max_page} 之間的數字。")
            start = (page - 1) * per_page
            end = start + per_page
            fmt = "\n".join([f"{i+1}. {item['title']}" for i, item in enumerate(upcoming[start:end], start=start)])
            embed = discord.Embed(title=f"待播放清單 (第 {page}/{max_page} 頁，共 {total} 首)", description=fmt, color=discord.Color.green())
            await interaction.response.send_message(embed=embed)
        except Exception as e:
            print("[queue 指令錯誤]", e)
            try:
                await interaction.response.send_message("發生錯誤，請稍後再試。")
            except Exception:
                pass

    @app_commands.command(name="clear", description="清空播放清單（不離開語音頻道）")
    async def clear(self, interaction: discord.Interaction):
        try:
            player = self.players.get(interaction.guild_id)
            if not player or player.queue.empty():
                return await interaction.response.send_message("播放清單已經是空的。")
            while not player.queue.empty():
                try:
                    player.queue.get_nowait()
                except Exception:
                    break
            await interaction.response.send_message("已清空播放清單。")
        except Exception as e:
            print("[clear 指令錯誤]", e)
            try:
                await interaction.response.send_message("發生錯誤，請稍後再試。")
            except Exception:
                pass
    
    @app_commands.command(name="leave", description="離開語音頻道（等同 /stop）")
    async def leave(self, interaction: discord.Interaction):
        try:
            if not interaction.guild.voice_client:
                return await interaction.response.send_message("機器人不在語音頻道中。")
            player = self.players.get(interaction.guild_id)
            if player:
                player.destroy()
            else:
                await interaction.guild.voice_client.disconnect()
            await interaction.response.send_message("已離開語音頻道。")
        except Exception as e:
            print("[leave 指令錯誤]", e)
            try:
                await interaction.response.send_message("發生錯誤，請稍後再試。")
            except Exception:
                pass

async def setup(bot: commands.Bot):
    await bot.add_cog(Music(bot))
