import discord
from discord import app_commands
from discord.ext import commands
import asyncio
from dotenv import load_dotenv
import os
import yt_dlp
import concurrent.futures

# 載入 .env 檔案
load_dotenv()

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG_PATH = os.getenv("FFMPEG_PATH")
# 如果不是絕對路徑且包含目錄分隔符，則與 BASE_DIR 合併
if FFMPEG_PATH and not os.path.isabs(FFMPEG_PATH) and ('/' in FFMPEG_PATH or '\\' in FFMPEG_PATH):
    FFMPEG_PATH = os.path.join(BASE_DIR, FFMPEG_PATH)

FFMPEG_OPTIONS = {
    'before_options': '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -nostdin',
    'options': '-vn',
    'executable': FFMPEG_PATH or 'ffmpeg'
}


# 核心 YTDL 共用設定
BASE_YTDL_OPTIONS = {
    'format': 'bestaudio/best',
    'quiet': True,
    'no_warnings': True,
    'source_address': '0.0.0.0',
    'default_search': 'auto',
    'js_runtimes': ['deno', 'node']
}

# 用於初步獲取資訊的選項 (預設支援播放清單快速獲取)
ytdl_format_options = BASE_YTDL_OPTIONS.copy()
ytdl_format_options.update({
    'noplaylist': False,
    'extract_flat': 'in_playlist',
})

# 用於獲取真正直接流網址的提取器 (不使用 flat 模式)
ytdl_full_options = BASE_YTDL_OPTIONS.copy()
ytdl_full_options.update({
    'noplaylist': True,
})

def _extract_info_in_process(query, download=False, options=None):
    """
    在獨立執行緒中運行的解析函數。
    """
    if options is None:
        options = ytdl_format_options.copy()
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            return ydl.extract_info(query, download=download)
    except Exception as e:
        # 捕捉異常並返回一個包含錯誤訊息的字典，交由主程式處理
        return {"_error": str(e)}

class YTDLSource(discord.AudioSource):
    def __init__(self, source, *, data):
        self.source = source
        self.data = data
        self.title = data.get('title')
        self.url = data.get('url')

    def read(self):
        return self.source.read()

    def cleanup(self):
        try:
            self.source.cleanup()
        except Exception as e:
            print(f"[YTDLSource 清理錯誤]: {e}")

    @classmethod
    async def from_url(cls, search: str, *, loop=None, executor=None, stream=True):
        loop = loop or asyncio.get_running_loop()
        
        if not search.startswith(('http://', 'https://')):
            search = f"ytsearch1:{search}"
            
        # 以基礎選項為底本
        parse_options = BASE_YTDL_OPTIONS.copy()
        parse_options['noplaylist'] = False
        
        # [Bug Fix] 播放清單使用 extract_flat 快速取得目錄；單曲/搜尋則完整解析以取得標題
        if 'list=' in search:
            parse_options['extract_flat'] = 'in_playlist'

        try:
            # 使用傳入的持久化 executor，如果沒有則按需建立 (後備方案)
            if executor:
                data = await loop.run_in_executor(
                    executor, 
                    _extract_info_in_process, 
                    search, 
                    not stream, 
                    parse_options
                )
            else:
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as new_executor:
                    data = await loop.run_in_executor(
                        new_executor, 
                        _extract_info_in_process, 
                        search, 
                        not stream, 
                        parse_options
                    )
        except Exception as e:
            print(f"[進程解析錯誤]: {e}")
            return []

        if not data:
            return []

        if isinstance(data, dict) and '_error' in data:
            # 拋出異常，讓 play_logic 的 except 區塊去處理錯誤訊息發送
            raise Exception(data['_error'])

        if 'entries' in data:
            entries = data['entries']
        else:
            entries = [data]

        return entries

    @staticmethod
    async def get_direct_url(target_url, loop, executor=None):
        """獲取直接串流地址 (真正可播放的網址)"""
        if not target_url:
            return None
        
        try:
            if executor:
                data = await loop.run_in_executor(
                    executor, 
                    _extract_info_in_process, 
                    target_url, 
                    False, 
                    ytdl_full_options
                )
            else:
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as new_executor:
                    data = await loop.run_in_executor(
                        new_executor, 
                        _extract_info_in_process, 
                        target_url, 
                        False, 
                        ytdl_full_options
                    )
            # [Bug Fix] 這個判斷與回傳必須放在 if/else 外面，否則有 executor 時會回傳 None
            if not data:
                print(f"[獲取直接 URL 失敗]: 拿不到任何資料 (target: {target_url})")
                return None
            if isinstance(data, dict) and '_error' in data:
                print(f"[獲取直接 URL youtube-dl 錯誤]: {data['_error']} (target: {target_url})")
                return None
            
            url = data.get('url')
            if not url:
                print(f"[獲取直接 URL 失敗]: 資料中沒有包含 url 欄位! (target: {target_url})")
            return url
        except Exception as e:
            print(f"[獲取直接 URL 呼叫異常]: {e}")
            return None

