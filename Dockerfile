# 官方 Deno 鏡像作為來源
FROM denoland/deno:bin AS deno-bin

# Python 鏡像
FROM python:3-slim

# 從 Deno 鏡像中複製執行檔到系統路徑
COPY --from=deno-bin /deno /usr/local/bin/deno

# 設定工作目錄
WORKDIR /app

# 環境設定
ENV FFMPEG_PATH="/usr/bin/ffmpeg"

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