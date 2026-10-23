// DSH 本地朗读 · 宿主半边
//
// 干一件事：会话里「说完一整轮」的助手文字 → 交给 TTS 引擎合成 → 直接从扬声器念出来。
// 引擎二选一：本机 Style-Bert-VITS2（projver=sbv2）或微软在线 edge-tts（provider=edge，中文自然）。
//
// 设计要点：
//   · 只念 assistant/message 里 type=text 的块；工具调用、思考过程不念。
//   · 每轮最多念 maxChars 个字；Markdown 先剥掉。
//   · 多音色：按文字语言自动挑（日语有假名 / 中文 / 英文），可配置映射。
//   · 配置放 $DSH_HOME/local-tts.json，改完不用重启（每 1.5 秒检查一次文件改动）。
//   · 命令：/voice-on、/voice-off、/voice-status —— 想开就开，不想听就关。
//   · 工具：local_tts_say / local_tts_status / local_tts_stop / local_tts_set_autospeak。
import { appendFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { configPath, loadConfig, normalizeConfig, saveConfig } from "./config.js";
import { clipText, detectLanguage, pickVoice, stripMarkdown } from "./text.js";
import { playWav, probeServer, synthesizeEdge, synthesizeSbv2, writeTempWav } from "./tts.js";

export const name = "local-tts";

// 需要宿主提供的服务；缺哪个会早报错。
export const inject = ["sessions", "sessionTitle", "timer", "tools", "commands"];

const LANG_LABEL = { zh: "中文", jp: "日文", en: "英文" };
const HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const LOG_PATH = join(HOME, "local-tts.log");

function log(...args) {
  const line = "[local-tts] " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(line);
  try {
    appendFileSync(LOG_PATH, new Date().toISOString() + " " + line + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

export function apply(ctx) {
  let config = loadConfig();
  let configMtime = safeMtime();

  const state = {
    queue: [],
    playing: null,
    player: null,
    seq: new Map(),
    lastError: "",
    lastSpokenAt: 0,
    spoken: 0,
    skipped: 0,
    server: { ok: false, models: [] },
  };

  function safeMtime() {
    try {
      return statSync(configPath()).mtimeMs;
    } catch {
      return 0;
    }
  }

  function refreshConfigIfChanged() {
    const mtime = safeMtime();
    if (mtime && mtime !== configMtime) {
      try {
        config = loadConfig({ create: false });
        configMtime = mtime;
        log("配置已重新加载：" + configPath());
      } catch (error) {
        log("配置重载失败：" + ((error && error.message) || error));
      }
    }
  }

  function prepareText(raw) {
    let text = String(raw || "");
    if (config.stripMarkdown) text = stripMarkdown(text);
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return "";
    return clipText(text, config.maxChars);
  }

  /** 把一段文字放进朗读队列；返回 { ok, promise?, reason? }。 */
  function enqueue(text, { voice = "", language = "", auto = false } = {}) {
    const prepared = prepareText(text);
    if (!prepared) return { ok: false, reason: "没有可朗读的文字" };
    if (state.queue.length >= 20) {
      log("队列太长（20 条），丢掉最旧的一条");
      state.queue.shift();
    }
    const item = { text: prepared, voice, language, auto, resolve: null };
    const promise = new Promise((resolve) => {
      item.resolve = resolve;
    });
    state.queue.push(item);
    pump();
    return { ok: true, promise, queue: state.queue.length };
  }

  /** 决定这一条用哪个引擎：edge（在线中文）还是 sbv2（本机日文音色）。 */
  function resolveEngine(lang, pick) {
    if (config.provider === "edge") return "edge";
    if (config.provider === "sbv2") return "sbv2";
    // auto：日文走本机音色，其余走 edge（edge 没配就回退 sbv2）
    if (String(lang || "").toLowerCase() === "jp" && pick.voice) return "sbv2";
    if (config.edge && config.edge.voice) return "edge";
    return "sbv2";
  }

  async function pump() {
    if (state.playing) return;
    const item = state.queue.shift();
    if (!item) return;
    state.playing = item;
    const started = Date.now();
    let outcome = { ok: false };
    try {
      const lang = item.language || (config.language === "auto" ? detectLanguage(item.text) : config.language);
      const pick = pickVoice(config, { text: item.text, voice: item.voice, language: lang });
      const engine = resolveEngine(lang, pick);
      let bytes;
      let label;
      if (engine === "edge") {
        bytes = await synthesizeEdge(config, item.text);
        label = "edge:" + config.edge.voice;
      } else {
        if (!pick.voice) {
          throw new Error("还没有配置 SBV2 音色：编辑 " + configPath() + " 的 voices（modelName 必填）");
        }
        if (pick.mismatch && item.auto) {
          state.skipped += 1;
          state.lastError =
            "跳过一条 " + (LANG_LABEL[pick.language] || "?") + " 文本：音色「" + pick.voice.name + "」只支持 " +
            pick.voice.languages.join("/");
          outcome = { ok: false, skipped: true };
          return outcome;
        }
        bytes = await synthesizeSbv2(config, pick.voice, item.text, { language: pick.language });
        label = "sbv2:" + pick.voice.name;
      }
      const tmp = writeTempWav(bytes);
      try {
        const player = playWav(tmp.path);
        state.player = player;
        const played = await player.promise;
        if (!played.ok) throw new Error("播放失败：" + (played.error || "exit " + played.code));
      } finally {
        state.player = null;
        tmp.cleanup();
      }
      state.lastError = "";
      state.lastSpokenAt = Date.now();
      state.spoken += 1;
      outcome = { ok: true, engine, label, language: lang, ms: Date.now() - started, chars: item.text.length };
      log("念完：" + label + " / " + (LANG_LABEL[lang] || lang) + " / " + item.text.slice(0, 30));
    } catch (error) {
      const message = String((error && error.message) || error);
      state.lastError = message;
      outcome = { ok: false, error: message };
      log("朗读失败：" + message);
    } finally {
      state.playing = null;
      item.resolve(outcome);
      pump();
    }
    return outcome;
  }

  // ---------- 监听会话：只认「一整轮说完」的助手文字 ----------
  function absorb(events) {
    const turnText = new Map();
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      if (ev.type === "assistant/message") {
        const d = ev.data || {};
        const arr = turnText.get(d.turn) || [];
        const blocks = d.message && d.message.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) arr.push(b.text.trim());
          }
        }
        turnText.set(d.turn, arr);
      } else if (ev.type === "turn/end") {
        const d = ev.data || {};
        const arr = turnText.get(d.turn);
        turnText.delete(d.turn);
        if (d.reason && d.reason.kind === "completed" && arr && arr.length) {
          if (!config.autoSpeak) continue;
          const result = enqueue(arr.join("\n"), { auto: true });
          if (!result.ok) log("自动朗读跳过：" + result.reason);
        }
      }
    }
  }

  function targets() {
    let all = [];
    try {
      all = ctx.sessions.list() || [];
    } catch {
      return [];
    }
    if (!Array.isArray(config.sessions) || config.sessions.length === 0) return all;
    const wanted = new Set(config.sessions.map(String));
    return all.filter((s) => wanted.has(String(s.id)));
  }

  function scan() {
    refreshConfigIfChanged();
    for (const s of targets()) {
      const id = String(s.id);
      const seq = Number(s.seq);
      if (!Number.isFinite(seq)) continue;
      if (!state.seq.has(id)) {
        state.seq.set(id, seq); // 第一次看到这个会话：从当前开始，不念旧历史
        continue;
      }
      const prev = state.seq.get(id);
      if (seq <= prev) continue;
      state.seq.set(id, seq);
      let events = [];
      try {
        events = s.snapshotEvents(prev) || [];
      } catch (error) {
        log("读会话 " + id.slice(0, 12) + " 的事件失败：" + ((error && error.message) || error));
        continue;
      }
      absorb(events);
    }
  }

  try {
    ctx.effect(() => ctx.interval(scan, 1500));
  } catch (error) {
    log("定时器挂不上，自动朗读不会跑：" + ((error && error.message) || error));
  }

  probeServer(config.serverUrl).then((server) => {
    state.server = server;
    log(
      "启动；引擎=" + config.provider + "；SBV2 " +
        (server.ok ? "在线（" + server.models.length + " 个模型）" : "没连上") +
        "；配置 " + configPath(),
    );
  });

  function setAuto(enabled) {
    config = normalizeConfig({ ...config, autoSpeak: !!enabled });
    saveConfig(config);
    configMtime = safeMtime();
    return config.autoSpeak;
  }

  // ---------- 工具 ----------
  try {
    ctx.tools.register({
      name: "local_tts_say",
      description: "立刻用本地/在线 TTS 朗读一段文字（不走浏览器）。用于测试音色；也可让 AI 主动说一句话。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "要朗读的文字" },
          voice: { type: "string", description: "可选，SBV2 voices 里的音色名；不填按语言自动挑" },
          language: { type: "string", enum: ["auto", "zh", "jp", "en"], description: "可选，覆盖自动语言判断" },
        },
        required: ["text"],
      },
      execute: async (args) => {
        const text = String((args && args.text) || "");
        if (!text.trim()) return "错误：text 不能为空";
        const language = args && args.language && args.language !== "auto" ? args.language : "";
        const result = enqueue(text, { voice: String((args && args.voice) || ""), language });
        if (!result.ok) return "没有朗读：" + result.reason;
        const outcome = await result.promise;
        if (!outcome.ok) return "朗读失败：" + (outcome.error || "未知原因");
        return (
          "已朗读（" + outcome.label + " / " + (LANG_LABEL[outcome.language] || outcome.language) +
          " / " + outcome.chars + " 字 / " + outcome.ms + "ms）"
        );
      },
    });

    ctx.tools.register({
      name: "local_tts_status",
      description: "查看朗读插件状态：引擎、服务器、音色、队列、自动朗读开关、最近错误。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const server = await probeServer(config.serverUrl);
        state.server = server;
        return JSON.stringify(
          {
            configPath: configPath(),
            provider: config.provider,
            autoSpeak: config.autoSpeak,
            edge: config.edge,
            serverUrl: config.serverUrl,
            serverOk: server.ok,
            serverError: server.error || null,
            serverModels: server.models,
            language: config.language,
            defaultVoice: config.defaultVoice,
            languageVoices: config.languageVoices,
            voices: config.voices.map((v) => ({ name: v.name, model: v.modelName, speaker: v.speakerName, languages: v.languages })),
            sessions: config.sessions.length ? config.sessions : "所有加载中的会话",
            queued: state.queue.length,
            playing: state.playing ? String(state.playing.text).slice(0, 40) : null,
            spoken: state.spoken,
            skipped: state.skipped,
            lastError: state.lastError || null,
          },
          null,
          2,
        );
      },
    });

    ctx.tools.register({
      name: "local_tts_stop",
      description: "停止当前朗读，并清空排队中的朗读。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const removed = state.queue.length;
        state.queue = [];
        try {
          if (state.player) state.player.cancel();
        } catch {
          /* ignore */
        }
        return "已停止" + (removed ? "，清掉 " + removed + " 条排队" : "");
      },
    });

    ctx.tools.register({
      name: "local_tts_set_autospeak",
      description: "打开/关闭自动朗读（等价于改 local-tts.json 的 autoSpeak）。",
      parameters: {
        type: "object",
        properties: { enabled: { type: "boolean", description: "true 打开自动朗读，false 关闭" } },
        required: ["enabled"],
      },
      execute: async (args) => {
        const on = setAuto(args.enabled);
        return "自动朗读已" + (on ? "打开" : "关闭");
      },
    });
  } catch (error) {
    log("注册工具失败：" + ((error && error.message) || error));
  }

  // ---------- 命令：想开就开，想关就关 ----------
  try {
    const command = (name, description, handler) =>
      ctx.commands.register({ name, description, handler });
    command("voice-on", "打开本地朗读：从现在起每轮回复都会念出来", () => {
      setAuto(true);
      return { kind: "success", text: "🔊 语音已打开。想关的时候输入 /voice-off。" };
    });
    command("voice-off", "关闭本地朗读", () => {
      setAuto(false);
      return { kind: "success", text: "🔇 语音已关闭。" };
    });
    command("voice-status", "查看本地朗读状态", async () => {
      const server = await probeServer(config.serverUrl);
      const lines = [
        (config.autoSpeak ? "🔊 自动朗读：开" : "🔇 自动朗读：关"),
        "引擎：" + config.provider + (config.provider !== "sbv2" ? "（edge voice: " + config.edge.voice + "）" : ""),
        "SBV2：" + (server.ok ? "在线，模型 " + server.models.length + " 个" : "没连上（" + (server.error || server.status) + "）"),
        "配置：" + configPath(),
      ];
      if (state.lastError) lines.push("最近错误：" + state.lastError);
      return { kind: "success", text: lines.join("\n") };
    });
  } catch (error) {
    log("注册命令失败：" + ((error && error.message) || error));
  }

  log("已启动；provider=" + config.provider + "；autoSpeak=" + config.autoSpeak);
}