class MusicPlayer:
    def __init__(self, interaction: discord.Interaction, executor):
        self.interaction = interaction
        self.executor = executor
        self.queue = asyncio.Queue()
        self.next = asyncio.Event()
        self.current = None
        self.voice_client = interaction.guild.voice_client
        self.loop = interaction.client.loop
        self._destroying = False # 新增：防止重複執行 destroy
        self.player_task = self.loop.create_task(self.player_loop())

    async def player_loop(self):
        await self.interaction.client.wait_until_ready()

        while not self.interaction.client.is_closed():
            # [Bug Fix] 每次迴圈重新建立 Event，避免舊歌的 delayed callback 污染新歌的狀態
            self.next = asyncio.Event()

            try:
                # 等待下一首歌，如果 5 分鐘沒動靜就離開
                async with asyncio.timeout(300):
                    source_data = await self.queue.get()
            except (asyncio.TimeoutError, TimeoutError):
                # 超時離開的通知
                try:
                    await self.interaction.channel.send("⏰ 偵測到長時間未播放音樂，機器人已自動離開語音頻道。")
                except:
                    pass
                return self.destroy()

            try:
                # 播放前檢查是否還連接在語音頻道
                if not self.voice_client or not self.voice_client.is_connected():
                    break

                # 獲取播放資訊中的網址
                url = source_data.get('url')
                # 如果網址無效、或是來自 YouTube (通常需要新鮮的串流網址)
                if not url or any(x in url for x in ['youtube.com', 'youtu.be', 'googlevideo.com']) or not str(url).startswith('http'):
                    target = source_data.get('webpage_url') or source_data.get('url')
                    # 如果 target 看起來只是 ID，重建完整網址以提升識別率
                    if target and not str(target).startswith('http'):
                        target = f"https://www.youtube.com/watch?v={target}"
                    
                    # 獲取新鮮的 stream URL (加入重試機制抵抗偶發的 YouTube 限制)
                    url = None
                    if target:
                        for _ in range(2):
                            url = await YTDLSource.get_direct_url(target, self.loop, self.executor)
                            if url:
                                break
                            await asyncio.sleep(1.5)

                if not url:
                    await self.interaction.channel.send(f":x: 哎呀，我拿不到 **{source_data.get('title', '未知')}** 的播放資訊耶，這首可能要先跳過囉！")
                    continue

                # 使用 FFmpegPCMAudio，PCM 會交由 discord.py 的語音客戶端這端處理，播放會更加穩定順暢。
                source = discord.FFmpegPCMAudio(url, **FFMPEG_OPTIONS)
                self.current = YTDLSource(source, data=source_data)

                # [Bug Fix] 明確綁定當前的 Event 到 lambda 中，防止競爭條件導致「連跳兩首」
                current_event = self.next
                self.voice_client.play(self.current, after=lambda _, e=current_event: self.loop.call_soon_threadsafe(e.set))
                                
                # [Bug Fix] 使用 try-except 包裹訊息發送，防止發送失敗導致 current_task 被取消而跳過音樂
                try:
                    music_cog = self.interaction.client.get_cog('Music')
                    if music_cog:
                        await music_cog.nowplaying_logic(self.interaction, source_data=source_data, current=self.current, incoming_player=self, silent=True)
                except Exception as msg_e:
                    print(f"[正在播放訊息發送失敗 (不影響播放)]: {msg_e}")

                # [Bug Fix] 每 5 秒檢查一次播放狀態的循環保護
                while True:
                    try:
                        await asyncio.wait_for(current_event.wait(), timeout=5.0)
                        break
                    except (asyncio.TimeoutError, asyncio.exceptions.TimeoutError):
                        if not self.voice_client.is_playing() and not self.voice_client.is_paused():
                            break
            except Exception as e:
                print("[播放時發生錯誤]", e)
                await self.interaction.channel.send(":x: 嗚嗚，我拿不到這首歌的播放資訊耶，暫時沒辦法唱給你聽喔！")
            
            self.current = None

        # [Bug Fix] 迴圈正常結束後（例如外部斷線），也要執行銷毀以清理字典中的 self
        self.destroy()

    def destroy(self):
        """徹底清理播放器"""
        if self._destroying:
            return
        self._destroying = True
        # 確保從緩存中移除
        cog = self.interaction.client.get_cog('Music')
        if cog and self.interaction.guild_id in cog.players:
            del cog.players[self.interaction.guild_id]

        # 1. 先從源頭清理音訊流與 FFmpeg 進程
        try:
            if self.voice_client and self.voice_client.source:
                # 明確呼叫 YTDLSource 的 cleanup，進而關閉 FFmpeg
                self.voice_client.source.cleanup()
        except:
            pass

        # 2. 停止語音輸出
        if self.voice_client and (self.voice_client.is_playing() or self.voice_client.is_paused()):
            try:
                self.voice_client.stop()
            except:
                pass

        # 3. 取消播放循環任務
        if self.player_task and not self.player_task.done():
            self.player_task.cancel()
        
        # 4. 斷開語音連接
        if self.voice_client and self.voice_client.is_connected():
            return self.loop.create_task(self.voice_client.disconnect())

