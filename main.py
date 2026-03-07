import discord
from discord.ext import commands
import os
import tomllib

# 讀取 config.toml
with open("config.toml", "rb") as f:
    config = tomllib.load(f)

TOKEN = config["token"]["dcbot"]

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

    async def on_ready(self):
        print(f"機器人已上線：{self.user} (ID: {self.user.id})")
        print("------")

if __name__ == "__main__":
    bot = MusicBot()
    bot.run(TOKEN)
