# Fishbones — Cover Art Style Brief

_Visual identity for AI-generated book covers. Generated via Lovart using Nanobanana 2 (Gemini 2.5 Flash Image)._

## 1. Visual identity

**Riso-printed specimen plates from a speculative field guide to software.** Each cover reads like a page torn from a 1960s scientific encyclopedia — the kind where flora, fauna, and machines are laid out as skeletal cross-sections, exploded diagrams, and pinned specimens. The "fishbones" name is taken literally: software concepts are rendered as _structure made visible_ — bones, vertebrae, cross-sections, anatomical plates. Executed with a warm Risograph printing texture (off-registration inks, paper tooth, mottled flats) so a shelf of these feels hand-pulled at a community print shop, not machine-generated. Ernst Haeckel meets Whole Earth Catalog.

## 2. Composition rules

**Always present:**

- 2:3 portrait aspect ratio (generate at 1024 × 1536).
- A single centered specimen / diagram in the upper two-thirds.
- Generous empty cream space in the lower third — the app overlays the title there in CSS.
- Warm cream kraft-paper ground with visible fiber / tooth.
- Hand-drawn linework feel (pen nib, woodcut, charcoal) — never digital-crisp.
- Two-ink look: warm charcoal line + one flat spot color with visible Riso misregistration.
- **No typography. No labels, numbers, logos, or letterforms anywhere.**

**Varies per book:**

- The central metaphor (lockbox, serpent, gear assembly, mycelium, phonograph…).
- The spot color, chosen by language (below).
- Diagram mode (pinned specimen, cross-section, exploded view, botanical plate).

## 3. Palette

**Core (every cover):**

| Role  | Hex       | Note                         |
| ----- | --------- | ---------------------------- |
| Paper | `#F2E8D5` | Warm cream, kraft-adjacent   |
| Ink   | `#2B2420` | Warm charcoal, never pure black |

**Language → spot color:**

| Languages                              | Spot          | Hex       |
| -------------------------------------- | ------------- | --------- |
| `javascript`, `java`                   | Mustard       | `#D9A74A` |
| `typescript`, `csharp`, `threejs`      | Federal blue  | `#3B5A8C` |
| `python`, `go`, `reactnative`, `vyper` | Seafoam       | `#3F8A7C` |
| `rust`, `swift`, `web`                 | Oxblood       | `#9C3B3A` |
| `c`, `cpp`, `kotlin`, `solidity`       | Aubergine     | `#6B4F7A` |
| `assembly`                             | Monochrome ink (no spot) | `#2B2420` |

## 4. Prompt template

Paste into Lovart; substitute `{title}`, `{language}`, `{topic}`, `{spot_hex}`, and the chosen `{metaphor}`:

> A 1960s Risograph-printed scientific illustration on cream kraft paper (`#F2E8D5`, visible fiber tooth). Hand-drawn linework in warm charcoal ink (`#2B2420`) layered with a single flat spot color of {spot_hex}, with characteristic Riso misregistration (color offset 1–2mm from line drawings) and mottled ink flats. A central specimen — {metaphor} — occupies the upper two-thirds of a 2:3 portrait frame; the lower third is empty cream paper. The subject is a symbolic specimen-rendering of {topic}, expressed through skeletal / structural metaphor (bones, vertebrae, gears, mycelium, phonograph cranks, wiring diagrams) — never a literal coding scene. Ernst Haeckel meets Whole Earth Catalog. Warm, slightly imperfect, community-printshop quality.
>
> Subject: "{title}" — a technical book on {language} programming.
>
> **Exclude:** any text, letterforms, typography, labels, logos, numbers; photorealism, 3D rendering, smooth digital gradients, glossy surfaces, AI-smooth geometry; pure-white backgrounds.

## 5. Example filled prompts

**The Rust Programming Language** — `rust` / oxblood `#9C3B3A` / topic: _memory ownership & borrowing_
> Central specimen: a cross-section of an ornate iron lockbox, chains uncoiling from it, each link drawn in exploded-diagram form as if pinned to the paper, with delicate hatching on the keyholes.

**Eloquent JavaScript** — `javascript` / mustard `#D9A74A` / topic: _functions, closures, async flow_
> Central specimen: a Victorian phonograph cylinder with its mechanism exposed — cranks, escapements, and coiled mainsprings laid open in cross-section like a mechanical watch plate.

**Python Cookbook** — `python` / seafoam `#3F8A7C` / topic: _iterators, generators, decorators_
> Central specimen: a coiled serpent in a botanical dissection jar, vertebrae individually articulated, rendered as a 19th-century natural-history plate with tendril-like connective lines.

**Programming in Go** — `go` / seafoam `#3F8A7C` / topic: _goroutines & channels_
> Central specimen: exploded view of an antique pneumatic-tube switchboard, capsules mid-transit through segmented brass tubing, arranged like a botanical diagram of a many-stemmed plant.

**Assembly Language Step-by-Step** — `assembly` / monochrome / topic: _registers & the instruction cycle_
> Central specimen: skeletal cross-section of a mechanical calculator's carriage — teeth, pins, and escapements — rendered in single-ink charcoal on cream paper, no spot color, all structure no flesh.

**Vyper Fundamentals** — `vyper` / seafoam `#3F8A7C` / topic: _audit-readable smart contracts on Ethereum_
> Central specimen: an articulated snake skeleton coiled into a chain — each vertebra a hexagonal cell, the spine forming a blockchain of bones — pinned to the cream paper as a 19th-century natural-history plate. Hexagonal hatching at the joints suggests honeycomb lattice; the skull is closed-mouthed, contemplative, audit-deliberate. No fangs visible, no aggression — Vyper is the safer-than-Solidity sibling, so the specimen reads as scholarly rather than venomous.
