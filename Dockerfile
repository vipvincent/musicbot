FROM python:3-slim

# 設定工作目錄
WORKDIR /app

# 環境設定
ENV TZ="Asia/Taipei"
ENV FFMPEG_PATH="/usr/bin/ffmpeg"
ENV DISCORD_BOT_TOKEN="your_discord_bot_token"

# 安裝 ffmpeg 和必要的系統依賴
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# 複製並安裝 Python 依賴
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 複製其餘代碼
COPY . .

CMD [ "python", "./main.py" ]