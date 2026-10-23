// TTS 引擎：Style-Bert-VITS2（本机）与 edge-tts（微软在线）。
//
// SBV2：GET {serverUrl}/voice?... → audio/wav（RIFF PCM）
// edge：调 edge-tts 生成 mp3，再用 ffmpeg 转成 wav（这样播放统一走 SoundPlayer）
// 播放：Windows 用 PowerShell 的 SoundPlayer；macOS 用 afplay；Linux 用 aplay。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LANGUAGE_TAG = { jp: "JP", zh: "ZH", en: "EN" };

/** 跑一个子进程并收输出；超时杀掉。 */
function run(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, stderr: String((error && error.message) || error) });
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      if (!settled) {
        settled = true;
        resolve({ ok: false, stderr: "超时" });
      }
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ ok: false, stderr: String((error && error.message) || error) });
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ ok: code === 0, code, stdout: out, stderr: err });
      }
    });
  });
}

/** 调 SBV2 合成一段语音，返回 wav Buffer。 */
export async function synthesizeSbv2(config, voice, text, { language = "jp", timeoutMs = 120000 } = {}) {
  const url = new URL(config.serverUrl.replace(/\/+$/, "") + "/voice");
  url.searchParams.set("text", text);
  url.searchParams.set("model_name", voice.modelName);
  if (voice.speakerName) url.searchParams.set("speaker_name", voice.speakerName);
  if (voice.style) url.searchParams.set("style", voice.style);
  if (voice.styleWeight !== undefined) url.searchParams.set("style_weight", String(voice.styleWeight));
  if (voice.length !== undefined) url.searchParams.set("length", String(voice.length));
  if (language) url.searchParams.set("language", LANGUAGE_TAG[String(language).toLowerCase()] || "JP");

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(`SBV2 ${response.status}` + (detail ? `: ${detail}` : ""));
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("SBV2 返回的不是 wav（检查模型名/说话人/语言是否正确）");
  }
  return bytes;
}

/** 用 edge-tts 合成中文/英文等（微软在线语音），返回 wav Buffer。 */
export async function synthesizeEdge(config, text, { timeoutMs = 120000 } = {}) {
  const python = config.edge.pythonPath || "python";
  const ffmpeg = config.ffmpegPath || "ffmpeg";
  const dir = mkdtempSync(join(tmpdir(), "dsh-local-tts-edge-"));
  const mp3 = join(dir, "speech.mp3");
  const wav = join(dir, "speech.wav");
  try {
    const tts = await run(
      python,
      [
        "-m",
        "edge_tts",
        "--text",
        text,
        "--voice",
        config.edge.voice,
        "--rate",
        config.edge.rate,
        "--volume",
        config.edge.volume,
        "--pitch",
        config.edge.pitch,
        "--write-media",
        mp3,
      ],
      { timeoutMs },
    );
    if (!tts.ok) throw new Error("edge-tts 失败：" + (tts.stderr || "exit " + tts.code).slice(0, 300));
    const conv = await run(ffmpeg, ["-y", "-loglevel", "error", "-i", mp3, "-ar", "22050", "-ac", "1", wav], {
      timeoutMs,
    });
    if (!conv.ok) throw new Error("ffmpeg 转 wav 失败：" + (conv.stderr || "exit " + conv.code).slice(0, 300));
    const bytes = readFileSync(wav);
    if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF") {
      throw new Error("edge 合成结果不是 wav");
    }
    return bytes;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 查 SBV2 服务器上可用的模型；返回 { ok, models }。 */
export async function probeServer(serverUrl, { timeoutMs = 3000 } = {}) {
  try {
    const response = await fetch(serverUrl.replace(/\/+$/, "") + "/models/info", {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, status: response.status, models: [] };
    const data = await response.json();
    const models = Object.values(data || {}).map((m) => ({
      model: m.model_path ? String(m.model_path).split(/[\\/]/).slice(-2, -1)[0] : "",
      speakers: Object.values(m.id2spk || {}),
      styles: Object.keys(m.style2id || {}),
    }));
    return { ok: true, status: 200, models };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), models: [] };
  }
}

/** 把 wav 写到临时目录，返回路径和清理函数。 */
export function writeTempWav(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-local-tts-"));
  const path = join(dir, "speech.wav");
  writeFileSync(path, bytes);
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function playerFor(path) {
  if (process.platform === "win32") {
    const safe = String(path).replace(/'/g, "''");
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(New-Object Media.SoundPlayer '${safe}').PlaySync()`,
      ],
    };
  }
  if (process.platform === "darwin") return { cmd: "afplay", args: [path] };
  return { cmd: "aplay", args: ["-q", path] };
}

/** 播放 wav 文件，返回 { promise, cancel }。 */
export function playWav(path) {
  const { cmd, args } = playerFor(path);
  const child = spawn(cmd, args, { windowsHide: true, stdio: "ignore" });
  const promise = new Promise((resolve) => {
    child.once("error", (error) => resolve({ ok: false, error: String((error && error.message) || error) }));
    child.once("close", (code) => resolve({ ok: code === 0, code }));
  });
  return {
    promise,
    cancel: () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}
