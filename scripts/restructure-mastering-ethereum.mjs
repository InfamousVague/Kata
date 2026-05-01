#!/usr/bin/env node
/// One-off curriculum restructure for the `mastering-ethereum` course.
/// Maps the 91 ch04 exercises (plus the few in other chapters) to the
/// 17-chapter layout the actual Mastering Ethereum book uses. Driven
/// by the audit in the chat session — see the comment block at
/// `LESSON_TARGET_CHAPTER` for the per-lesson assignment rationale.
///
/// Idempotent: re-running with the same input produces the same
/// output. Lessons whose ids are missing from `LESSON_TARGET_CHAPTER`
/// stay in their current chapter (so adding new lessons over time
/// doesn't accidentally orphan them).
///
/// Usage:
///   node scripts/restructure-mastering-ethereum.mjs
///   DRY_RUN=1 node scripts/restructure-mastering-ethereum.mjs

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP = join(homedir(), "Library/Application Support/com.mattssoftware.kata/courses");
const COURSE_PATH = join(APP, "mastering-ethereum/course.json");
const DRY_RUN = !!process.env.DRY_RUN;

if (!existsSync(COURSE_PATH)) {
  console.error(`No course.json at ${COURSE_PATH}`);
  process.exit(1);
}

// ── 17-chapter book layout (Mastering Ethereum 2nd ed.) ─────────
//
// Order matters — this is the spine of the curriculum. Chapters not
// listed here get pruned (after their lessons get redistributed).
// Title strings match the book's ToC headings.
const CHAPTER_ORDER = [
  ["ch01-what-is-ethereum", "What Is Ethereum?"],
  ["ch02-ethereum-basics", "Ethereum Basics"],
  ["ch03-ethereum-nodes", "Ethereum Clients and Nodes"],
  ["ch04-cryptography", "Cryptography"],
  ["ch05-wallets", "Wallets"],
  ["ch06-transactions", "Transactions"],
  ["ch07-smart-contracts-and-solidity", "Smart Contracts and Solidity"],
  ["ch08-smart-contracts-and-vyper", "Smart Contracts and Vyper"],
  ["ch09-smart-contract-security", "Smart Contract Security"],
  ["ch10-tokens", "Tokens"],
  ["ch11-oracles", "Oracles"],
  ["ch12-decentralized-applications", "Decentralized Applications"],
  ["ch13-decentralized-finance", "Decentralized Finance"],
  ["ch14-the-evm", "The Ethereum Virtual Machine"],
  ["ch15-consensus", "Consensus"],
  ["ch16-scaling", "Scaling"],
  ["ch17-zero-knowledge-proofs", "Zero-Knowledge Proofs"],
];

