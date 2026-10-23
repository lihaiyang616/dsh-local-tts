import test from "node:test";
import assert from "node:assert/strict";

import { clipText, detectLanguage, pickVoice, stripMarkdown } from "../lib/text.js";
import { defaultConfig, normalizeConfig } from "../lib/config.js";

test("detectLanguage：假名是日文，纯汉字是中文，拉丁是英文", () => {
  assert.equal(detectLanguage("こんにちは、今日はいい天気ですね"), "jp");
  assert.equal(detectLanguage("你好呀，今天天气不错"), "zh");
  assert.equal(detectLanguage("hello there"), "en");
  assert.equal(detectLanguage("……！？"), null);
});

test("stripMarkdown：代码块、链接、列表符号都去掉", () => {
  const input = "# 标题\n\n- 第一项\n```js\nconsole.log(1)\n```\n看[这里](https://example.com)。";
  const out = stripMarkdown(input);
  assert.ok(!out.includes("```"));
  assert.ok(!out.includes("console.log"));
  assert.ok(out.includes("第一项"));
  assert.ok(out.includes("看这里"));
});

test("clipText：超长截断并补省略号", () => {
  const long = "字".repeat(50);
  const out = clipText(long, 20);
  assert.equal(out.length, 22); // 20 个字 + 省略号「……」两个字符
  assert.ok(out.endsWith("……"));
});

test("pickVoice：按语言挑音色，没有就回退", () => {
  const config = normalizeConfig({
    ...defaultConfig(),
    defaultVoice: "ling",
    languageVoices: { zh: "zh-voice" },
    voices: [
      { name: "ling", modelName: "Ling-v2", speakerName: "Ling v2", languages: ["jp"] },
      { name: "zh-voice", modelName: "Chinese-model", speakerName: "speaker", languages: ["zh"] },
    ],
  });
  assert.equal(pickVoice(config, { text: "你好" }).voice.name, "zh-voice");
  assert.equal(pickVoice(config, { text: "こんにちは" }).voice.name, "ling");
  assert.equal(pickVoice(config, { text: "hello" }).voice.name, "ling"); // 没有 en 音色 → 回退默认
  assert.equal(pickVoice(config, { text: "你好", voice: "ling" }).mismatch, true);
});
