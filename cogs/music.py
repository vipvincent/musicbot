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
FFMPEG_PATH = config["paths"]["ffmpeg"]
# 如果不是絕對路徑且包含目錄分隔符，則與 BASE_DIR 合併
if not os.path.isabs(FFMPEG_PATH) and ('/' in FFMPEG_PATH or '\\' in FFMPEG_PATH):
    FFMPEG_PATH = os.path.join(BASE_DIR, FFMPEG_PATH)

FFMPEG_OPTIONS = {
    'before_options': '-reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 -nostdin -analyzeduration 0 -probesize 32',
    'options': '-vn -ar 48000 -ac 2 -b:a 192k -threads 2 -loglevel panic',
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
    'source_address': '0.0.0.0',
    'nocheckcertificate': True,
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
                # 等待下一首歌，如果 30 分鐘沒動靜就離開
                async with asyncio.timeout(1800):
                    source_data = await self.queue.get()
            except (asyncio.TimeoutError, TimeoutError):
                # 超時離開的通知
                try:
                    await self.interaction.channel.send("⏰ 偵測到長時間未播放音樂，機器人已自動離開語音頻道。")
                except:
                    pass
                return self.destroy()
            except asyncio.CancelledError:
                return self.destroy()

            try:
                # 播放前檢查是否還連接在語音頻道
                if not self.voice_client or not self.voice_client.is_connected():
                    break

                # 獲取真正的流地址
                url = source_data.get('url')
                # 如果是從 flat playlist 來的，或者指向 YouTube 網址
                if not url or 'youtube.com' in url or 'youtu.be' in url or not url.startswith('http'):
                    target = source_data.get('webpage_url') or source_data.get('url')
                    # 如果 target 看起來只是 ID，重建完整網址以提升識別率
                    if target and not target.startswith('http'):
                        target = f"https://www.youtube.com/watch?v={target}"
                    url = await YTDLSource.get_direct_url(target, self.loop)

                if not url:
                    await self.interaction.channel.send(f"⚠️ 無法讀取歌曲: **{source_data.get('title', '未知')}**，跳過中。")
                    continue

                source = discord.FFmpegPCMAudio(url, **FFMPEG_OPTIONS)
                self.current = YTDLSource(source, data=source_data)

                self.voice_client.play(self.current, after=lambda _: self.loop.call_soon_threadsafe(self.next.set))
                                
                # [Bug Fix] 使用 try-except 包裹訊息發送，防止發送失敗導致 current_task 被取消而跳過音樂
                try:
                    music_cog = self.interaction.client.get_cog('Music')
                    if music_cog:
                        await music_cog.nowplaying_logic(self.interaction, source_data=source_data, current=self.current, incoming_player=self, silent=True)
                except Exception as msg_e:
                    print(f"[正在播放訊息發送失敗 (不影響播放)]: {msg_e}")
                
                await self.next.wait()

                # 定義互動按鈕
                # 移除原有的 View 定義，稍後移動到 Music 類別中
                pass
            except Exception as e:
                print("[播放時發生錯誤]", e)
                await self.interaction.channel.send(":x: 播放時發生錯誤，請稍後再試。")
            
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

    async def connect_voice(self, interaction: discord.Interaction, allow_move: bool = False):
        """輔助方法：處理語音頻道連接與移動邏輯"""
        if not interaction.user.voice:
            return False, ":x: 你必須先加入一個語音頻道！"
        
        channel = interaction.user.voice.channel
        if not interaction.guild.voice_client:
            await channel.connect()
            return True, f":sound: 已加入語音頻道：**{channel.name}**"
        
        if interaction.guild.voice_client.channel == channel:
            return True, None
        
        if allow_move:
            await interaction.guild.voice_client.move_to(channel)
            return True, f":sound: 已移動至語音頻道：**{channel.name}**"
        else:
            return False, ":x: 機器人已經在另一個頻道中播放了。"

    # --- 邏輯處理方法 (Logic Methods) ---

    def get_player(self, interaction: discord.Interaction):
        if interaction.guild_id in self.players:
            return self.players[interaction.guild_id]
        player = MusicPlayer(interaction)
        self.players[interaction.guild_id] = player
        return player

    async def safe_send_message(self, interaction: discord.Interaction, content: str = None, embed: discord.Embed = None, view: discord.ui.View = None, ephemeral: bool = False):
        """安全地發送訊息：優先嘗試使用 Interaction，失效則用 Channel 並清除 Thinking 狀態"""
        kwargs = {}
        if content is not None: kwargs['content'] = content
        if embed is not None: kwargs['embed'] = embed
        if view is not None: kwargs['view'] = view
        
        try:
            if not interaction.response.is_done():
                # 還沒回應過，直接回應
                await interaction.response.send_message(ephemeral=ephemeral, **kwargs)
            else:
                # 已經回應過或是已 Defer，優先使用 followup
                try:
                    await interaction.followup.send(ephemeral=ephemeral, **kwargs)
                except:
                    # 如果 followup 失敗，可能是因為第一次 defer 後要用 edit
                    await interaction.edit_original_response(**kwargs)
        except Exception as e:
            print(f"[safe_send_message 失敗，改用 channel.send]: {e}")
            # 全部 Interaction 方式都失敗
            try:
                await interaction.channel.send(**kwargs)
            except: pass
            
            # 關鍵：若 Interaction 已 Defer 但沒能成功結束，氣泡會卡住
            # 嘗試手動刪除思考中氣泡 (即便 token 可能無效，試著清掉)
            try:
                if interaction.response.is_done():
                    await interaction.delete_original_response()
            except: pass

    async def join_logic(self, interaction: discord.Interaction, silent_if_inside: bool = False):
        """處理加入頻道訊息邏輯 (非回覆型式)"""
        try:
            success, message = await self.connect_voice(interaction, allow_move=True)
            if not success:
                # 如果連接失敗，直接發送錯誤訊息
                await self.safe_send_message(interaction, content=message, ephemeral=True)
                return False
            
            # 成功加入或移動時，給予回饋
            if message:
                await self.safe_send_message(interaction, content=message, ephemeral=False)
            elif not silent_if_inside:
                # 已在頻道中且非靜默模式，提示用戶
                msg = ":x: 機器人已經在此頻道中了。"
                await self.safe_send_message(interaction, content=msg, ephemeral=True)
            
            return True
        except Exception as e:
            print("[join_logic 錯誤]", e)
            return False

    async def play_logic(self, interaction: discord.Interaction, song: str):
        try:
            # 立即 Defer 以顯示正在思考
            if not interaction.response.is_done():
                try: await interaction.response.defer(ephemeral=False)
                except: pass

            # 1. 透過 join_logic 處理所有加入邏輯 (Silent if inside)
            success = await self.join_logic(interaction, silent_if_inside=True)
            if not success:
                return

            player = self.get_player(interaction)
            
            try:
                # 解析音樂網址 (此操作較耗時)
                sources = list(await YTDLSource.from_url(song, loop=self.bot.loop, stream=True))
                
                if not sources:
                    return await self.safe_send_message(interaction, content=f":x: 找不到任何與 **{song}** 相關的結果。", ephemeral=True)

                for source_data in sources:
                    source_data['requester_mention'] = interaction.user.mention
                    await player.queue.put(source_data)
                
                # 準備音樂加入隊列的訊息
                if len(sources) > 1:
                    queue_info = f":white_check_mark: 已加入播放清單：**{len(sources)}** 首音樂至隊列。"
                else:
                    queue_info = f":white_check_mark: 已加入隊列：**{sources[0].get('title', '未知')}**"
                
                # 送出加入隊列訊息
                await self.safe_send_message(interaction, content=queue_info)
            except Exception as e:
                print("[play_logic 內部錯誤]", e)
                await self.safe_send_message(interaction, content=":x: 播放時發生錯誤，請稍後再試。", ephemeral=True)
        except Exception as e:
            print("[play_logic 外層錯誤]", e)
            await self.safe_send_message(interaction, content=":x: 發生預期外的錯誤。", ephemeral=True)

    async def skip_logic(self, interaction: discord.Interaction):
        try:
            if not interaction.guild.voice_client or not (interaction.guild.voice_client.is_playing() or interaction.guild.voice_client.is_paused()):
                return await self.safe_send_message(interaction, content=":x: 目前沒有正在播放的音樂。", ephemeral=True)
            
            player = self.players.get(interaction.guild_id)
            title = player.current.title if player and player.current else "未知歌曲"
            
            # [Fix] 先發送「已跳過」訊息，避免後續播放下一首時訊息順序顛倒
            msg = f":track_next: 已跳過 **{title}** 歌曲。"
            await self.safe_send_message(interaction, content=msg, ephemeral=False)
            
            # 發送完畢後才停掉當前播放，這會觸發 player_loop 進入下一首
            interaction.guild.voice_client.stop()
            
        except Exception as e:
            print("[skip_logic 錯誤]", e)
            await self.safe_send_message(interaction, content=":x: 發生錯誤，請稍後再試。", ephemeral=True)

    async def stop_logic(self, interaction: discord.Interaction, message: str = ":wave: 已停止播放並離開頻道。"):
        try:
            if not interaction.guild.voice_client:
                return await self.safe_send_message(interaction, content=":x: 機器人不在語音頻道中。", ephemeral=True)
            player = self.players.get(interaction.guild_id)
            if player:
                player.destroy()
            else:
                await interaction.guild.voice_client.disconnect()
            
            await self.safe_send_message(interaction, content=message, ephemeral=False)
        except Exception as e:
            print("[stop_logic 錯誤]", e)
            await self.safe_send_message(interaction, content=":x: 發生錯誤，請稍後再試。", ephemeral=True)

    async def clear_logic(self, interaction: discord.Interaction):
        try:
            player = self.players.get(interaction.guild_id)
            if not player or player.queue.empty():
                return await self.safe_send_message(interaction, content=":x: 播放清單已經是空的。", ephemeral=True)
            while not player.queue.empty():
                try:
                    player.queue.get_nowait()
                except: break
            
            msg = ":white_check_mark: 已清空播放清單。"
            await self.safe_send_message(interaction, content=msg, ephemeral=False)
        except Exception as e:
            print("[clear_logic 錯誤]", e)
            await self.safe_send_message(interaction, content=":x: 發生錯誤，請稍後再試。", ephemeral=True)

    async def nowplaying_logic(self, interaction: discord.Interaction, source_data=None, current=None, incoming_player=None, silent=False):
        """處理正在播放的 Embed 和 View 生成，供 play 和 nowplaying 指令共用 (silent 為 True 可避免通知)"""
        try:
            player = incoming_player or self.players.get(interaction.guild_id)
            if not player or (not current and not player.current):
                return await self.safe_send_message(interaction, content=":x: 目前沒有正在播放的音樂。", ephemeral=True)

            curr = current or player.current
            data = source_data or curr.data
            
            title = curr.title or '未知'
            author = data.get('uploader', '未知')
            target_url = data.get('webpage_url') or data.get('url')
            
            thumbnail = None
            if 'thumbnails' in data and data['thumbnails']:
                thumbnail = data['thumbnails'][-1].get('url')
            if not thumbnail:
                thumbnail = data.get('thumbnail')
                
            # 優先使用紀錄的點歌者
            requester = data.get('requester_mention') or interaction.user.mention
            voice_channel = interaction.guild.voice_client.channel.mention if interaction.guild.voice_client else '未知'

            embed = discord.Embed(title=":musical_note:  正在播放", color=discord.Color.blue())
            embed.description = f"**[{title}]({target_url})**\n{author}" if author else f"**[{title}]({target_url})**"
            if thumbnail:
                embed.set_thumbnail(url=thumbnail)
            embed.add_field(name=" ", value=f"{requester} | {voice_channel}", inline=False)

            # 定義動態按鈕 View (移至此處以共用)
            class NowPlayingView(discord.ui.View):
                def __init__(self, music_cog, guild_id):
                    super().__init__(timeout=None)
                    self.music_cog = music_cog
                    self.guild_id = guild_id

                @discord.ui.button(label="下一首", emoji="⏭️", style=discord.ButtonStyle.primary, custom_id="music_skip")
                async def skip_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                    await self.music_cog.skip_logic(interaction)

                @discord.ui.button(label="播放清單", emoji="📜", style=discord.ButtonStyle.secondary, custom_id="music_queue")
                async def queue_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                    await self.music_cog.queue_logic(interaction)

                @discord.ui.button(label="清空", emoji="🗑️", style=discord.ButtonStyle.danger, custom_id="music_clear")
                async def clear_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                    await self.music_cog.clear_logic(interaction)

                @discord.ui.button(label="離開", emoji="🚪", style=discord.ButtonStyle.danger, custom_id="music_leave")
                async def leave_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                    await self.music_cog.stop_logic(interaction, message=":wave: 已離開語音頻道。")

            view = NowPlayingView(self, interaction.guild_id)
            
            # 當 silent=True 時（player_loop 調用），發送訊息但不觸發通知
            if silent:
                await interaction.channel.send(embed=embed, view=view, silent=True)
            else:
                # 若是由指令調用且未 Defer，先進行 Defer
                if not interaction.response.is_done():
                    await interaction.response.defer(ephemeral=False)
                await self.safe_send_message(interaction, embed=embed, view=view)
        except Exception as e:
            print("[nowplaying_logic 錯誤]", e)
            await self.safe_send_message(interaction, content=":x: 無法取得播放資訊。", ephemeral=True)

    async def queue_logic(self, interaction: discord.Interaction, page: int = 1):
        try:
            player = self.players.get(interaction.guild_id)
            if not player or player.queue.empty():
                if interaction.response.is_done():
                    return await interaction.followup.send(msg, ephemeral=True)
                else:
                    return await interaction.response.send_message(msg, ephemeral=True)
            
            upcoming = list(player.queue._queue)
            per_page = 10
            total = len(upcoming)
            max_page = (total - 1) // per_page + 1
            
            if page < 1 or page > max_page:
                return await interaction.response.send_message(f":x: 頁數超出範圍，請輸入 1 ~ {max_page} 之間的數字。", ephemeral=True)
            
            # 定義分頁 View (已加入 Emoji 和清空按鈕)
            class QueueView(discord.ui.View):
                def __init__(self, queue_data, page, max_page, music_cog):
                    super().__init__(timeout=None)
                    self.queue_data = queue_data
                    self.current_page = page
                    self.max_page = max_page
                    self.music_cog = music_cog
                    self.update_buttons()
                
                def update_buttons(self):
                    self.children[0].disabled = (self.current_page <= 1)
                    self.children[1].disabled = (self.current_page >= self.max_page)
                
                @discord.ui.button(label="上一頁", emoji="⬅️", style=discord.ButtonStyle.secondary)
                async def prev_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                    self.current_page -= 1
                    self.update_buttons()
                    await self.update_message(interaction)
                
                @discord.ui.button(label="下一頁", emoji="➡️", style=discord.ButtonStyle.secondary)
                async def next_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                    self.current_page += 1
                    self.update_buttons()
                    await self.update_message(interaction)

                @discord.ui.button(label="清空", emoji="🗑️", style=discord.ButtonStyle.danger)
                async def clear_button(self, interaction: discord.Interaction, button: discord.ui.Button):
                    await self.music_cog.clear_logic(interaction)
                
                async def update_message(self, interaction: discord.Interaction):
                    await interaction.response.defer()
                    per_page = 10
                    start = (self.current_page - 1) * per_page
                    end = start + per_page
                    fmt = "\n".join([f"{i+1}. {item.get('title', '未知')}" for i, item in enumerate(self.queue_data[start:end], start=start)])
                    embed = discord.Embed(title=f"待播放清單 (第 {self.current_page}/{self.max_page} 頁，共 {len(self.queue_data)} 首)", description=fmt, color=discord.Color.green())
                    await interaction.edit_original_response(embed=embed, view=self)

            start = (page - 1) * per_page
            end = start + per_page
            fmt = "\n".join([f"{i+1}. {item.get('title', '未知')}" for i, item in enumerate(upcoming[start:end], start=start)])
            embed = discord.Embed(title=f":scroll: 待播放清單 (第 {page}/{max_page} 頁，共 {total} 首)", description=fmt, color=discord.Color.green())
            
            view = QueueView(upcoming, page, max_page, self)
            if not interaction.response.is_done():
                await interaction.response.send_message(embed=embed, view=view, ephemeral=False)
            else:
                await interaction.followup.send(embed=embed, view=view, ephemeral=False)
        except Exception as e:
            print("[queue_logic 錯誤]", e)
            if not interaction.response.is_done():
                await interaction.response.send_message(":x: 發生錯誤，請稍後再試。", ephemeral=True)

    # --- 斜線指令宣言 (Slash Commands) ---

    @app_commands.command(name="join", description="讓機器人加入您目前的語音頻道")
    async def join(self, interaction: discord.Interaction):
        await self.join_logic(interaction)

    @app_commands.command(name="play", description="播放 YouTube 音樂 (支援網址、關鍵字、播放清單)")
    @app_commands.describe(song="請輸入網址、關鍵字或播放清單")
    async def play(self, interaction: discord.Interaction, song: str):
        await self.play_logic(interaction, song)

    @app_commands.command(name="skip", description="跳過當前歌曲")
    async def skip(self, interaction: discord.Interaction):
        await self.skip_logic(interaction)

    @app_commands.command(name="next", description="跳過當前歌曲")
    async def next_song(self, interaction: discord.Interaction):
        await self.skip_logic(interaction)

    @app_commands.command(name="stop", description="停止播放並清空隊列")
    async def stop(self, interaction: discord.Interaction):
        await self.stop_logic(interaction)

    @app_commands.command(name="leave", description="離開語音頻道")
    async def leave(self, interaction: discord.Interaction):
        await self.stop_logic(interaction)

    @app_commands.command(name="queue", description="查看當前待播放清單")
    @app_commands.describe(page="要查看的頁數")
    async def queue_info(self, interaction: discord.Interaction, page: int = 1):
        await self.queue_logic(interaction, page)

    @app_commands.command(name="playlist", description="查看當前待播放清單")
    @app_commands.describe(page="要查看的頁數")
    async def playlist(self, interaction: discord.Interaction, page: int = 1):
        await self.queue_logic(interaction, page)

    @app_commands.command(name="clear", description="清空播放清單")
    async def clear(self, interaction: discord.Interaction):
        await self.clear_logic(interaction)

    @app_commands.command(name="nowplaying", description="查看目前正在播放的歌曲資訊")
    async def nowplaying(self, interaction: discord.Interaction):
        await self.nowplaying_logic(interaction)

async def setup(bot: commands.Bot):
    await bot.add_cog(Music(bot))