// ── Lesson-id → target-chapter map ──────────────────────────────
//
// Per the audit. `id`s here are the in-zip course ids of every
// lesson currently in the course; the value is the chapter id from
// `CHAPTER_ORDER` to move it to. Lessons whose chapter assignment
// was already correct (e.g. `ch01-wei-ether` staying in
// `ch01-what-is-ethereum`) are also listed for clarity / safety.
const LESSON_TARGET_CHAPTER = {
  // ── ch01 ──────────────────────────────────────────────
  "ch01-reading": "ch01-what-is-ethereum",
  "ch01-wei-ether": "ch01-what-is-ethereum",

  // ── ch04-cryptography (was ch02 in old layout) ────────
  "ch02-reading": "ch04-cryptography",
  "ch02-pubkey-address": "ch04-cryptography",
  "ch02-eip55-checksum": "ch04-cryptography",

  // ── ch06-transactions ─────────────────────────────────
  "ch03-reading": "ch06-transactions",
  "ch03-build-tx": "ch06-transactions",
  "ch03-verify-signer": "ch06-transactions",
  // The ABI-encode-call lesson was filed in ch04; it's actually a
  // tx-layer concept (calldata encoding) so it belongs here.
  "ch04-encode-call": "ch06-transactions",

  // ── ch04-cryptography (more — moved from ch04 bulk) ───
  "ch04-smart-contracts-evm-keccak256-of-packed-args-matches-off-chain": "ch04-cryptography",
  "ch04-smart-contracts-evm-abi-encodepacked-vs-abi-encode-hash-difference": "ch04-cryptography",
  "ch04-smart-contracts-evm-ecrecover-signature-verification": "ch04-cryptography",
  "ch04-smart-contracts-evm-eip-712-typed-data-hash-builder": "ch04-cryptography",
  "ch04-smart-contracts-evm-merkle-airdrop-with-proof-verification": "ch04-cryptography",

  // ── ch07-smart-contracts-and-solidity (the bulk) ──────
  "ch04-reading": "ch07-smart-contracts-and-solidity",
  "ch04-quiz": "ch07-smart-contracts-and-solidity",

  // Storage primitives + basic state
  "ch04-smart-contracts-evm-storage-bool-flag-with-toggle": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-storage-uint256-read-write": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-storage-address-with-setter": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-storage-string-label": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-storage-bytes32-commitment": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-constant-immutable-variables": "ch07-smart-contracts-and-solidity",

  // Constructors + visibility
  "ch04-smart-contracts-evm-constructor-sets-owner-from-msg-sender": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-constructor-with-two-args-name-symbol": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-external-view-returning-two-values": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-pure-function-for-math-square-cube": "ch07-smart-contracts-and-solidity",

  // Modifiers (basic ones — onwer-renounce variants)
  "ch04-smart-contracts-evm-modifier-onlyowner": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-modifier-notzeroaddress": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-modifier-notpaused-with-bool-flag": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-modifier-with-parameter-minstake": "ch07-smart-contracts-and-solidity",

  // Events
  "ch04-smart-contracts-evm-single-event-emit-on-state-change": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-indexed-event-args-transfer-shape": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-event-with-three-indexed-args-decoded-via-getlog": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-event-driven-counter-no-return-just-event": "ch07-smart-contracts-and-solidity",

  // Error handling
  "ch04-smart-contracts-evm-require-with-custom-message": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-custom-error-with-named-field-payload": "ch07-smart-contracts-and-solidity",

  // Globals + ETH
  "ch04-smart-contracts-evm-msg-sender-msg-value-introspection": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-block-number-sanity": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-block-timestamp-guard": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-address-this-balance-read": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-fallback-function-emits-event": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-receive-function-logs-deposit": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-payable-function-gates-on-minimum-value": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-transfer-eth-to-externally-supplied-address": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-eth-deposit-per-user-withdraw-with-mapping": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-low-level-call-returning-success-bool": "ch07-smart-contracts-and-solidity",

  // Simple state machines / examples
  "ch04-smart-contracts-evm-simple-add-subtract-calculator": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-owner-renounce-set-to-zero-address": "ch07-smart-contracts-and-solidity",

  // Mappings + collections
  "ch04-smart-contracts-evm-mapping-address-uint256-balance-ledger": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-nested-mapping-allowance-address-address-uint": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-dynamic-array-push-pop-with-bounds": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-fixed-size-array-of-recent-depositors": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-struct-array-tasks-list-with-status": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-mapping-of-structs-user-profiles": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-enum-driven-state-machine-pending-active-closed": "ch07-smart-contracts-and-solidity",

  // Inheritance + interfaces
  "ch04-smart-contracts-evm-interface-implementation-ifoo": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-function-overloading-deposit-vs-deposit-uint": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-virtual-override-across-two-contracts": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-abstract-base-contract-with-hook": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-two-contract-inheritance-owned-pausable": "ch07-smart-contracts-and-solidity",

  // Misc Solidity
  "ch04-smart-contracts-evm-abi-encode-abi-decode-round-trip": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-negative-ints-int256-accounting": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-split-contract-into-two-and-call-across": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-timelock-release-after-block-timestamp": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-pausable-contract-with-admin-flip": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-subscription-with-monthly-window": "ch07-smart-contracts-and-solidity",
  "ch04-smart-contracts-evm-tip-jar-with-leaderboard-top-n-tracking": "ch07-smart-contracts-and-solidity",

  // ── ch09-smart-contract-security ──────────────────────
  "ch04-smart-contracts-evm-checks-effects-interactions-full-demo": "ch09-smart-contract-security",
  "ch04-smart-contracts-evm-withdraw-pattern-with-pull-model": "ch09-smart-contract-security",
  "ch04-smart-contracts-evm-reentrancy-guard-with-mutex-cross-function": "ch09-smart-contract-security",
  "ch04-smart-contracts-evm-increment-decrement-with-underflow-guard": "ch09-smart-contract-security",
  "ch04-smart-contracts-evm-two-step-ownership-transfer-claim-pattern": "ch09-smart-contract-security",

  // ── ch10-tokens (was scattered across ch04 + ch05) ────
  "ch05-reading": "ch10-tokens",
  "ch05-erc20-transfer": "ch10-tokens",
  "ch04-smart-contracts-evm-erc-20-mint-transfer-balanceof": "ch10-tokens",
  "ch04-smart-contracts-evm-erc-20-burn-from-caller": "ch10-tokens",
  "ch04-smart-contracts-evm-erc-20-approve-transferfrom-flow": "ch10-tokens",
  "ch04-smart-contracts-evm-erc-721-mint-ownerof-transferfrom": "ch10-tokens",
  "ch04-smart-contracts-evm-erc-721-approve-getapproved": "ch10-tokens",
  "ch04-smart-contracts-evm-erc-1155-batch-balance-batch-transfer": "ch10-tokens",
  "ch04-smart-contracts-evm-eip-712-permit-off-chain-sig-on-chain-consume": "ch10-tokens",
  "ch04-smart-contracts-evm-erc-20-with-eip-2612-permit": "ch10-tokens",
  "ch04-smart-contracts-evm-minimal-erc-4626-vault-deposit-redeem": "ch10-tokens",
  "ch04-smart-contracts-evm-fixed-supply-token-transfers": "ch10-tokens",

  // ── ch11-oracles ──────────────────────────────────────
  "ch04-smart-contracts-evm-commit-reveal-scheme-for-fair-lottery": "ch11-oracles",

  // ── ch12-decentralized-applications ───────────────────
  "ch06-reading": "ch12-decentralized-applications",
  "ch04-smart-contracts-evm-votable-proposal-yes-no-tally": "ch12-decentralized-applications",
  "ch04-smart-contracts-evm-n-of-m-multisig-wallet": "ch12-decentralized-applications",
  "ch04-smart-contracts-evm-dao-proposal-lifecycle-propose-vote-execute": "ch12-decentralized-applications",
  "ch04-smart-contracts-evm-mini-governor-queue-delay-execute": "ch12-decentralized-applications",

  // ── ch13-decentralized-finance ────────────────────────
  "ch04-smart-contracts-evm-constant-product-amm-add-remove-liquidity": "ch13-decentralized-finance",
  "ch04-smart-contracts-evm-amm-swap-with-price-impact": "ch13-decentralized-finance",
  "ch04-smart-contracts-evm-flash-loan-callback-round-trip": "ch13-decentralized-finance",
  "ch04-smart-contracts-evm-vesting-cliff-linear-unlock-with-claim": "ch13-decentralized-finance",
  "ch04-smart-contracts-evm-english-auction-with-bidder-refunds": "ch13-decentralized-finance",
  "ch04-smart-contracts-evm-dutch-auction-decreasing-price-over-time": "ch13-decentralized-finance",

  // ── ch14-the-evm ──────────────────────────────────────
  "ch04-smart-contracts-evm-factory-with-create2-deterministic-addresses": "ch14-the-evm",
  "ch04-smart-contracts-evm-create2-constructor-immutable-args": "ch14-the-evm",
  "ch04-smart-contracts-evm-minimal-proxy-clone-eip-1167": "ch14-the-evm",
  "ch04-smart-contracts-evm-transparent-proxy-with-admin-slot": "ch14-the-evm",
  "ch04-smart-contracts-evm-uups-upgrade-with-self-authorising-upgrade-fn": "ch14-the-evm",
  "ch04-smart-contracts-evm-assembly-add-with-overflow-check": "ch14-the-evm",
  "ch04-smart-contracts-evm-inline-assembly-read-storage-slot-directly": "ch14-the-evm",
  "ch04-smart-contracts-evm-delegatecall-library-for-shared-storage-layout": "ch14-the-evm",
  "ch04-smart-contracts-evm-gas-efficient-packed-storage-3-fields-in-1-slot": "ch14-the-evm",

  // ── ch15-consensus ────────────────────────────────────
  "ch07-reading": "ch15-consensus",
  "ch07-merkle-root": "ch15-consensus",
};

