# dsh-local-tts

**DSH 本地朗读**：把 DSH 会话里「说完一整轮」的回复，交给**本机 Style-Bert-VITS2** 合成语音，直接从你的扬声器念出来。

不经过浏览器、不需要登录任何账号、不用开着网页。音色可以自己训练/克隆，也可以按语言给不同音色。

> 和「朗读桥」类插件的区别：那类插件是把话送到 DeepSeek 网页端、借网页的朗读功能出声（浏览器必须开着）；这个插件把 TTS 放在本机，DSH 说完就念。

## 特性

- 🔈 **本机合成**：调用本地 [Style-Bert-VITS2](https://github.com/litagin02/Style-Bert-VITS2) 的 `/voice` API，语音不离开本机
- 🎭 **多音色**：一个 `voices` 列表，每个音色对应一个 SBV2 模型 + 说话人；可自己训练/克隆
- 🌏 **按语言自动切换**：中文 / 日文 / 英文自动判断，`languageVoices` 指定每种语言用哪个音色；没有对应音色时宁可不念，也不念成怪声音
- ⏭️ **只念正文**：只读助手回复里的文字块，工具调用、思考过程、代码块都跳过
- ✂️ **防话痨**：Markdown 剥掉、每轮最多念 `maxChars` 字
- 🔁 **改配置不用重启**：`~/.dsh/local-tts.json` 改动 1.5 秒内自动生效
- 🧰 **可手动试听**：`local_tts_say` / `local_tts_status` / `local_tts_stop`

## 需要什么

1. **DSH**（桌面版或 `dsh web` 都行）
2. **本机跑着 Style-Bert-VITS2 的 API 服务**
   ```powershell
   cd Style-Bert-VITS2
   .\env\python.exe server_fastapi.py   # 默认听 http://127.0.0.1:5000
   ```
   - 需要 CUDA（SBV2 官方的 FastAPI 服务是 GPU 推理）
   - 模型放进 `model_assets/<模型名>/`，服务会把它们列在 `GET /models/info`
3. Windows 自带 PowerShell（播放 wav 用 `Media.SoundPlayer`）；macOS 用 `afplay`；Linux 需要 `aplay`

## 安装

```sh
# 从 GitHub 装（插件没有发 npm）
dsh plugin --profile desktop add github:lihaiyang250250-del/dsh-local-tts

# 或者本地开发用 link 装
dsh plugin --profile desktop add link:D:/path/to/dsh-local-tts
```

装完**重启 DSH**。插件加载后会自动生成配置文件 `~/.dsh/local-tts.json`（没配 `DSH_HOME` 时）。

## 配置

```json
{
  "serverUrl": "http://127.0.0.1:5000",
  "autoSpeak": true,
  "sessions": [],
  "maxChars": 300,
  "stripMarkdown": true,
  "language": "auto",
  "defaultVoice": "ling",
  "languageVoices": { "jp": "ling", "zh": "中文音色" },
  "voices": [
    {
      "name": "ling",
      "modelName": "Ling-v2",
      "speakerName": "Ling v2",
      "languages": ["jp"],
      "style": "Neutral",
      "length": 1.0
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `serverUrl` | SBV2 服务地址 |
| `autoSpeak` | 是否自动朗读每轮回复 |
| `sessions` | 要朗读的会话 id 列表；`[]` = 所有加载中的会话 |
| `maxChars` | 每轮最多念多少字 |
| `language` | `auto` / `zh` / `jp` / `en`，`auto` 按文字判断（有假名=日文，有汉字=中文，纯拉丁=英文） |
| `defaultVoice` | 没匹配到语言音色时用哪个 |
| `languageVoices` | 语言 → 音色名 |
| `voices` | 音色列表，每项对应一个 SBV2 模型 |

### 音色怎么来（自己训练/克隆）

Style-Bert-VITS2 的训练是它自己的流程：准备若干分钟目标声音 → 训练 → 得到 `model_assets/<名字>/<名字>.safetensors` + `config.json`。把整个目录放进 SBV2 的 `model_assets/`，重启 SBV2 服务，然后在 `voices` 里加一项：

- `modelName`：`model_assets/` 下的目录名（或者用 `/models/info` 里 `model_path` 的目录名）
- `speakerName`：`model_assets/<名字>/config.json` 里 `id2spk` 的值（常见是训练时的说话人名）
- `languages`：这个模型训练时用的语言（`jp` / `zh` / `en`）

> ⚠️ **一个 SBV2 模型只擅长它训练时的语言**。拿日文模型念中文，要么出怪声、要么直接失败——这不是插件的问题。中文要中文模型；本机同时有日文和中文模型时，插件会按文字语言自动切换。

## 工具

| 工具 | 作用 |
|---|---|
| `local_tts_say` | 立刻朗读一段文字（可指定 `voice` / `language`，用来试听） |
| `local_tts_status` | 查看服务器、模型、音色配置、队列、最近错误 |
| `local_tts_stop` | 停止当前朗读并清空队列 |
| `local_tts_set_autospeak` | 打开/关闭自动朗读 |

## 已知限制

- 只支持 SBV2 的 `/voice` 接口；其他 TTS（edge-tts、GPT-SoVITS 等）还没接
- 自动朗读时，语言和音色对不上会**跳过**（避免怪声），跳过原因能在 `local_tts_status` 里看到
- 播放只支持 wav；Linux 需要 `aplay`
- 没有图形设置页，配置就是那个 JSON 文件
- 长文只念前 `maxChars` 字（默认 300）

## 隐私

- 合成请求只发到 `serverUrl`（默认本机 `127.0.0.1`）
- 不联网、不带账号、不收集任何东西
- 临时 wav 存在系统临时目录，播放完即删

## License

MIT
