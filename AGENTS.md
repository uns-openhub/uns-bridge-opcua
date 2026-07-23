# Agent guidance

## Start here

- Read `README.md`, `package.json`, `config.schema.json`, and
  `runtime-config.json.example`.
- Read `src/config/runtime-config.ts` before changing persisted bridge state.
- Read `src/opcua/` before changing discovery, browsing, subscriptions, or
  source-health behavior.
- Keep protocol-agnostic lifecycle behavior in `@uns-kit/bridge-core`.

## Boundaries

- Never commit `config.json`, `.env*`, `runtime-config.json`, credentials,
  certificates, private node mappings, or generated live metadata.
- Require controller JWKS authentication for the management API.
- Keep runtime snapshots at schema version 1 unless a migration is implemented.
- Keep the `unsDatahub` manifest and release tag aligned with `package.json`.

## Verification

Run `pnpm run verify`. If configuration types change, regenerate
`config.schema.json` and `src/config/app-config.ts` first.
