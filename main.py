import os
from dotenv import load_dotenv
import logging
import discord
from discord.ext import commands

# 載入 .env 檔案
load_dotenv()

# 手動初始化日誌系統 (因為改用了 asyncio.run，系統不會預設開啟)
discord.utils.setup_logging(level=logging.INFO, root=False)
# [Bug Fix] 忽略 discord.player 的 INFO 層級日誌，避免 FFmpeg 正常退出的 -22 代碼 (4294967274) 洗版
logging.getLogger('discord.player').setLevel(logging.WARNING)

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

        # 註冊持久化按鈕視圖的操作已移至 cogs/music.py 的 __init__ 中處理


    async def on_ready(self):
        print(f"[系統] 機器人已上線：{self.user} (ID: {self.user.id})")

if __name__ == "__main__":
    bot = MusicBot()
    # log_handler=None 避免 bot.run() 重複初始化日誌（我們已在頂部手動設定）
    bot.run(TOKEN, log_handler=None)