// ── Per-lesson within-chapter ordering hint ──────────────────────
//
// `kind` first (reading → exercise → quiz), then difficulty
// (easy → medium → hard), then by id for stability.
function orderingKey(lesson) {
  const kindRank = { reading: 0, exercise: 1, mixed: 1, quiz: 9, cloze: 2, micropuzzle: 3, puzzle: 4 };
  const diffRank = { easy: 0, medium: 1, hard: 2 };
  return [
    kindRank[lesson.kind] ?? 5,
    diffRank[lesson.difficulty] ?? 5,
    lesson.id,
  ];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// ── Run ──────────────────────────────────────────────────────────

const course = JSON.parse(readFileSync(COURSE_PATH, "utf8"));

// Pull every lesson out, attach its current chapter id for fallback,
// then re-bucket into the new layout.
const newChapters = new Map();
for (const [id, title] of CHAPTER_ORDER) {
  newChapters.set(id, { id, title, lessons: [] });
}

const moved = [];
const stayed = [];
for (const ch of course.chapters) {
  for (const lesson of ch.lessons) {
    const target = LESSON_TARGET_CHAPTER[lesson.id];
    if (target && newChapters.has(target)) {
      newChapters.get(target).lessons.push(lesson);
      if (target !== ch.id) {
        moved.push({ id: lesson.id, from: ch.id, to: target });
      } else {
        stayed.push(lesson.id);
      }
    } else if (newChapters.has(ch.id)) {
      // Keep the lesson in its current chapter if that chapter
      // exists in the new layout — we just don't have an explicit
      // override.
      newChapters.get(ch.id).lessons.push(lesson);
      stayed.push(lesson.id);
    } else {
      // Orphan — chapter doesn't exist in new layout AND there's no
      // mapping. Fall through to ch07 (Solidity) as a sane catch-all
      // since that's where most generic exercises fit.
      newChapters.get("ch07-smart-contracts-and-solidity").lessons.push(lesson);
      moved.push({ id: lesson.id, from: ch.id, to: "ch07-smart-contracts-and-solidity (orphan)" });
    }
  }
}

// Sort within each chapter by reading → exercise → quiz, then easy →
// medium → hard, then by id for stability.
for (const ch of newChapters.values()) {
  ch.lessons.sort((a, b) => compareKeys(orderingKey(a), orderingKey(b)));
}

// Drop chapters with zero lessons (we'll seed readings later for the
// new ones that need them, but for this restructure pass an empty
// chapter is just visual noise).
const finalChapters = [];
for (const [id] of CHAPTER_ORDER) {
  const ch = newChapters.get(id);
  if (ch.lessons.length > 0) finalChapters.push(ch);
}

course.chapters = finalChapters;

if (DRY_RUN) {
  console.log(`[dry] would move ${moved.length} lesson(s)`);
  for (const m of moved.slice(0, 20)) {
    console.log(`  ${m.id}: ${m.from} → ${m.to}`);
  }
  if (moved.length > 20) console.log(`  ... +${moved.length - 20} more`);
  console.log(`\n[dry] new chapter layout (${finalChapters.length} chapters):`);
  for (const ch of finalChapters) {
    console.log(`  ${ch.id} (${ch.title}): ${ch.lessons.length} lessons`);
  }
  process.exit(0);
}

writeFileSync(COURSE_PATH, JSON.stringify(course, null, 2), "utf8");

console.log(`Moved ${moved.length} lessons across chapters.`);
console.log(`\nNew layout (${finalChapters.length} chapters):`);
for (const ch of finalChapters) {
  const ex = ch.lessons.filter((l) => l.kind === "exercise" || l.kind === "mixed").length;
  console.log(`  ${ch.id} (${ch.title}): ${ch.lessons.length} lessons (${ex} ex)`);
}
