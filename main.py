import discord
from discord.ext import commands
import os
from dotenv import load_dotenv

# 載入 .env 檔案
load_dotenv()

TOKEN = os.getenv("DISCORD_BOT_TOKEN")

class MusicBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        # intents.message_content = True
        intents.voice_states = True
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        # 載入 Cog
        for filename in os.listdir("./cogs"):
            if filename.endswith(".py"):
                await self.load_extension(f"cogs.{filename[:-3]}")
        
        # 同步斜線指令 (Slash Commands)
        await self.tree.sync()
        print(f"已同步斜線指令至 Discord")

        # 註冊持久化按鈕視圖
        from cogs.music import NowPlayingView
        music_cog = self.get_cog('Music')
        if music_cog:
            self.add_view(NowPlayingView(music_cog, guild_id=None))

    async def on_ready(self):
        print(f"機器人已上線：{self.user} (ID: {self.user.id})")

if __name__ == "__main__":
    bot = MusicBot()
    bot.run(TOKEN)
