import os
from dotenv import load_dotenv
import logging
import discord
from discord.ext import commands

# 載入 .env 檔案
load_dotenv()

# 手動初始化日誌系統 (因為改用了 asyncio.run，系統不會預設開啟)
discord.utils.setup_logging(level=logging.INFO, root=False)

TOKEN = os.getenv("DISCORD_BOT_TOKEN")

import asyncio

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

        # 註冊持久化按鈕視圖
        from cogs.music import NowPlayingView
        music_cog = self.get_cog('Music')
        if music_cog:
            self.add_view(NowPlayingView(music_cog, guild_id=None))

    async def close(self):
        """機器人關閉時觸發的清理動作"""
        print("\n[系統] 正在關閉機器人並清理資源...")
        # 這裡會觸發所有 Cog 的 cog_unload
        await super().close()
        
        # [Bug Fix] 強制取消所有剩餘的異步任務，防止退出時卡住
        tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        [task.cancel() for task in tasks]
        if tasks:
            print(f"[系統] 正在清理 {len(tasks)} 個剩餘任務...")
            await asyncio.gather(*tasks, return_exceptions=True)

    async def on_ready(self):
        print(f"[系統] 機器人已上線：{self.user} (ID: {self.user.id})")

if __name__ == "__main__":
    bot = MusicBot()
    
    try:
        asyncio.run(bot.start(TOKEN))
    except KeyboardInterrupt:
        pass
    finally:
        print("[系統] 機器人已安全關閉。")