class NowPlayingView(discord.ui.View):
    def __init__(self, music_cog):
        super().__init__(timeout=None)
        self.music_cog = music_cog

    @discord.ui.button(label="下一首", emoji="⏭️", style=discord.ButtonStyle.primary, custom_id="music_skip")
    async def skip_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.music_cog.skip_logic(interaction)

    @discord.ui.button(label="待播清單", emoji="📜", style=discord.ButtonStyle.secondary, custom_id="music_queue")
    async def queue_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.music_cog.queue_logic(interaction)

    @discord.ui.button(label="清空", emoji="🗑️", style=discord.ButtonStyle.danger, custom_id="music_clear")
    async def clear_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.music_cog.clear_logic(interaction)

    @discord.ui.button(label="離開", emoji="🚪", style=discord.ButtonStyle.danger, custom_id="music_leave")
    async def leave_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.music_cog.stop_logic(interaction, message=f":wave: `{interaction.user.display_name}` 按下了離開，我先退下囉！")

class Music(commands.Cog):

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.players = {}
        # 改用 ThreadPoolExecutor 避免 ProcessPool 崩潰導致的連鎖失效 (跳歌 Bug 根本原因)
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        # 註冊持久化按鈕，即使機器人重啟，舊的正在播放按鈕依然能作用
        self.bot.add_view(NowPlayingView(self))

    async def connect_voice(self, interaction: discord.Interaction, allow_move: bool = False):
        """輔助方法：處理語音頻道連接與移動邏輯"""
        if not interaction.user.voice:
            return False, f":x: 你要先進入一個語音頻道，我才能過去找你呀！"
        
        channel = interaction.user.voice.channel
        if not interaction.guild.voice_client:
            await channel.connect()
            return True, f":sound: `{interaction.user.display_name}` 呼叫我啦！已抵達保護區：**{channel.name}**"
        
        if interaction.guild.voice_client.channel == channel:
            return True, None
        
        if allow_move:
            await interaction.guild.voice_client.move_to(channel)
            return True, f":sound: `{interaction.user.display_name}` 把我拉過來囉！已移動至：**{channel.name}**"
        else:
            return False, f":x: 不好意思，我已經在 **{interaction.guild.voice_client.channel.name}** 當 DJ 囉！"

    # --- 邏輯處理方法 (Logic Methods) ---

    def get_player(self, interaction: discord.Interaction):
        player = self.players.get(interaction.guild_id)
        
        # [Bug Fix] 若播放器已存在，需更新其語音客端參考，並檢查任務是否已死
        if player:
            player.voice_client = interaction.guild.voice_client
            if not player.player_task.done():
                return player
            # 若任務已結束，則執行清理並重新建立
            player.destroy()

        player = MusicPlayer(interaction, self.executor)
        self.players[interaction.guild_id] = player
        return player



    async def join_logic(self, interaction: discord.Interaction, silent_if_inside: bool = False):
        """處理加入頻道訊息邏輯 (非回覆型式)"""
        try:
            success, message = await self.connect_voice(interaction, allow_move=True)
            if not success:
                # 如果連接失敗，直接發送錯誤訊息
                await interaction.response.send_message(content=message)
                return False
            
            # 成功加入或移動時，給予回饋
            if message:
                await interaction.response.send_message(content=message)
            elif not silent_if_inside:
                # 已在頻道中且非靜默模式，提示用戶
                msg = ":x: 哎呀，我早就在這個頻道裡面等你囉！"
                await interaction.response.send_message(content=msg)
            
            return True
        except Exception as e:
            print("[join_logic 錯誤]", e)
            return False

    async def play_logic(self, interaction: discord.Interaction, song: str):
        search_message = None
        try:
            # 立即 Defer 以顯示正在思考
            if not interaction.response.is_done():
                try:
                    await interaction.response.defer(ephemeral=False)
                except:
                    pass

            # 處理加入語音頻道，play 預設不強制幫用戶把機器人從其他頻道拉過來，避免干擾別人
            success, join_message = await self.connect_voice(interaction, allow_move=False)
            if not success:
                await interaction.followup.send(content=join_message)
                return

            # 顯示搜尋提示（統一流程）
            try:
                if join_message:
                    # 新加入頻道：先顯示加入訊息，再另外發送搜尋提示
                    await interaction.edit_original_response(content=join_message)
                    search_message = await interaction.followup.send(
                        content=":mag_right: 正在搜尋音樂中...", ephemeral=False
                    )
                else:
                    # 已在頻道：直接把思考泡泡改成搜尋提示
                    search_message = await interaction.edit_original_response(
                        content=":mag_right: 正在搜尋音樂中..."
                    )
            except:
                search_message = None

            player = self.get_player(interaction)
            # 解析音樂網址 (使用常駐進程池提升速度)
            sources = list(await YTDLSource.from_url(song, loop=self.bot.loop, executor=self.executor, stream=True))

            # [Bug Fix] 過濾掉播放清單中的無效項目（被刪除或私人影片會是 None）
            sources = [s for s in sources if s is not None]

            if not sources:
                await self._update_search_message(interaction, search_message,
                    f":x: 抱歉，我翻遍了也找不到跟 `{song}` 相關的音樂耶...")
                return

            for source_data in sources:
                source_data['requester_mention'] = interaction.user.mention
                await player.queue.put(source_data)

            # 準備結果訊息
            if len(sources) > 1:
                queue_info = f":white_check_mark: `{interaction.user.display_name}` 一口氣點了 **{len(sources)}** 首音樂，已經通通塞進清單啦！"
            else:
                queue_info = f":white_check_mark: `{interaction.user.display_name}` 點的 **{sources[0].get('title', '未知')}** 已經加入隊列排隊囉！"

            await self._update_search_message(interaction, search_message, queue_info)

        except Exception as e:
            error_msg = ":x: 嗚嗚，這個平台因為版權保護不支援喔。" if "DRM" in str(e) else ":x: 糟糕，解析這首歌的資訊時出了點差錯，我可能沒辦法播放它喔！"
            await self._update_search_message(interaction, search_message, error_msg)

    async def _update_search_message(self, interaction, search_message, content):
        """統一處理搜尋訊息的更新"""
        try:
            if search_message:
                await search_message.edit(content=content)
            else:
                await interaction.followup.send(content=content)
        except:
            await interaction.channel.send(content=content)

    async def skip_logic(self, interaction: discord.Interaction):
        try:
            if not interaction.guild.voice_client or not (interaction.guild.voice_client.is_playing() or interaction.guild.voice_client.is_paused()):
                return await interaction.response.send_message(content=":x: 現在很安靜唷，沒有音樂可以跳過啦！")
            
            player = self.players.get(interaction.guild_id)
            title = player.current.title if player and player.current else "未知歌曲"
            
            # [Fix] 先發送「已跳過」訊息，避免後續播放下一首時訊息順序顛倒
            msg = f":track_next: `{interaction.user.display_name}` 卡歌啦！已幫您跳過 **{title}**。"
            await interaction.response.send_message(content=msg)
            
            # 發送完畢後才停掉當前播放，這會觸發 player_loop 進入下一首
            interaction.guild.voice_client.stop()
            
        except Exception as e:
            print("[skip_logic 錯誤]", e)
            try:
                await interaction.response.send_message(content=":x: 發生一點錯誤，請再試一次看看！")
            except:
                pass

    async def stop_logic(self, interaction: discord.Interaction, message: str = None):
        if not message:
            message = f":wave: `{interaction.user.display_name}` 讓我先退下了，停止播放並退出頻道囉！"
        try:
            if not interaction.guild.voice_client:
                return await interaction.response.send_message(content=":x: 我現在不在頻道裡喔！")
            player = self.players.get(interaction.guild_id)
            if player:
                player.destroy()
            else:
                await interaction.guild.voice_client.disconnect()
            
            await interaction.response.send_message(content=message)
        except Exception as e:
            print("[stop_logic 錯誤]", e)
            try:
                await interaction.response.send_message(content=":x: 發生一點錯誤，請再試一次看看！")
            except:
                pass

    async def clear_logic(self, interaction: discord.Interaction):
        try:
            player = self.players.get(interaction.guild_id)
            if not player or player.queue.empty():
                return await interaction.response.send_message(content=":x: 待播清單本來就是空的啦！")
            while not player.queue.empty():
                try:
                    player.queue.get_nowait()
                except: break
            
            msg = f":white_check_mark: 痛快！`{interaction.user.display_name}` 把待播清單通通清空了！"
            await interaction.response.send_message(content=msg)
        except Exception as e:
            print("[clear_logic 錯誤]", e)
            try:
                await interaction.response.send_message(content=":x: 發生一點錯誤，請再試一次看看！")
            except:
                pass

    async def nowplaying_logic(self, interaction: discord.Interaction, source_data=None, current=None, incoming_player=None, silent=False):
        """處理正在播放的 Embed 和 View 生成，供 play 和 nowplaying 指令共用 (silent 為 True 可避免通知)"""
        try:
            player = incoming_player or self.players.get(interaction.guild_id)
            if not player or (not current and not player.current):
                if not interaction.response.is_done():
                    return await interaction.response.send_message(content=":x: 目前沒有播放任何音樂喔。")
                return await interaction.followup.send(content=":x: 目前沒有播放任何音樂喔。")

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

            view = NowPlayingView(self)
            
            # 當 silent=True 時（player_loop 調用），發送訊息但不觸發通知
            if silent:
                await interaction.channel.send(embed=embed, view=view, silent=True)
            else:
                if not interaction.response.is_done():
                    await interaction.response.send_message(embed=embed, view=view)
                else:
                    await interaction.followup.send(embed=embed, view=view)
        except Exception as e:
            print("[nowplaying_logic 錯誤]", e)
            try:
                if not interaction.response.is_done():
                    await interaction.response.send_message(content=":x: 哎呀，我拿不到這首歌的播放資訊耶... 晚點再試試看好嗎？")
                else:
                    await interaction.followup.send(content=":x: 哎呀，我拿不到這首歌的播放資訊耶... 晚點再試試看好嗎？")
            except:
                pass

    async def queue_logic(self, interaction: discord.Interaction, page: int = 1):
        try:
            player = self.players.get(interaction.guild_id)
            if not player or player.queue.empty():
                msg = ":x: 待播清單目前空空如也喔。"
                if not interaction.response.is_done():
                    return await interaction.response.send_message(content=msg)
                return await interaction.followup.send(content=msg)
            
            upcoming = list(player.queue._queue)
            per_page = 10
            total = len(upcoming)
            max_page = (total - 1) // per_page + 1
            
            if page < 1 or page > max_page:
                return await interaction.response.send_message(f":x: 頁數超出範圍囉，請輸入 1 ~ {max_page} 之間的數字。", ephemeral=False)
            
            # 定義分頁 View (已加入 Emoji 和清空按鈕)
            class QueueView(discord.ui.View):
                def __init__(self, queue_data, page, max_page, music_cog):
                    super().__init__(timeout=180)
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
                    embed = discord.Embed(title=f"待播清單 (第 {self.current_page}/{self.max_page} 頁，共 {len(self.queue_data)} 首)", description=fmt, color=discord.Color.green())
                    await interaction.edit_original_response(embed=embed, view=self)

            start = (page - 1) * per_page
            end = start + per_page
            fmt = "\n".join([f"{i+1}. {item.get('title', '未知')}" for i, item in enumerate(upcoming[start:end], start=start)])
            embed = discord.Embed(title=f":scroll: 待播清單 (第 {page}/{max_page} 頁，共 {total} 首)", description=fmt, color=discord.Color.green())
            
            view = QueueView(upcoming, page, max_page, self)
            if not interaction.response.is_done():
                await interaction.response.send_message(embed=embed, view=view, ephemeral=False)
            else:
                await interaction.followup.send(embed=embed, view=view, ephemeral=False)
        except Exception as e:
            print("[queue_logic 錯誤]", e)
            if not interaction.response.is_done():
                await interaction.response.send_message(":x: 發生一點錯誤，請再試一次看看！", ephemeral=False)

    # --- 斜線指令宣言 (Slash Commands) ---

    @app_commands.command(name="join", description="讓機器人加入您目前的語音頻道")
    async def join(self, interaction: discord.Interaction):
        await self.join_logic(interaction)

    @app_commands.command(name="play", description="播放音樂 (支援網址、關鍵字、播放清單)")
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

    @app_commands.command(name="queue", description="查看當前待待播清單")
    @app_commands.describe(page="要查看的頁數")
    async def queue_info(self, interaction: discord.Interaction, page: int = 1):
        await self.queue_logic(interaction, page)

    @app_commands.command(name="playlist", description="查看當前待待播清單")
    @app_commands.describe(page="要查看的頁數")
    async def playlist(self, interaction: discord.Interaction, page: int = 1):
        await self.queue_logic(interaction, page)

    @app_commands.command(name="clear", description="清空待播清單")
    async def clear(self, interaction: discord.Interaction):
        await self.clear_logic(interaction)

    @app_commands.command(name="nowplaying", description="查看目前正在播放的歌曲資訊")
    async def nowplaying(self, interaction: discord.Interaction):
        await self.nowplaying_logic(interaction)

async def setup(bot: commands.Bot):
    await bot.add_cog(Music(bot))
