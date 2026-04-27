/// Custom Monaco Monarch tokenizer for `.svelte` source.
///
/// Monaco doesn't ship a Svelte language out of the box. The grammar
/// below is hand-rolled, modelled directly on Monaco's own HTML
/// tokenizer pattern for `<script>` / `<style>` embed handoff (see
/// node_modules/monaco-editor/esm/vs/basic-languages/html/html.js
/// for the canonical shape — short version: a dedicated "embedded"
/// state with `nextEmbedded: <lang>` on the body-entry rule + a
/// catch-all `[^<]+` so the cursor advances and the embedded
/// language actually receives bytes; without that the embedded
/// tokenizer never runs and the inner JS/CSS shows up uncoloured).
///
/// Svelte adds two things on top of HTML:
///   - Brace expressions: `{value}`, `{#if}`, `{#each}`, `{:else}`,
///     `{/if}`, `{@html}`, `{@const}`, etc. We drop into a JS-
///     flavoured "expression" state on `{` and pop on the matching
///     `}`. Block opener keywords (`if` / `each` / etc.) get a
///     control-flow tint; the rest of the expression highlights
///     like JS.
///   - Directives inside tag attributes: `on:click`, `bind:value`,
///     `class:foo`, `transition:fly`, `use:tooltip`. The `prefix:`
///     part is highlighted as `keyword.directive` so the wiring
///     reads at a glance. The right-hand `{expr}` re-uses the same
///     expression state.
///
/// Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`,
/// `$bindable`, `$inspect`, `$host`) are tokenized as `predefined`
/// inside expressions so they stand out in script blocks.

import type { languages } from "monaco-editor";

const SVELTE_BLOCK_KEYWORDS = [
  "if",
  "else",
  "each",
  "as",
  "await",
  "then",
  "catch",
  "key",
  "snippet",
  "render",
  "const",
  "html",
  "debug",
];

const SVELTE_AT_TAGS = ["html", "const", "debug", "render"];

const SVELTE_RUNES = [
  "$state",
  "$derived",
  "$effect",
  "$props",
  "$bindable",
  "$inspect",
  "$host",
];

const JS_KEYWORDS =
  "if|else|for|while|do|switch|case|default|return|break|continue|let|const|var|function|class|extends|new|this|super|true|false|null|undefined|typeof|instanceof|in|of|throw|try|catch|finally|async|await|import|export|from|as|yield";

