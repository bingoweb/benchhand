# Benchhand

> **A durable, cross-platform development MCP for people who expect their tools to remember what they were doing.**

![Status](https://img.shields.io/badge/status-pre--alpha-orange)
![Node](https://img.shields.io/badge/node-22%2B-339933)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

Benchhand is what happens when _“it worked until the connection blinked”_ stops being a funny development story.

It is a development MCP platform built around durable state, exact mutations, process ownership, recovery, and boringly explicit contracts. The long-term goal is simple to say and difficult to earn: **be a practical DevSpace alternative that is more reliable, more portable, and easier to trust when the work gets real.**

No magic dust. No “AI-powered” sticker covering a shell script. No success message because a function happened not to throw.

Benchhand is still pre-alpha. The foundations are being built first, because rebuilding the foundation after users arrive is a wonderful way to learn new swear words.

---

## The 30-second version

Benchhand is designed to give an MCP client a development control plane with:

- durable workspaces that survive MCP edge restarts;
- managed Git worktrees without touching a dirty main checkout;
- bounded file read, list, and search operations;
- atomic writes with SHA-256 preconditions;
- deterministic mutations that fail on ambiguity instead of guessing;
- durable operation state and crash reconciliation;
- a stateless MCP edge in front of a durable local daemon;
- first-class Windows, macOS, and Linux semantics;
- future persistent process, terminal, plugin, external-MCP, artifact, and CLI layers.

The philosophy is not “let the tool do anything.”

It is: **let the tool do powerful things, but make the meaning of those things precise.**

---

## Why Benchhand exists

A development MCP becomes much less interesting when it forgets the workspace, loses a long-running process, silently applies a nearby patch, or says “success” while leaving half the side effect behind.

Benchhand treats those as architecture problems, not personality traits.

The project is built around a few stubborn ideas:

1. **Transport state is not application state.** An MCP connection may disappear. Your workspace should not develop amnesia with it.
2. **Mutation is a contract.** If a write or patch cannot prove its preconditions, it should fail with evidence instead of improvising.
3. **Recovery is part of the happy path.** Restarts, stale state, partial side effects, timeouts, and retries are ordinary engineering conditions.
4. **Cross-platform means semantics, not compilation.** “It builds on Windows” is not the same as “it means the same thing on Windows.”
5. **Tests are evidence, not decoration.** Internal tests matter. Independent clients, conformance tools, black-box checks, audits, and failure injection matter too.

That last point is important. A green test suite written by the same codebase that defines the behavior is useful. It is not a character reference.

---

## Current architecture

```text
MCP client
   |
   v
+------------------------+
| Benchhand MCP edge     |   disposable / protocol-facing
+------------------------+
   |
   | OS-local RPC
   v
+------------------------+
| Benchhand daemon       |   durable ownership / orchestration
+------------------------+
   |             |
   |             +--------------------+
   v                                  v
+------------------------+   +------------------------+
| Workspace/filesystem   |   | Operation journal      |
+------------------------+   +------------------------+
   |                                  |
   +----------------+-----------------+
                    v
             +--------------+
             | SQLite state |
             | WAL + FULL   |
             +--------------+
```

The MCP edge is intentionally not the owner of durable development state. It can go away and come back. That is a feature, not an incident report.

---

## What works today

The current local development line has working foundations for:

| Area | Status | Notes |
|---|---|---|
| MCP protocol edge | ✅ Implemented | Modern protocol target plus legacy compatibility path |
| Durable local daemon | ✅ Implemented | OS-local RPC boundary |
| SQLite operation journal | ✅ Implemented | WAL, FULL sync policy, migrations, reconciliation |
| Durable workspace registry | ✅ Implemented | Workspace handles survive daemon restart |
| Managed Git worktrees | ✅ Implemented | Deterministic ownership and dirty-checkout preservation |
| File read/list/search | ✅ Implemented | Bounded, deterministic, symlink-aware |
| Atomic file write | ✅ Implemented | Hash preconditions, atomic commit, conflict reporting |
| Deterministic patch | ✅ Implemented | Exact matching, hash preconditions, no fuzzy mutation |
| Instructions / skills resolver | ⏳ Planned | Next M1 slice |
| Persistent processes / PTY | ⏳ Planned | M2 |
| Structured Git / review | ⏳ Planned | M3 |
| Plugin SDK / host | ⏳ Planned | M4 |
| External MCP bridge | ⏳ Planned | M5 |
| CLI / doctor / artifacts | ⏳ Planned | M7 |
| Public gateway / auth | ⏳ Planned | Later release phase |

**Important:** “Implemented” means implemented on the current development branch and subjected to the project’s local gates. It does **not** mean “stable public API” or “production-ready release.”

---

## No vibes-based mutation

Benchhand does not want to be clever around your source tree.

For state-changing operations, the intended contract is:

- exact preconditions;
- hashes or versions where appropriate;
- deterministic targets;
- atomic commit points;
- explicit conflicts;
- no silent fallback;
- no nearby-line guessing;
- no fuzzy “close enough” patching;
- replay and retry semantics that are stated, not implied;
- duplicate-mutation protection where an operation can be replayed.

If Benchhand cannot prove that a mutation is the one you asked for, the correct result is not creativity.

The correct result is a conflict.

---

## Safety without handcuffs

Benchhand is a development tool. Development tools need power.

The security model is therefore deliberately practical: protect workspace boundaries, ownership, mutation integrity, credentials, and externally exposed surfaces without turning every useful operation into a permission ceremony.

The project prefers:

- exact target validation over blanket denial;
- capability boundaries over arbitrary feature removal;
- explicit high-power operations over hidden escalation;
- reversible operations where possible;
- structured evidence when something is refused.

In other words: **seatbelts, not a car that refuses to leave the garage.**

---

## Cross-platform is a contract

Windows, macOS, and Linux are first-class targets.

The core is not allowed to casually assume Bash, tmux, systemd, launchd, Homebrew, POSIX signals, Unix permissions, Unix paths, or Unix PTYs. Those belong behind platform adapters when they are needed.

The rule is:

> The same Benchhand operation should have the same meaning on Windows, macOS, and Linux, or fail explicitly when a platform cannot provide the required guarantee.

Current development evidence is strongest on macOS. Benchhand will not call itself cross-platform-ready merely because TypeScript compiled three times in CI. Platform-native behavior has to be tested on the platform that claims to support it.

---

## Testing philosophy

Benchhand uses test-first development for behavior changes.

A feature is not considered finished because one happy-path unit test passed. Relevant work is expected to cover failure modes such as stale state, conflicts, concurrency, timeout, daemon restart, hard crash, retry, replay, duplicate mutation, partial side effects, cleanup failure, path edge cases, symlinks/junctions, and platform differences.

Where applicable, completion also requires independent evidence such as:

- official MCP SDK clients;
- MCP Inspector;
- MCP conformance tooling;
- black-box process tests;
- dependency audit and vulnerability scanning;
- SBOM generation;
- license inspection;
- platform-native verification.

The release policy is intentionally unfriendly to the phrase _“works on my machine.”_

---

## Installation

There is no public installer yet.

If somebody tells you to run `npm install -g benchhand` today, they are either from the future or trying to sell you something.

Benchhand will remain on a `0.x` release line until its public contracts, packaging, recovery behavior, and cross-platform gates have earned a stable version.

For contributors working from source:

```bash
npm ci
npm run quality
```

That validates formatting/lint rules, strict TypeScript checks, and the repository test suites. Runtime packaging and the final `benchhand` CLI are later milestones.

---

## Benchhand is not

- a Git replacement;
- a terminal multiplexer wearing an MCP badge;
- a fork of DevSpace;
- a fuzzy patch engine with confidence issues;
- an excuse to trust generated changes without review;
- finished.

The project studies useful ideas from existing development tools, MCP implementations, operating systems, and open-source libraries. The architecture and contracts are Benchhand’s own.

---

## Roadmap

The public roadmap lives in [`ROADMAP.md`](ROADMAP.md).

The short version:

Roadmap sequence: **reliable foundation → filesystem → persistent runtime → structured Git → plugins → external MCP bridge → CLI/artifacts → UI/gateway → cross-platform packaging → long burn-in**

Feature count is not the goal. A smaller feature that survives failure is worth more than a larger feature that needs a motivational speech after every restart.

---

## Contributing

Contributions are welcome once the public repository opens.

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before sending code. The project values small reviewable changes, failing tests before fixes, reproducible bug reports, explicit contracts, and evidence that survives beyond the author’s laptop.

If your pull request contains a clever shortcut, that is fine.

If the shortcut changes the meaning of a mutation under failure, please bring snacks to the review.

---

## Security

Please do not report security vulnerabilities in public issues.

See [`SECURITY.md`](SECURITY.md) for the disclosure process and the project’s current support status.

---

## License

Benchhand is licensed under the **Apache License 2.0**. See [`LICENSE`](LICENSE).

Third-party components remain under their respective licenses. The public release process will maintain a machine-checked dependency and notice inventory.

---

## The name

A bench hand is the person close to the workbench: not the person giving a keynote about the work, but the one helping the work actually get done.

That is the job description here.

Benchhand should be useful enough to disappear into the workflow, reliable enough that you stop thinking about recovery, and predictable enough that when it refuses to do something, you understand exactly why.

That is the standard.
