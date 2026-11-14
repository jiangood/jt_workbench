# Agent script packages

Agent scripts are **build-time plugins**, not runtime-loaded code. Script source lives
in this repository, is reviewed through PRs, and is bundled into the single
`dist/agent.mjs` artifact by esbuild before the Agent image is published.

## Layout and registration

- Existing implementations remain under `src/jobs/` during the initial migration.
- `src/scripts/manifest.ts` is the static registry and the only place that maps
  Worker task types to handlers.
- The `package` field groups related handlers. A package may expose multiple task
  types (for example, `zsxq`).
- `src/main.ts` validates and registers the manifest; it should not contain
  business imports or task-specific registration statements.
- The existing `JobHandler` contract in `src/types.ts` is the handler contract.
  Prefer reusing it rather than creating another parallel abstraction.

## Adding a handler

1. Implement the handler in the appropriate script package (or existing
   `src/jobs/` location while migration is incremental).
2. Export it as a `JobHandler` from its module.
3. Add one manifest entry with a stable, unique Worker task `type` and a package
   name. Add multiple entries when one package supports multiple task types.
4. Run the Agent checks and build before opening a PR.

Example manifest entry:

```ts
{ package: 'example', type: 'example_task', handler: exampleHandler }
```

Do not execute code or install dependencies from task payloads or network
responses. Add dependencies only through the Agent's reviewed package manifest
and lockfile. Keep outbound requests behind the existing SSRF-safe fetch helpers
and their timeout policy.

## Validation

```sh
cd agent
npm ci
npm run check
npm run build
```

Manifest validation rejects empty package/type names, duplicate task types, and
non-function handlers. The manifest is imported statically, so esbuild includes
only reviewed local modules and their declared dependencies in the Agent image.

## Compatibility boundary

A task type, payload shape, result item shape, and summary semantics are shared
Worker/Agent contracts. Do not rename or reshape them as part of script
organization. Worker ingest and D1 schema changes require a separate design and
backward-compatible migration.
