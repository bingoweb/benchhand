# Security Policy

Benchhand is a high-capability development tool. Security reports are taken seriously, especially when they affect mutation integrity, workspace boundaries, process ownership, credentials, or remote exposure.

## Supported versions

Benchhand is currently pre-alpha and has not published a production-supported release.

| Version | Supported for production | Security reports accepted |
|---|---:|---:|
| Development / pre-alpha | No | Yes |

This distinction matters: a report can be valid and important even while the project is not yet claiming production readiness.

## Reporting a vulnerability

**Do not include vulnerability details in a public issue.**

When the public GitHub repository enables Private Vulnerability Reporting, use the repository’s **Report a vulnerability** flow so the report reaches the maintainers privately.

If private reporting is temporarily unavailable, open a public issue containing **no vulnerability details** and ask for the current private security contact method.

Please include, when available:

- affected commit or version;
- platform and runtime;
- clear reproduction steps;
- expected versus observed security boundary;
- impact;
- whether exploitation requires local, workspace, network, or authenticated access;
- a minimal proof of concept that avoids unnecessary destructive effects.

## Areas of particular interest

Reports are especially valuable for issues involving:

- path traversal or workspace escape;
- symlink, junction, or reparse-point boundary bypass;
- incorrect filesystem identity or ownership decisions;
- fuzzy or mis-targeted mutation;
- hash/version precondition bypass;
- replay or duplicate-mutation bugs;
- partial side effects reported as successful;
- process/task ownership confusion;
- privilege boundary bypass;
- credential or secret exposure;
- MCP protocol input causing unintended local action;
- authentication or gateway bypass once remote profiles are introduced;
- unsafe plugin/provider isolation once those subsystems ship.

## What to expect

The maintainers will first try to reproduce and classify the report. Valid issues will be fixed with regression coverage and, where appropriate, independent validation before disclosure.

Benchhand does not currently publish a guaranteed response-time SLA. Pre-alpha should not pretend to have an enterprise security desk wearing matching jackets.

That said, credible reports should receive priority over ordinary feature work.

## Security design philosophy

Benchhand tries to be powerful without being careless.

The project prefers exact preconditions, capability boundaries, deterministic ownership, and explicit high-power operations over broad feature removal or endless confirmation prompts.

The goal is not to make dangerous development work impossible. The goal is to make unintended work difficult to perform silently.
