// Style-Bert-VITS2 客户端 + 本机播放。
//
// 合成：GET {serverUrl}/voice?text=...&model_name=...&speaker_name=...&language=JP|ZH|EN
//   返回 audio/wav（RIFF PCM）。SBV2 的 API 见：
//   https://github.com/litagin02/Style-Bert-VITS2 的 server_fastapi.py
// 播放：Windows 用 PowerShell 的 SoundPlayer；macOS 用 afplay；Linux 用 aplay / ffplay。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LANGUAGE_TAG = { jp: "JP", zh: "ZH", en: "EN" };

/**
 * 调 SBV2 合成一段语音，返回 wav Buffer。
 * voice: { modelName, speakerName, style, styleWeight, length }
 */
export async function synthesize(config, voice, text, { language = "jp", timeoutMs = 120000 } = {}) {
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

/** 查服务器上可用的模型；返回 { ok, models }。 */
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