export const svelteLang: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".svelte",

  tokenizer: {
    root: [
      // HTML comments — passthrough.
      [/<!--/, "comment", "@comment"],
      // Doctype.
      [/<!DOCTYPE/, "metatag", "@doctype"],

      // <script> / <style> dispatch into per-tag-attrs states. The
      // `(<)(script|style)` shape captures the `<` as delimiter and
      // the tag name as `tag` so they highlight identically to
      // every other tag despite the special-casing below.
      [
        /(<)(script)\b/,
        ["delimiter", { token: "tag", next: "@scriptOpen" }],
      ],
      [
        /(<)(style)\b/,
        ["delimiter", { token: "tag", next: "@styleOpen" }],
      ],

      // Closing tags.
      [/(<)(\/)([A-Za-z][\w-]*)/, ["delimiter", "delimiter", "tag"]],
      [/<\//, "delimiter", "@closingTag"],

      // Opening tags. Component-style PascalCase names work too —
      // same shape as HTML elements.
      [/(<)([A-Za-z][\w-]*)/, ["delimiter", { token: "tag", next: "@tag" }]],

      // Brace blocks. Order matters: `{#`/`{:`/`{/`/`{@` are more
      // specific than `{` so they win.
      [/\{#/, { token: "keyword.flow", next: "@blockOpen" }],
      [/\{:/, { token: "keyword.flow", next: "@blockMid" }],
      [/\{\//, { token: "keyword.flow", next: "@blockClose" }],
      [/\{@/, { token: "keyword", next: "@atTag" }],
      [/\{/, { token: "delimiter.bracket", next: "@expr" }],

      // Plain text + entities.
      [/&[a-zA-Z][a-zA-Z0-9]*;/, "string.escape"],
      [/[^<{&]+/, ""],
    ],

    comment: [
      [/[^-]+/, "comment.content"],
      [/-->/, "comment", "@pop"],
      [/[-]/, "comment.content"],
    ],

    doctype: [
      [/[^>]+/, "metatag.content"],
      [/>/, "metatag", "@pop"],
    ],

    closingTag: [
      [/[^>]+/, "tag"],
      [/>/, "delimiter", "@pop"],
    ],

    // Attributes inside <script ...>. Key behaviour: the `>` rule
    // jumps to `scriptEmbedded` AND nests the embedded language
    // (typescript covers both `<script>` and `<script lang="ts">`
    // since TS is a JS superset). The body-text rule in
    // scriptEmbedded then advances through the content while the
    // embedded tokenizer paints it.
    scriptOpen: [
      [/\s+/, ""],
      [/[a-zA-Z_][\w-]*/, "attribute.name"],
      [/=/, "delimiter"],
      [/"[^"]*"/, "attribute.value"],
      [/'[^']*'/, "attribute.value"],
      [
        />/,
        {
          token: "delimiter",
          next: "@scriptEmbedded",
          nextEmbedded: "javascript",
        },
      ],
      [/\/>/, { token: "delimiter", next: "@pop" }],
      // Closing-tag handler. `scriptEmbedded` pops back here on
      // </script — we then consume the full closing tag and pop
      // ONE more level back to root. Without this rule the state
      // machine would stay stuck in scriptOpen, treating `script`
      // as an attribute name and `>` as another delimiter (the
      // exact bug we fixed last iteration). Pattern lifted from
      // Monaco's own HTML tokenizer.
      [
        /(<\/)(script\s*)(>)/,
        ["delimiter", "tag", { token: "delimiter", next: "@pop" }],
      ],
    ],
    scriptEmbedded: [
      // `@rematch` keeps the </script> for scriptOpen to re-match,
      // while `nextEmbedded: @pop` tells Monaco we're leaving
      // embedded JS mode.
      [
        /<\/script/,
        { token: "@rematch", next: "@pop", nextEmbedded: "@pop" },
      ],
      // CRUCIAL: this rule advances the cursor past every non-`<`
      // chunk while the embedded language tokenizes it. Without
      // it, Monaco stalls — the embedded tokenizer never receives
      // bytes and the body renders as plain unstyled text.
      [/[^<]+/, ""],
      // Stray `<` that ISN'T `</script` — keep advancing.
      [/</, ""],
    ],

    styleOpen: [
      [/\s+/, ""],
      [/[a-zA-Z_][\w-]*/, "attribute.name"],
      [/=/, "delimiter"],
      [/"[^"]*"/, "attribute.value"],
      [/'[^']*'/, "attribute.value"],
      [
        />/,
        {
          token: "delimiter",
          next: "@styleEmbedded",
          nextEmbedded: "css",
        },
      ],
      [/\/>/, { token: "delimiter", next: "@pop" }],
      [
        /(<\/)(style\s*)(>)/,
        ["delimiter", "tag", { token: "delimiter", next: "@pop" }],
      ],
    ],
    styleEmbedded: [
      [/<\/style/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }],
      [/[^<]+/, ""],
      [/</, ""],
    ],

    // Inside `<tag …>` — attributes + closing.
    tag: [
      [/\s+/, ""],
      // Svelte directives: `on:click`, `bind:value`, `class:foo`,
      // `transition:fly`, `use:tooltip`. Highlight the prefix as
      // a directive keyword, then the suffix as the attribute
      // name.
      [
        /(on|bind|class|style|use|transition|in|out|animate)(:)([\w-]+)/,
        ["keyword.directive", "delimiter", "attribute.name"],
      ],
      [/[A-Za-z_][\w-]*/, "attribute.name"],
      [/=/, "delimiter"],
      [/"/, "string", "@attrStringDouble"],
      [/'/, "string", "@attrStringSingle"],
      [/\{/, { token: "delimiter.bracket", next: "@expr" }],
      [/\/>/, { token: "tag", next: "@pop" }],
      [/>/, { token: "tag", next: "@pop" }],
    ],

    attrStringDouble: [
      [/[^"{]+/, "string"],
      [/\{/, { token: "delimiter.bracket", next: "@expr" }],
      [/"/, "string", "@pop"],
    ],
    attrStringSingle: [
      [/[^'{]+/, "string"],
      [/\{/, { token: "delimiter.bracket", next: "@expr" }],
      [/'/, "string", "@pop"],
    ],

    // {#if expr}, {#each xs as x}, {#await p}, {#key v}, {#snippet name(args)}.
    blockOpen: [
      [
        new RegExp(`(${SVELTE_BLOCK_KEYWORDS.join("|")})\\b`),
        "keyword.flow",
      ],
      { include: "@exprRules" },
    ],
    blockMid: [
      [
        new RegExp(`(${SVELTE_BLOCK_KEYWORDS.join("|")})\\b`),
        "keyword.flow",
      ],
      { include: "@exprRules" },
    ],
    blockClose: [
      [
        new RegExp(`(${SVELTE_BLOCK_KEYWORDS.join("|")})\\b`),
        "keyword.flow",
      ],
      [/\}/, { token: "keyword.flow", next: "@pop" }],
    ],

    atTag: [
      [new RegExp(`(${SVELTE_AT_TAGS.join("|")})\\b`), "keyword"],
      { include: "@exprRules" },
    ],

    // Generic `{ ... }` brace expression. JS-flavoured syntax with
    // a hard stop on the closing `}`.
    expr: [{ include: "@exprRules" }],

    // Shared expression rules — referenced from `@expr` and the
    // block opener/middle/atTag states above so `{#each xs as x}`
    // and `{value}` highlight identically.
    exprRules: [
      [/"/, "string", "@exprStringDouble"],
      [/'/, "string", "@exprStringSingle"],
      [/`/, "string", "@exprStringTemplate"],
      [
        new RegExp(`(${SVELTE_RUNES.map((r) => "\\" + r).join("|")})\\b`),
        "predefined",
      ],
      [new RegExp(`\\b(${JS_KEYWORDS})\\b`), "keyword"],
      [/\b\d+(\.\d+)?\b/, "number"],
      [/[A-Z][\w$]*/, "type.identifier"],
      [/[a-z_$][\w$]*/, "identifier"],
      [/[+\-*/%=<>!&|^~?:]/, "operator"],
      [/[(),.;]/, "delimiter"],
      [/[\[\]]/, "delimiter.square"],
      [/\s+/, ""],
      [/\}/, { token: "delimiter.bracket", next: "@pop" }],
    ],

    exprStringDouble: [
      [/[^"\\]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],
    exprStringSingle: [
      [/[^'\\]+/, "string"],
      [/\\./, "string.escape"],
      [/'/, "string", "@pop"],
    ],
    exprStringTemplate: [
      [/[^`$\\]+/, "string"],
      [/\\./, "string.escape"],
      [/`/, "string", "@pop"],
      [/\$\{[^}]*\}/, "string"],
    ],
  },
};

export const svelteConf: languages.LanguageConfiguration = {
  comments: { blockComment: ["<!--", "-->"] },
  brackets: [
    ["<", ">"],
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
    { open: "<!--", close: "-->", notIn: ["comment", "string"] },
  ],
  surroundingPairs: [
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "<", close: ">" },
  ],
};
