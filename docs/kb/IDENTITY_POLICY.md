# Identity Policy

## Prime directive
Identity = SHA-256 of canonicalized JSON payload. Nothing else.

Derived outputs never influence identity.

## Artifact hash scopes

### card.v1
- `created_at` IS INCLUDED in the hashed payload.
- `created_at` must be explicitly supplied (or derived deterministically from a source doc timestamp).
- Do not auto-inject timestamps inside hashing routines.

### event.v1
- NO timestamps or provenance inside hashed payload.
Forbidden keys in hashed payload include:
- `occurred_at`, `created_at`, `updated_at`, `timestamp`, `time`
- `source`, `provenance`

These belong in meta sidecars.

### meta.v1
Meta never affects identity. Meta is mutable and merged under defined rules.

### summary.*.v1
Identity is derived from normalized fields + sorted reference hashes.
Reference order must not change the hash.

## Universal prohibitions (all artifacts)
Prototype pollution keys must never reach hashing:
- `__proto__`, `prototype`, `constructor`

## Hash boundary rule
Only schema-validated, `.strict()` payloads may be hashed.
Artifact-specific guards enforce allowed/forbidden keys.

## Test requirements
Each artifact type must have:
- deterministic double-run hash test
- negative tests for prohibited keys
- proto pollution tests
- rebuildability tests where applicable

## When model-hopping
If uncertain:
1) do not widen hash scope
2) do not mix meta into identity
3) run tests before pushing