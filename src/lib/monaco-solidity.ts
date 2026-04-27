/// Custom Monaco Monarch tokenizer for Solidity (`.sol`).
///
/// Monaco doesn't ship a Solidity language out of the box. The grammar
/// below is hand-rolled, modelled on Monaco's built-in `cpp` tokenizer
/// (Solidity is C-family in surface syntax — `{}` blocks, `;` line
/// terminators, `//` and `/* */` comments) with Solidity-specific
/// vocabulary on top.
///
/// What's covered:
///   - Pragma directives (`pragma solidity ^0.8.20;`)
///   - SPDX license comments (`// SPDX-License-Identifier: MIT`)
///   - Contract / library / interface / struct / enum / abstract
///   - Visibility + state-mutability keywords (public/private/internal/
///     external + view/pure/payable + constant/immutable)
///   - Built-in types (uint8..uint256, int8..int256, address, bool,
///     string, bytes, bytes1..bytes32, mapping)
///   - Control flow (if/else/for/while/do/return/break/continue)
///   - Modifier keywords (modifier, virtual, override, abstract)
///   - Globals: msg.sender / msg.value / block.* / tx.* / abi.* /
///     keccak256 / sha256 / ripemd160 / require / revert / assert
///   - Hex / decimal / scientific / binary / underscore-separated
///     numeric literals + Solidity unit suffixes (wei/gwei/ether,
///     seconds/minutes/hours/days/weeks)
///   - Hex string literals (`hex"deadbeef"`) and unicode strings
///     (`unicode"≥1"`)
///   - Custom `error Foo(...)` declarations + `revert Foo(...)` calls

import type { languages } from "monaco-editor";

const SOLIDITY_KEYWORDS = [
  // Top-level declarations
  "pragma",
  "import",
  "as",
  "from",
  "using",
  "for",
  "contract",
  "library",
  "interface",
  "abstract",
  "is",
  "struct",
  "enum",
  "type",
  "event",
  "anonymous",
  "indexed",
  "modifier",
  "function",
  "constructor",
  "fallback",
  "receive",
  "error",

  // Visibility + state mutability
  "public",
  "private",
  "internal",
  "external",
  "view",
  "pure",
  "payable",
  "nonpayable",
  "constant",
  "immutable",
  "virtual",
  "override",

  // Storage location
  "memory",
  "storage",
  "calldata",

  // Control flow
  "if",
  "else",
  "while",
  "do",
  "for",
  "break",
  "continue",
  "return",
  "returns",
  "try",
  "catch",
  "throw",
  "emit",
  "new",
  "delete",
  "assembly",
  "let",
  "switch",
  "case",
  "default",
  "leave",

  // Boolean literals + null-ish
  "true",
  "false",

  // Misc reserved
  "this",
  "super",
  "_",
  "after",
  "alias",
  "apply",
  "auto",
  "byte",
  "copyof",
  "define",
  "final",
  "implements",
  "in",
  "inline",
  "macro",
  "match",
  "mutable",
  "null",
  "of",
  "partial",
  "promise",
  "reference",
  "relocatable",
  "sealed",
  "sizeof",
  "static",
  "supports",
  "typedef",
  "typeof",
  "unchecked",
  "var",
  "wei",
];

/// Built-in numeric / address / bytes types. Listed explicitly so they
/// pick up the `keyword.type` token (separate from regular keywords) —
/// makes types stand out in declarations like `uint256 public total;`.
const SOLIDITY_TYPES: string[] = [
  // Boolean + address
  "bool",
  "address",

  // Strings + dynamic bytes
  "string",
  "bytes",

  // Mappings + tuples + ints
  "mapping",
  "fixed",
  "ufixed",
  "int",
  "uint",
];

// Append every `int8`, `int16`, …, `int256` and `uint8`..`uint256` and
// `bytes1`..`bytes32` programmatically — saves a 100-line literal block.
for (let i = 8; i <= 256; i += 8) {
  SOLIDITY_TYPES.push(`int${i}`, `uint${i}`);
}
for (let i = 1; i <= 32; i += 1) {
  SOLIDITY_TYPES.push(`bytes${i}`);
}

const SOLIDITY_GLOBALS = [
  "msg",
  "block",
  "tx",
  "abi",
  "blockhash",
  "blobhash",
  "gasleft",
  "now",
  "keccak256",
  "sha256",
  "sha3",
  "ripemd160",
  "ecrecover",
  "addmod",
  "mulmod",
  "selfdestruct",
  "suicide",
  "require",
  "assert",
  "revert",
  "type",
];

