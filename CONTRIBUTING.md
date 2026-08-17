# Contributing to Benchhand

Thanks for considering a contribution.

Benchhand is trying to become the kind of development tool people trust with real repositories, long-running work, and state that matters. That means contributions are judged less by how impressive the diff looks and more by whether the behavior is precise under failure.

## The first rule

**Evidence beats confidence.**

“This should work” is useful during design.

“Here is the failing test, the fix, the regression test, and the black-box result” is useful during review.

## Development setup

Requirements:

- Node.js 22 or newer within the supported engine range;
- npm;
- Git;
- platform-native tooling needed by the area you are changing.

Install dependencies and run the full local gate:

```bash
npm ci
npm run quality
```

## Development workflow

For behavior changes:

1. Write the smallest test that demonstrates the missing or incorrect behavior.
2. Run it and confirm it fails for the expected reason.
3. Implement the minimum correct behavior.
4. Run the focused tests.
5. Run the relevant regression suite.
6. Run the repository quality gate.
7. Add independent or black-box validation when the change crosses an external contract.

Do not write the implementation and then invent a test that admires it.

## Mutation rules

Code that changes files, Git state, processes, tasks, or durable records receives extra scrutiny.

Prefer:

- exact preconditions;
- immutable identifiers or hashes;
- atomic commit points;
- deterministic target resolution;
- structured conflict evidence;
- explicit retry and idempotency semantics.

Do not introduce:

- fuzzy patch fallback;
- silent target guessing;
- “best effort” mutation that can look successful after a partial side effect;
- hidden destructive cleanup;
- automatic conflict resolution without a contract that makes it safe.

If the operation cannot establish that it is touching the intended state, fail closed.

## Failure cases matter

Depending on the change, test more than the happy path. Relevant cases commonly include:

- stale state;
- concurrent mutation;
- timeout;
- daemon restart;
- hard process termination;
- retry/replay;
- duplicate request;
- partial external side effect;
- cleanup failure;
- symlink, junction, and reparse-point behavior;
- path normalization;
- platform differences.

You do not need to test every item for every three-line change. You do need to think about which failures can change the meaning of the operation.

## External validation

For MCP-facing changes, use independent tooling where applicable: official SDK clients, MCP Inspector, conformance tooling, and black-box invocations.

For dependency changes, include the relevant audit, vulnerability, SBOM, and license checks.

For platform-specific behavior, evidence from the actual platform is preferred over confident comments written on another operating system.

## Pull requests

Keep pull requests small enough to review without archaeology.

A good PR explains:

- the problem;
- the contract being changed or added;
- the RED test or reproduction;
- the implementation;
- the failure modes considered;
- the validation performed;
- any known limitation that remains.

Screenshots are useful for UI work. Logs are useful for runtime work. Assertions are useful for everything.

## Commit messages

Clear, ordinary commit messages are preferred.

Examples:

```text
feat(filesystem): add deterministic patch conflicts
fix(workspace): reject foreign worktree ownership
test(daemon): cover interrupted operation recovery
docs: explain Windows process semantics
```

Please do not turn the commit history into a press release.

## Code style

- Match the existing TypeScript and package boundaries.
- Keep platform-specific behavior behind adapters or narrow seams.
- Prefer small interfaces over global helpers with surprising reach.
- Avoid speculative abstractions.
- Keep error codes stable and machine-usable.
- Comments should explain why the behavior exists, not translate the next line into English.

## Generated and assisted code

Development tools are welcome. Responsibility is not delegated to them.

If a tool generated part of a change, the contributor is still responsible for understanding the code, validating it, respecting licenses, and defending its behavior during review.

Please remove generic filler, fake certainty, and comments that sound like nobody has ever actually debugged the code.

## Documentation tone

Benchhand documentation should be technically serious without sounding like it was approved by seventeen committees.

Be direct. Be specific. Admit limitations. A little humor is welcome when it does not hide important behavior.

## Licensing

By contributing, you agree that your contribution is provided under the repository’s Apache-2.0 license unless explicitly documented otherwise for an imported third-party work.

Do not paste code from another project unless its license is compatible and its origin is documented.
