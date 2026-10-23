// 文字语言判断 + 音色挑选。
const KANA = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN = /[A-Za-z]/;

/** 粗粒度判断一句话的主要语言：jp / zh / en；判断不出来返回 null。 */
export function detectLanguage(text) {
  const t = String(text || "");
  if (KANA.test(t)) return "jp"; // 有假名 = 日文（日文里也常夹汉字）
  if (HAN.test(t)) return "zh";
  if (LATIN.test(t)) return "en";
  return null;
}

/**
 * 挑一个音色：
 *   1. 调用方显式指定了 voice → 按名字找；
 *   2. 语言（显式或自动判断）在 languageVoices 里有映射 → 用映射的音色；
 *   3. 否则找第一个支持这个语言的音色；
 *   4. 都没有 → 用 defaultVoice / 第一个音色。
 * 返回 { voice, language, mismatch }，mismatch 表示挑中的音色未必读得了这个语言。
 */
export function pickVoice(config, { text = "", voice = "", language = "" } = {}) {
  const voices = Array.isArray(config.voices) ? config.voices : [];
  if (voices.length === 0) return { voice: null, language: language || null, mismatch: false };

  const byName = (name) => {
    const key = String(name || "").toLowerCase();
    if (!key) return null;
    return voices.find((v) => String(v.name).toLowerCase() === key) || null;
  };
  const lang = String(language || "").toLowerCase() || (config.language === "auto" ? detectLanguage(text) : config.language);

  const explicit = byName(voice);
  if (explicit) {
    return {
      voice: explicit,
      language: lang || explicit.languages[0] || null,
      mismatch: !!lang && !explicit.languages.includes(lang),
    };
  }

  if (lang) {
    const mapped = byName(config.languageVoices[lang]);
    if (mapped) {
      return { voice: mapped, language: lang, mismatch: !mapped.languages.includes(lang) };
    }
    const supporting = voices.find((v) => v.languages.includes(lang));
    if (supporting) return { voice: supporting, language: lang, mismatch: false };
  }

  const fallback = byName(config.defaultVoice) || voices[0];
  return {
    voice: fallback,
    language: lang || fallback.languages[0] || null,
    mismatch: !!lang && !fallback.languages.includes(lang),
  };
}

/** 把 Markdown 变成适合朗读的纯文本：去代码块、链接、强调符号、列表符号。 */
export function stripMarkdown(text) {
  let t = String(text || "");
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  t = t.replace(/^\s{0,3}[-*+]\s+/gm, "");
  t = t.replace(/^\s{0,3}>\s?/gm, "");
  t = t.replace(/[*_~]{1,3}/g, "");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** 截断到 maxChars 个字符（别读半分钟）。 */
export function clipText(text, maxChars) {
  const t = String(text || "");
  const max = Number(maxChars) > 0 ? Number(maxChars) : 300;
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/[\s，,。.！!？?、；;：:]+$/, "") + "……";
}
