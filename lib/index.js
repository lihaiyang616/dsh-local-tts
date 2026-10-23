// DSH 本地朗读 · 宿主半边
//
// 干一件事：会话里「说完一整轮」的助手文字 → 交给本机 Style-Bert-VITS2 合成 →
// 直接从你的扬声器念出来。不经过浏览器、不需要登录任何账号、不用开着网页。
//
// 设计要点：
//   · 只念 assistant/message 里 type=text 的块；工具调用、思考过程不念。
//   · 每轮最多念 maxChars 个字；Markdown 先剥掉。
//   · 多音色：按文字语言自动挑（日语有假名 / 中文 / 英文），可配置映射。
//   · 配置放 $DSH_HOME/local-tts.json，改完不用重启（每 1.5 秒检查一次文件改动）。
//   · 所有状态都能用工具 local_tts_status 查到；也可以 local_tts_say 手动试听。
import { statSync } from "node:fs";

import { configPath, loadConfig, normalizeConfig, saveConfig } from "./config.js";
import { clipText, detectLanguage, pickVoice, stripMarkdown } from "./text.js";
import { playWav, probeServer, synthesize, writeTempWav } from "./tts.js";

export const name = "local-tts";

// 需要宿主提供的服务；缺哪个会早报错。
export const inject = ["sessions", "sessionTitle", "timer", "tools"];

const LANG_LABEL = { zh: "中文", jp: "日文", en: "英文" };
const log = (...args) => console.log("[local-tts]", ...args);

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

  /** 把一段文字放进朗读队列；返回 { ok, reason?, spoken? , result? }。 */
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

  async function pump() {
    if (state.playing) return;
    const item = state.queue.shift();
    if (!item) return;
    state.playing = item;
    const started = Date.now();
    let outcome = { ok: false };
    try {
      const pick = pickVoice(config, { text: item.text, voice: item.voice, language: item.language });
      if (!pick.voice) {
        throw new Error("还没有配置音色：编辑 " + configPath() + " 的 voices（modelName 必填）");
      }
      if (pick.mismatch && item.auto) {
        // 自动朗读时，如果音色声明支持的语言和这句话对不上，宁可不念也不念成怪声音。
        state.skipped += 1;
        state.lastError =
          "跳过一条 " + (LANG_LABEL[pick.language] || pick.language || "?") + " 文本：" +
          "音色「" + pick.voice.name + "」只支持 " + pick.voice.languages.join("/") +
          "（可在 local-tts.json 里给这个语言配一个音色）";
        outcome = { ok: false, skipped: true };
        return outcome;
      }
      const bytes = await synthesize(config, pick.voice, item.text, { language: pick.language });
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
      outcome = {
        ok: true,
        voice: pick.voice.name,
        language: pick.language,
        ms: Date.now() - started,
        chars: item.text.length,
      };
      log("念完：" + pick.voice.name + " / " + (LANG_LABEL[pick.language] || pick.language) + " / " + item.text.slice(0, 30));
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
    } catch (error) {
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
        state.seq.set(id, seq); // 第一次看到这个会话：从当前开始，不去念旧历史
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

  // 启动时探一次服务器（不阻塞）
  probeServer(config.serverUrl).then((server) => {
    state.server = server;
    if (!server.ok) log("Style-Bert-VITS2 服务器没连上（" + config.serverUrl + "）：" + (server.error || server.status));
    else log("Style-Bert-VITS2 在线，模型 " + server.models.length + " 个");
  });

  // ---------- 工具 ----------
  try {
    ctx.tools.register({
      name: "local_tts_say",
      description:
        "用本机 Style-Bert-VITS2 立刻朗读一段文字（不走浏览器）。用于测试音色/语言，也可让 AI 主动说一句话。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "要朗读的文字" },
          voice: { type: "string", description: "可选，voices 里的音色名；不填按语言自动挑" },
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
          "已朗读（音色 " + outcome.voice + " / " + (LANG_LABEL[outcome.language] || outcome.language) +
          " / " + outcome.chars + " 字 / " + outcome.ms + "ms）"
        );
      },
    });

    ctx.tools.register({
      name: "local_tts_status",
      description: "查看本地朗读插件状态：服务器、模型、音色配置、队列、最近错误。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const server = await probeServer(config.serverUrl);
        state.server = server;
        const payload = {
          configPath: configPath(),
          serverUrl: config.serverUrl,
          serverOk: server.ok,
          serverError: server.error || null,
          serverModels: server.models,
          autoSpeak: config.autoSpeak,
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
        };
        return JSON.stringify(payload, null, 2);
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
        const next = Object.assign({}, config, { autoSpeak: !!args.enabled });
        config = normalizeConfig(next);
        saveConfig(config);
        configMtime = safeMtime();
        return "自动朗读已" + (config.autoSpeak ? "打开" : "关闭");
      },
    });
  } catch (error) {
    log("注册工具失败：" + ((error && error.message) || error));
  }

  log("已启动；配置 " + configPath());
}
