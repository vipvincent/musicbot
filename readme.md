# Discord Music Bot (Python)

這是一個使用 `discord.py` 開發的現代化音樂機器人。支援 YouTube、YouTube Music 播放，並具備豐富的斜線指令 (Slash Commands) 與互動式按鈕操作。

## 🌟 功能特色

- **多平台支援**：支援 YouTube 影片、YouTube Music 以及 YouTube 播放清單。
- **斜線指令**：完全採用 Discord 原生 `/` 指令，操作直觀且具備參數提示。
- **互動式操控**：播放時會發送包含按鈕 (⏭️ 跳過、📜 待播、🗑️ 清空、🚪 離開) 的訊息，直接點擊即可操作。
- **智慧連線**：
  - 自動偵測並維持語音連線。
  - **自動省電模式**：若頻道內無人播放音樂超過 5 分鐘，機器人會自動離開。
- **高效解析**：使用多執行緒解析音樂資訊，大幅提升搜尋與載入速度。
- **穩定播放**：內建自動重連機制，解決 YouTube 串流斷線問題。
- **容器化支援**：提供 Dockerfile，可輕易部署於伺服器上。

---

## 🛠️ 環境需求

在啟動機器人之前，請確保您的環境滿足以下條件：

- **Python 3.11+**
- **FFmpeg**：用於音訊轉碼。
  - 需於 `.env` 設定路徑。
- **Deno** 或 **Node.js**：`yt-dlp` 需要其中之一來處理 YouTube 的 JavaScript 挑戰。
  - *推薦使用 Deno，因為它受到yt-dlp官方推薦*

---

## ⚙️ 配置步驟

### 1. 取得 Discord Bot Token 與邀請連結
1. 到 [Discord Developer Portal](https://discord.com/developers/applications) 建立一個 Application。
2. 在 **Bot(機器人)** 選項中：
   - 取得您的 **Token(權杖)**。
3. 在 **Installation(安裝)** 選項中設定邀請權限：
   - **Allowed Install Types(安裝背景)** 中勾選 `Guild Install(公會安裝)`。
   - **Default Install Settings(預設安裝設定)** 中的 **Guild Install(公會安裝)** 設定以下：
      - **Scopes(範圍)**: 
        - `applications.commands`
        - `bot`
      - **Permissions(權限)**: 
        - `View Channels(檢視頻道)`
        - `Send Messages(傳送訊息)`
        - `Embed Links(嵌入連結)`
        - `Read Message History(讀取訊息歷史記錄)`
        - `Connect(連接)`
        - `Speak(說話)`
        - `Use Voice Activity(使用語音活動)`
4. 設定完成後，您可以在 **Installation(安裝)** 中的 **Install Link(安裝連結)** 將機器人加入伺服器。

### 2. 設定環境變數 `.env`
將專案根目錄下的 `.env.example` 複製一份並命名為 `.env`：

```env
DISCORD_BOT_TOKEN="您的_BOT_TOKEN"
FFMPEG_PATH="./external/ffmpeg.exe" # 指向您的 FFmpeg 執行檔
```

---

## 🚀 執行方式

### 方法 A：直接執行 (本地環境)
1. **安裝 Python 依賴**：
   ```bash
   pip install -r requirements.txt
   ```
2. **啟動**：
   ```bash
   python main.py
   ```

### 方法 B：使用 Docker
1. **建立並執行容器**：
   ```bash
   docker build -t dcmusicbot .
   docker run -d --env-file .env dcmusicbot
   ```

---

## 🎮 指令說明

本機器人全面支援 **Slash Commands (斜線指令)**：

- `/play [網址或關鍵字]`：搜尋並播放音樂。支援直接播放 YouTube 播放清單。
- `/skip` (或 `/next`)：跳過當前播放的音樂。
- `/stop` (或 `/leave`)：停止播放、清空隊列並離開頻道。
- `/queue` (或 `/playlist`)：顯示待播放清單 (支援分頁查看)。
- `/nowplaying`：查看目前正在播放的歌曲詳細資訊。
- `/clear`：清空待播放清單。
- `/join`：將機器人呼叫至您所在的語音頻道。

---

## 📂 專案架構

```text
dc musicbot/
├── cogs/
│   └── music.py      # 音樂核心邏輯與斜線指令
├── external/
│   └── ffmpeg.exe    # FFmepg 執行檔 (本地執行需自備)
├── .env              # 環境設定檔 (需自行建立)
├── main.py           # 機器人啟動入口
└── requirements.txt  # Python 依賴清單
```
