# Benchhand Roadmap

Benchhand is being built in reliability-first slices. The roadmap is intentionally ordered so later convenience features do not sit on top of fragile state management.

This is a direction document, not a release-date promise.

## M0 — Architecture and contract foundation

Status: **locally complete**

- protocol-era MCP edge;
- durable local daemon boundary;
- OS-local RPC contract;
- SQLite storage adapter and migrations;
- durable operation journal;
- crash/restart reconciliation baseline.

## M1 — Workspace and filesystem core

Status: **in progress**

- durable workspace registry — complete;
- deterministic managed Git worktrees — complete;
- bounded file read/list/search — complete;
- atomic file write — complete;
- deterministic patch — complete;
- instructions and local skills resolver — planned.

## M2 — Persistent process, task, and terminal runtime

Status: **planned**

- process supervisor contract;
- non-PTY persistent processes;
- PTY / ConPTY terminal adapters;
- durable task lifecycle;
- restart reconciliation;
- bounded output and artifact spill.

## M3 — Structured Git and review

Status: **planned**

- status, diff, and log primitives;
- branch/worktree operations;
- explicit commit primitive;
- change sets;
- review checkpoints.

## M4 — Plugin SDK and plugin host

Status: **planned**

- versioned manifest contract;
- discovery and validation;
- isolated worker runtime;
- capability broker;
- tool/resource/prompt contributions;
- collision and dependency resolution;
- staged update and rollback;
- crash-loop circuit breaker.

## M5 — External MCP bridge

Status: **planned**

- provider descriptors;
- legacy and modern client adapters;
- catalogue projection;
- schema and annotation preservation;
- provider health and reconnect semantics;
- discovery refresh.

## M6 — First-party persistent terminal plugin

Status: **planned**

- remote capability mapping;
- durable session/task bindings;
- filesystem and transfer forwarding;
- forwarding/system capability mapping;
- provider restart recovery;
- target-scoped outage isolation.

## M7 — Artifact store and developer UX

Status: **planned**

- artifact metadata and content storage;
- checksums and integrity;
- retention and cleanup;
- `benchhand` CLI foundation;
- doctor bundle;
- config migration.

## M8 — Local UI / MCP Apps UX

Status: **planned**

Operational visibility for workspaces, processes, plugins, health, and recovery without turning the core into a GUI dependency.

## M9 — Gateway, auth, and deployment profiles

Status: **planned**

Profiles for trusted local use, trusted LAN use, and authenticated public/remote use.

## M10 — Cross-platform packaging and public preview

Status: **planned**

- Windows, macOS, and Linux native acceptance;
- installer/package strategy;
- service lifecycle adapters;
- public documentation;
- upgrade and rollback behavior.

## M11 — Performance, burn-in, and 1.0 readiness

Status: **planned**

- long-duration reliability runs;
- restart and crash campaigns;
- load/latency profiling;
- compatibility matrix;
- public API contract review;
- zero known release-critical defect gate.

## What can change

Task boundaries may move as evidence improves the architecture. The engineering principles do not:

- quality over speed;
- deterministic mutation;
- explicit failure;
- durable ownership;
- platform-neutral meaning;
- internal **and** independent validation.
