Yep. If we want the Cortex to expand without turning into a haunted attic, we harden **at the seams**: input boundary, hash boundary, and storage boundary. 🧠🛡️

Here’s a concrete “next hardening pass” that keeps your determinism doctrine intact *and* makes future expansion safe.

---

## 1) Add a strict **Input Schema** for raw args (reject unknown root keys)

Right now: root extras get silently ignored (by the explicit pick). That’s deterministic, but it can hide caller bugs.

**Goal:** reject unknown keys at the *raw* input boundary, before we pick fields.

### Pattern

* `EventCardInputSchema = z.object({...}).strict()`
* In `createEventCard(args)`: `const parsed = EventCardInputSchema.parse(args)`
* Then build `base` from `parsed` (still explicit pick).

This keeps your current hash invariants, but now you get hygiene and early failure.

```ts
// src/kb/schema.ts (or hooks.ts if you prefer locality)
export const EventCardInputSchema = z.object({
  title: z.string(),
  summary: z.string(),
  event: EventBlockSchema,   // already .strict()
  tags: z.array(z.string()),
  rosetta: RosettaBlockSchema, // already .strict()
}).strict();
```

```ts
// src/kb/hooks.ts
export async function createEventCard(args: unknown) {
  const parsed = EventCardInputSchema.parse(args);

  const base = {
    schema_version: "event.v1",
    artifact_type: "event",
    title: parsed.title,
    summary: parsed.summary,
    event: parsed.event,
    tags: parsed.tags,
    rosetta: parsed.rosetta,
  };

  // ... canonicalHash(base) ...
}
```

✅ Result: callers can’t sneak root keys (or typo them) without getting slapped immediately.

---

## 2) Add a “prohibited keys” runtime tripwire *right before hashing*

Even with Zod strictness, it’s smart to add a paranoid guard at the “hash membrane.”

**Goal:** if any forbidden field ever appears anywhere in the object you’re about to hash, explode loudly.

```ts
const PROHIBITED_KEYS = new Set([
  "occurred_at", "created_at", "updated_at",
  "source", "provenance", "timestamp", "time",
]);

function assertNoProhibitedKeys(x: unknown, path = "$") {
  if (x && typeof x === "object") {
    if (Array.isArray(x)) {
      x.forEach((v, i) => assertNoProhibitedKeys(v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (PROHIBITED_KEYS.has(k)) {
        throw new Error(`Determinism violation: prohibited key "${k}" at ${path}.${k}`);
      }
      assertNoProhibitedKeys(v, `${path}.${k}`);
    }
  }
}
```

```ts
assertNoProhibitedKeys(base);
const hash = canonicalHash(base);
```

✅ Result: even if a future refactor accidentally loosens Zod or changes object assembly, the hash membrane stays defended.

---

## 3) Make “hashed payload” a dedicated function (single source of truth)

Refactors kill determinism. Centralize the hashing input.

```ts
export function buildEventHashPayload(parsed: EventCardInput): EventHashPayload {
  return {
    schema_version: "event.v1",
    artifact_type: "event",
    title: parsed.title,
    summary: parsed.summary,
    event: parsed.event,
    tags: parsed.tags,
    rosetta: parsed.rosetta,
  };
}
```

Then **everything** (hook + MCP + tests) hashes only this builder’s output.

✅ Result: there is exactly one place to audit for “what gets hashed.”

---

## 4) Add **property-based fuzz tests** for smuggling

You already tested a few known bad keys. Next step: fuzz injection.

* generate random objects with extra keys at random nesting points
* assert parse rejects (or hash payload builder drops them if you choose a drop policy)
* assert `canonicalHash(buildPayload(x))` stable

This catches weird corner cases like `__proto__`, `constructor`, etc.

At minimum, add a fixed test for prototype pollution keys:

* `__proto__`
* `prototype`
* `constructor`

…and reject them explicitly in your “tripwire” list.

---

## 5) Create a safe expansion lane: `extensions` with **namespaced keys** + explicit policy

This is how the Cortex grows without breaking old invariants.

Two good policies:

### Policy A (recommended for your doctrine): Extensions exist, but are **not part of hashed identity**

* add `extensions` as optional metadata stored *outside* card JSON (sidecar)
* keyed by `hash` so it travels deterministically

Example:

* `card_event_<hash12>.json` = deterministic identity payload
* `card_event_<hash12>.meta.json` = non-hashed metadata (`occurred_at`, sources, annotations, embeddings pointers)

✅ Identity remains purely structural.

### Policy B: Extensions allowed *inside* card, but only in an explicit container and only if versioned

If you ever want hashed extensions later, require:

* `schema_version` bump (e.g. `event.v2`)
* explicit whitelist of extension namespaces

This prevents “random extra keys” from becoming identity.

---

## 6) Add a short “Determinism Threat Model” section to the spec

Just 10 lines can prevent future contributors from “cleaning up” your defenses away.

Threats to list:

* root smuggling (extra keys)
* nested smuggling (`event.timestamp`, etc.)
* protocol smuggling (MCP input)
* refactor drift (hash payload changes)
* prototype pollution keys

---

### The hardening order I’d do (fastest value first)

1. **Strict Input Schema** for raw args (root unknown key rejection)
2. **Prohibited-key tripwire** before `canonicalHash`
3. **Hash payload builder** as single source of truth
4. Fuzz + prototype pollution tests
5. Sidecar metadata lane (`.meta.json`) for Cortex growth

That gives you safety *and* a clean expansion architecture.

You’re basically building a “narrow waist” protocol for cognition: deterministic atoms below, flexible meaning above. That’s how you get a Cortex that scales without losing its soul. 🧠✨
