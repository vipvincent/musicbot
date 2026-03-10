import os
from dotenv import load_dotenv
import logging
import discord
from discord.ext import commands

# 載入 .env 檔案
load_dotenv()

# 手動初始化日誌系統 (因為改用了 asyncio.run，系統不會預設開啟)
discord.utils.setup_logging(level=logging.INFO, root=False)
# [系統] FFmpeg 錯誤代碼監控工具
class FFmpegFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        # 僅隱藏 code 0 (正常切歌) 的訊息，保留其他所有錯誤退出碼
        if "terminated with code 0" in msg:
            return False
        return True

discord_player_log = logging.getLogger('discord.player')
discord_player_log.setLevel(logging.INFO)
discord_player_log.addFilter(FFmpegFilter())

TOKEN = os.getenv("DISCORD_BOT_TOKEN")


class MusicBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.voice_states = True
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        # 載入 Cog
        for filename in os.listdir("./cogs"):
            if filename.endswith(".py"):
                await self.load_extension(f"cogs.{filename[:-3]}")
        
        # 同步斜線指令 (Slash Commands)
        await self.tree.sync()
        print(f"[系統] 已同步斜線指令至 Discord")


    async def on_ready(self):
        print(f"[系統] 機器人已上線：{self.user} (ID: {self.user.id})")
        print("---------------")

if __name__ == "__main__":
    bot = MusicBot()
    # log_handler=None 避免 bot.run() 重複初始化日誌（我們已在頂部手動設定）
    bot.run(TOKEN, log_handler=None)
