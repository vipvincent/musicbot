# Discord Music Bot 🎵

使用 `discord.js` + `Shoukaku` + `Lavalink` 製作的 Discord 音樂機器人。

---

# 功能

- YouTube
- Bilibili
- 自動推薦播放
- 代播清單
- 正在播放和按鈕控制

## 斜線指令

| 指令 | 說明 |
|------|------|
| `/join` | 加入語音頻道 |
| `/leave` | 離開語音頻道 |
| `/play` `/search` | 播放音樂 |
| `/skip` `/next` | 下一首 |
| `/stop` | 停止播放並離開 |
| `/queue` `/playlist` | 查看待播清單 |
| `/clear` | 清空待播 |
| `/nowplaying` | 顯示目前播放資訊 |
| `/pause` | 暫停播放 |
| `/resume` | 繼續播放 |
| `/autorecommend` | 繼續播放 |

---

# 環境需求

- Node.js 20+
- Lavalink 伺服器
- Java 17+ (Lavalink 需要)

---

# 安裝步驟

> 也可以透過docker部署，請參考docker-compose.example.yml


## 1. 部署Lavalink

1. 請前往[Lavalink網站](https://github.com/lavalink-devs/Lavalink/releases/latest)下載lavalink並透過java運行，或者建議透過docker部署

2. 請複製專案根目錄下的`application.yml`到Lavalink目錄
   - Lavalink應該會自動下載以下插件，如果沒有請手動下載：
      - [youtube_source](https://github.com/lavalink-devs/youtube-source)
      - [LavaSrc](https://github.com/topi314/LavaSrc)
      - [Lavabili](https://github.com/ParrotXray/lavabili-plugin)

## 2. 取得 Bot Token 與邀請連結

1. 到 [Discord Developer Portal](https://discord.com/developers/applications) 建立一個 Application。
2. 在頁面 **Bot(機器人)** 中：
   - 取得您的 **Token(權杖)**。
3. 在頁面 **Installation(安裝)** 中設定邀請權限：
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

## 3. 設定環境變數 `.env`
將專案根目錄下的 `.env.example` 複製一份並命名為 `.env`，並修改`DISCORD_BOT_TOKEN`：

```env
# Discord
DISCORD_BOT_TOKEN="your_discord_bot_token"

# Lavalink
LAVALINK_HOST="127.0.0.1"
LAVALINK_PORT="2333"
LAVALINK_PASSWORD="youshallnotpass"
LAVALINK_SECURE="false"
```

## 4. 運行機器人

### 安裝依賴

```bash
npm install
```
### 啟動lavlink伺服器

```bash
java -jar Lavalink.jar
```

### 啟動機器人

```bash
npm run start 
```
