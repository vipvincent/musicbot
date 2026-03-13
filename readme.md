# Discord Music Bot 🎵

使用 `discord.js` + `Shoukaku` + `Lavalink` 製作的 Discord 音樂機器人。

支援：

- YouTube 搜尋與播放
- YouTube 播放清單
- Queue 分頁
- Now Playing 面板
- 按鈕控制（下一首 / 清空 / 離開）
- Lavalink plugin 擴充

---

# 功能

## Slash Commands

| 指令 | 說明 |
|------|------|
| `/join` | 加入語音頻道 |
| `/play song:<關鍵字或網址>` | 播放音樂 |
| `/search song:<關鍵字或網址>` | 搜尋並播放 |
| `/skip` | 下一首 |
| `/next` | 下一首 |
| `/stop` | 停止播放並離開 |
| `/leave` | 離開語音頻道 |
| `/queue` | 查看待播清單 |
| `/playlist` | 查看待播清單 |
| `/clear` | 清空待播 |
| `/nowplaying` | 顯示目前播放資訊 |

---

# 環境需求

- Node.js 20+
- Lavalink 伺服器

---
# 安裝步驟

> 也可以透過docker部署，請參考docker-compose.example.yml


## 1.部署Lavalink

請前往Lavalink網站下載.jar並透過java運行，或者建議透過docker部署

需要以下Lavalink插件：
    - youtube_source
    - lavasrc

可透過專案根目錄下的‵application.yml‵來套lavalink設定

## 2.取得 Discord Client ID, Bot Token 與邀請連結
1. 到 [Discord Developer Portal](https://discord.com/developers/applications) 建立一個 Application。
2. 在 **一般資訊** 頁面中，取得你的 **Client ID(應用程式 ID)**。
3. 在 **Bot(機器人)** 選項中：
   - 取得您的 **Token(權杖)**。
4. 在 **Installation(安裝)** 選項中設定邀請權限：
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
5. 設定完成後，您可以在 **Installation(安裝)** 中的 **Install Link(安裝連結)** 將機器人加入伺服器。

## 3.設定環境變數 `.env`
將專案根目錄下的 `.env.example` 複製一份並命名為 `.env`：

```env
# Discord
DISCORD_BOT_TOKEN="your_discord_bot_token"
DISCORD_CLIENT_ID="your_discord_client_id"
```

## 4.運行

### 安裝依賴

```bash
npm install
```

### 啟動機器人

```bash
npm run start 
```

---