# Third-Party Notices

Benchhand depends on open-source software. This file records the current direct and transitive **runtime** dependency inventory observed in the development lockfile.

It is not a replacement for the license files shipped by those projects. Release packaging must preserve all notices and license material required by each dependency.

## Runtime dependency inventory

| Package | Version | License |
|---|---:|---|
| `@hono/node-server` | 1.19.17 | MIT |
| `@modelcontextprotocol/core` | 2.0.0 | MIT |
| `@modelcontextprotocol/node` | 2.0.0 | MIT |
| `@modelcontextprotocol/server` | 2.0.0 | MIT |
| `balanced-match` | 4.0.4 | MIT |
| `better-sqlite3` | 13.0.3 | MIT |
| `brace-expansion` | 5.0.9 | MIT |
| `hono` | 4.13.2 | MIT |
| `minimatch` | 10.2.6 | BlueOak-1.0.0 |
| `node-addon-api` | 8.9.2 | MIT |
| `typebox` | 1.3.15 | MIT |
| `yaml` | 2.9.0 | ISC |
| `zod` | 4.4.3 | MIT |

## Development-only dependencies

Development tooling is also open source and remains subject to its own licenses. The lockfile records license metadata for development dependencies such as Biome, TypeScript, `tsx`, Ajv, Node type packages, platform binaries, and their transitive dependencies.

The release process must generate a fresh machine-readable SBOM and license inventory from the exact release lockfile rather than assuming this document is forever current. Dependency drift is normal; stale attribution is not.

## Imported source code

Benchhand does not intentionally treat installed dependencies as copied Benchhand source.

If source code is copied, adapted, vendored, or derived from another project in the future, its origin and license obligations must be documented explicitly in the same change and reflected here when required.
