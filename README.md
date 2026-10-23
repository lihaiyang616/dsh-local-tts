# dsh-local-tts

**DSH 本地朗读**：把 DSH 会话里「说完一整轮」的回复念出来——声音从你本机的扬声器出来，不经过浏览器、不用登录账号、不用开着网页。

引擎二选一：

- **Style-Bert-VITS2（本地）**：音色可以自己训练/克隆，适合日式角色音；需要一个正在跑的 SBV2 服务
- **edge-tts（微软在线语音）**：中文自然（晓晓/云希等），不需要账号，只要联网

> 和「朗读桥」类插件的区别：那类插件把话送到 DeepSeek 网页端、借网页的朗读功能出声（浏览器必须开着）；这个插件自己合成、自己播放。

## 开关语音（重点）

装好、重启 DSH 后，在 DSH 输入框里发命令就行，**想开就开，想关就关**：

| 命令 | 作用 |
|---|---|
| `/voice-on` | 打开自动朗读：从现在起每轮回复都会念 |
| `/voice-off` | 关闭自动朗读（正在念的也会停） |
| `/voice-status` | 查看开关、引擎、服务器、最近错误 |

也可以直接让我开/关（我会调用 `local_tts_set_autospeak`），或者手动改 `~/.dsh/local-tts.json` 里的 `autoSpeak`——改完 1.5 秒内生效。

## 特性

- 🔊 **两种引擎**：本地 SBV2 / 在线 edge，按配置切换或按语言自动分流（`auto`）
- 🎭 **多音色**：SBV2 每个音色对应一个模型 + 说话人，可自己训练/克隆
- 🌏 **按语言自动切换**：中文 / 日文 / 英文自动判断；没有对应音色时宁可不念，也不念成怪声音
- ⏭️ **只念正文**：只读助手回复里的文字块，工具调用、思考过程、代码块都跳过
- ✂️ **防话痨**：Markdown 剥掉、每轮最多念 `maxChars` 字
- 🔁 **热重载**：配置文件改动 1.5 秒内生效，不用重启
- 🧰 **工具**：`local_tts_say` / `local_tts_status` / `local_tts_stop` / `local_tts_set_autospeak`

## 安装

```sh
# 从 GitHub 装（插件没有发 npm）
dsh plugin --profile desktop add github:lihaiyang250250-del/dsh-local-tts

# 或者本地开发用 link 装
dsh plugin --profile desktop add link:D:/path/to/dsh-local-tts
```

装完**重启 DSH**。首次启动会生成配置 `~/.dsh/local-tts.json`（没设 `DSH_HOME` 时）。

## 用哪条路（按你想念什么选）

### A. 中文：edge-tts（最省事）

1. 建一个 Python 环境并安装：
   ```powershell
   python -m venv $env:USERPROFILE\.dsh\venvs\edge-tts
   $env:USERPROFILE\.dsh\venvs\edge-tts\Scripts\python.exe -m pip install edge-tts
   ```
2. 确认有 ffmpeg（`ffmpeg -version`；Windows 可用 `winget install Gyan.FFmpeg`）
3. 在 `~/.dsh/local-tts.json` 里设置：
   ```json
   {
     "provider": "edge",
     "edge": {
       "pythonPath": "C:/Users/你/.dsh/venvs/edge-tts/Scripts/python.exe",
       "voice": "zh-CN-XiaoxiaoNeural",
       "rate": "+0%",
       "volume": "+0%",
       "pitch": "+0Hz"
     },
     "ffmpegPath": "C:/path/to/ffmpeg.exe"
   }
   ```
4. `/voice-on` 试试。可选音色：`zh-CN-XiaoxiaoNeural`（晓晓，女）、`zh-CN-YunxiNeural`（云希，男）、`zh-CN-XiaoyiNeural`（晓伊）等。

### B. 本地 + 自己克隆音色：Style-Bert-VITS2

1. 本机跑起 SBV2 的 API 服务（默认 5000 端口）：
   ```powershell
   cd Style-Bert-VITS2
   .\env\python.exe server_fastapi.py
   ```
2. 模型放进 `model_assets/<模型名>/`，服务会把它们列在 `GET /models/info`
3. 在配置里写 `"provider": "sbv2"` 和 `voices`（见下）

```json
{
  "provider": "sbv2",
  "serverUrl": "http://127.0.0.1:5000",
  "defaultVoice": "ling",
  "languageVoices": { "jp": "ling" },
  "voices": [
    { "name": "ling", "modelName": "Ling-v2", "speakerName": "Ling v2", "languages": ["jp"] }
  ]
}
```

> ⚠️ **一个 SBV2 模型只擅长它训练时的语言**。日文模型念中文会出怪声或直接失败——中文请用中文模型，或直接用上面的 edge 方案。`auto` 模式会按文字语言分流：日文走 SBV2、其它走 edge。

## 配置速查

| 字段 | 说明 |
|---|---|
| `provider` | `sbv2` / `edge` / `auto` |
| `autoSpeak` | 是否自动朗读（`/voice-on` / `/voice-off` 就是改它） |
| `sessions` | 要朗读的会话 id；`[]` = 所有加载中的会话 |
| `maxChars` | 每轮最多念多少字，默认 300 |
| `language` | `auto` / `zh` / `jp` / `en` |
| `languageVoices` | 语言 → 音色名 |
| `voices` | SBV2 音色列表：`modelName` 必填，`languages` 填它会的语言 |
| `edge` | edge-tts 的 python 路径、voice、rate、volume、pitch |
| `ffmpegPath` | mp3 转 wav 用；留空则用 PATH 里的 `ffmpeg` |

## 工具

| 工具 | 作用 |
|---|---|
| `local_tts_say` | 立刻朗读一段文字（可指定 `voice` / `language` 试听） |
| `local_tts_status` | 查看引擎、服务器、音色、队列、最近错误 |
| `local_tts_stop` | 停止当前朗读并清空队列 |
| `local_tts_set_autospeak` | 打开/关闭自动朗读 |

## 已知限制

- 自动朗读时，SBV2 音色和语言对不上会跳过（避免怪声），原因在 `local_tts_status` 里
- 播放只支持 wav；Windows 用 PowerShell SoundPlayer，Linux 需要 `aplay`，macOS 用 `afplay`
- 没有图形设置页，配置就是 `~/.dsh/local-tts.json`
- edge-tts 需要联网；SBV2 需要你自己把服务跑起来

## 隐私

- 用 SBV2 时：只发到 `serverUrl`（默认本机 `127.0.0.1`），不联网
- 用 edge 时：文字会发给微软的语音服务（要念的内容会离开本机）
- 临时 wav 放系统临时目录，播放完即删

## License

MIT