const SOLIDITY_UNITS = [
  "wei",
  "gwei",
  "szabo",
  "finney",
  "ether",
  "seconds",
  "minutes",
  "hours",
  "days",
  "weeks",
  "years",
];

export const solidityConf: languages.LanguageConfiguration = {
  comments: {
    lineComment: "//",
    blockComment: ["/*", "*/"],
  },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

export const solidityLang: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".sol",
  keywords: SOLIDITY_KEYWORDS,
  typeKeywords: SOLIDITY_TYPES,
  globals: SOLIDITY_GLOBALS,
  units: SOLIDITY_UNITS,
  operators: [
    "=",
    ">",
    "<",
    "!",
    "~",
    "?",
    ":",
    "==",
    "<=",
    ">=",
    "!=",
    "&&",
    "||",
    "++",
    "--",
    "+",
    "-",
    "*",
    "/",
    "&",
    "|",
    "^",
    "%",
    "<<",
    ">>",
    "+=",
    "-=",
    "*=",
    "/=",
    "&=",
    "|=",
    "^=",
    "%=",
    "<<=",
    ">>=",
    "=>",
  ],

  // Token-class regexen reused inside the rules table.
  symbols: /[=><!~?:&|+\-*\/\^%]+/,
  escapes:
    /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
  decimals: /\d+(?:_\d+)*/,

  tokenizer: {
    root: [
      // SPDX license — call it out as a special metadata comment so it
      // doesn't get lost in regular `//` comment colour.
      [/^\s*\/\/\s*SPDX-License-Identifier:.*$/, "metatag"],

      // pragma directives — `pragma solidity ^0.8.20;`. The whole line
      // including the version range gets a single special highlight.
      [/^\s*pragma\b/, { token: "keyword.directive", next: "@pragma" }],

      // identifiers + keyword groups
      [
        /[a-zA-Z_$][\w$]*/,
        {
          cases: {
            "@typeKeywords": "keyword.type",
            "@keywords": "keyword",
            "@globals": "predefined",
            "@units": "number.unit",
            "@default": "identifier",
          },
        },
      ],

      // hex string literal:  hex"deadbeef"
      [/(hex)("[^"]*")/, ["keyword", "string"]],
      [/(hex)('[^']*')/, ["keyword", "string"]],
      // unicode string literal: unicode"≥1"
      [/(unicode)("[^"]*")/, ["keyword", "string"]],
      [/(unicode)('[^']*')/, ["keyword", "string"]],

      // whitespace + comments
      { include: "@whitespace" },

      // delimiters and operators
      [/[{}()\[\]]/, "@brackets"],
      [/[<>](?!@symbols)/, "@brackets"],
      [
        /@symbols/,
        { cases: { "@operators": "operator", "@default": "" } },
      ],

      // numeric literals (Solidity allows underscore separators —
      // `1_000_000` — same as JavaScript)
      [/0[xX][0-9a-fA-F]+(_[0-9a-fA-F]+)*/, "number.hex"],
      [/0[bB][01]+(_[01]+)*/, "number.binary"],
      [
        /\d+(_\d+)*\.\d+(_\d+)*([eE][+\-]?\d+)?/,
        "number.float",
      ],
      [/\d+(_\d+)*[eE][+\-]?\d+/, "number.float"],
      [/\d+(_\d+)*/, "number"],

      // delimiter
      [/[;,.]/, "delimiter"],

      // strings
      [/"([^"\\]|\\.)*$/, "string.invalid"], // unterminated
      [/"/, { token: "string.quote", bracket: "@open", next: "@string_dq" }],
      [/'([^'\\]|\\.)*$/, "string.invalid"],
      [/'/, { token: "string.quote", bracket: "@open", next: "@string_sq" }],
    ],

    pragma: [
      [/[^;]+/, "string"],
      [/;/, { token: "delimiter", next: "@pop" }],
    ],

    whitespace: [
      [/[ \t\r\n]+/, ""],
      [/\/\*/, "comment", "@comment"],
      [/\/\/.*$/, "comment"],
    ],

    comment: [
      [/[^\/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[\/*]/, "comment"],
    ],

    string_dq: [
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
    ],

    string_sq: [
      [/[^\\']+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/'/, { token: "string.quote", bracket: "@close", next: "@pop" }],
    ],
  },
};
