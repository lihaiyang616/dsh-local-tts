// 配置的读取 / 保存 / 默认值。
//
// 为什么不走 DSH 的原生 Config schema：
//   第三方插件被装进 profile 的 node_modules，那里不一定有 @deepseek-ai/schemastery；
//   import 失败会让整个插件加载不了。所以配置用自己的 JSON 文件，路径固定在
//   $DSH_HOME/local-tts.json（默认 ~/.dsh/local-tts.json），用户直接编辑即可。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function configPath() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "local-tts.json");
}

export function defaultConfig() {
  return {
    // 引擎：sbv2（本机 Style-Bert-VITS2）| edge（微软在线中文等）| auto（日文走 sbv2，其余走 edge）
    provider: "sbv2",
    serverUrl: "http://127.0.0.1:5000",
    autoSpeak: false,
    // [] = 所有加载中的会话；也可以填具体 session id
    sessions: [],
    maxChars: 300,
    stripMarkdown: true,
    // "auto" | "zh" | "jp" | "en"：auto 按文字自动判断
    language: "auto",
    // 默认音色（voices 里的 name）；留空则按语言自动挑
    defaultVoice: "",
    // 每语言用哪个音色，例如 { "zh": "xiaoxiao", "jp": "ling" }
    languageVoices: {},
    // SBV2 音色列表：每个对应一个 SBV2 模型 + 说话人 + 语言
    voices: [],
    // edge-tts 设置（provider=edge 或 auto 时用）
    edge: {
      pythonPath: "",
      voice: "zh-CN-XiaoxiaoNeural",
      rate: "+0%",
      volume: "+0%",
      pitch: "+0Hz",
    },
    ffmpegPath: "",
  };
}

const STR = (v, fallback) => (typeof v === "string" ? v : fallback);
const NUM = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export function normalizeConfig(raw) {
  const base = defaultConfig();
  const c = raw && typeof raw === "object" ? raw : {};
  const voices = Array.isArray(c.voices)
    ? c.voices
        .filter((v) => v && typeof v === "object")
        .map((v, i) => ({
          name: STR(v.name, "voice-" + (i + 1)),
          modelName: STR(v.modelName, ""),
          speakerName: STR(v.speakerName, ""),
          languages: Array.isArray(v.languages)
            ? v.languages.map((x) => String(x).toLowerCase())
            : [STR(v.language, "jp").toLowerCase()],
          style: STR(v.style, "Neutral"),
          styleWeight: NUM(v.styleWeight, 1.0, 0, 100),
          length: NUM(v.length, 1.0, 0.3, 3.0),
        }))
        .filter((v) => v.modelName)
    : [];
  const languageVoices =
    c.languageVoices && typeof c.languageVoices === "object"
      ? Object.fromEntries(
          Object.entries(c.languageVoices).map(([k, v]) => [String(k).toLowerCase(), String(v)]),
        )
      : {};
  const edgeRaw = c.edge && typeof c.edge === "object" ? c.edge : {};
  const provider = ["sbv2", "edge", "auto"].includes(String(c.provider).toLowerCase())
    ? String(c.provider).toLowerCase()
    : "sbv2";
  return {
    ...base,
    ...c,
    provider,
    serverUrl: STR(c.serverUrl, base.serverUrl).replace(/\/+$/, ""),
    autoSpeak: c.autoSpeak === undefined ? base.autoSpeak : !!c.autoSpeak,
    sessions: Array.isArray(c.sessions) ? c.sessions.map(String) : [],
    maxChars: Math.round(NUM(c.maxChars, base.maxChars, 20, 2000)),
    stripMarkdown: c.stripMarkdown === undefined ? base.stripMarkdown : !!c.stripMarkdown,
    language: ["auto", "zh", "jp", "en"].includes(String(c.language).toLowerCase())
      ? String(c.language).toLowerCase()
      : "auto",
    defaultVoice: STR(c.defaultVoice, ""),
    languageVoices,
    voices,
    edge: {
      pythonPath: STR(edgeRaw.pythonPath, base.edge.pythonPath),
      voice: STR(edgeRaw.voice, base.edge.voice),
      rate: STR(edgeRaw.rate, base.edge.rate),
      volume: STR(edgeRaw.volume, base.edge.volume),
      pitch: STR(edgeRaw.pitch, base.edge.pitch),
    },
    ffmpegPath: STR(c.ffmpegPath, base.ffmpegPath),
  };
}

export function loadConfig({ create = true } = {}) {
  const path = configPath();
  if (!existsSync(path)) {
    const cfg = defaultConfig();
    if (create) saveConfig(cfg);
    return cfg;
  }
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    console.error("[local-tts] 读配置失败，用默认值：" + (error && error.message));
    return defaultConfig();
  }
}

export function saveConfig(cfg) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return path;
}
