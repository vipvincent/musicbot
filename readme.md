# Discord Music Bot (Python)

這是一個使用 `discord.py` 開發的音樂機器人，支援 YouTube 和 YouTube Music，並支援播放清單與斜線指令 (Slash Commands)。

## 🌟 功能特色
- **支援平台**：YouTube, YouTube Music。
- **播放清單**：支援直接播放 YouTube 播放清單網址。
- **斜線指令**：使用 Discord 原生的 `/play` 等指令，操作直觀。
- **本地驅動**：調用自定義目錄下的 `ffmpeg`，確保環境一致性。

---

## 🛠️ 準備工作

在啟動機器人之前，請確保您的環境滿足以下條件：

1. **Python 3.11+**。
2. **必要的執行檔**：
   - 下載 [ffmpeg](https://ffmpeg.org/download.html) 並取得 `ffmpeg.exe`。
3. **建立目錄**：在專案根目錄下建立一個 `ffmpeg` 資料夾，並將 `ffmpeg.exe` 放入其中。

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

### 2. 設定 `config.toml`
將專案根目錄下的 `config_template.toml` 複製一份並重新命名為 `config.toml`，然後填入您的 Token：

```toml
[bot]
token = "您的_DISCORD_BOT_TOKEN_HERE"

[paths]
ffmpeg = "ffmpeg/ffmpeg.exe"
```

---

## 🚀 如何執行

1. **安裝依賴庫**：
   開啟終端機並執行：
   ```bash
   pip install -r requirements.txt
   ```

2. **啟動機器人**：
   ```bash
   python main.py
   ```

---

## 🎮 指令說明

本機器人使用 **Slash Commands (斜線指令)**：

- `/play [網址或關鍵字]`：加入音樂到播放隊列。
- `/skip`：跳過當前播放的音樂。
- `/stop`：停止播放、清空隊列並讓機器人離開頻道。
- `/queue`：顯示目前的待播放清單。

---

## 📂 專案架構
```text
dc musicbot/
├── cogs/
│   └── music.py      # 音樂核心邏輯
├── ffmpeg/
│   └── ffmpeg.exe    # (請手動放入)
├── config.toml       # 唯一設定檔
├── main.py           # 啟動檔案
├── requirements.txt  # 依賴清單
└── .gitignore        # Git 忽略設定
```
