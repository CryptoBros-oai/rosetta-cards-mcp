import type { OpcodeSpec, VmState, VmVerb } from "./vm_types.js";

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

const registry = new Map<string, OpcodeSpec>();

function register(spec: OpcodeSpec): void {
  if (registry.has(spec.opcode_id)) {
    throw new Error(`Duplicate opcode_id: ${spec.opcode_id}`);
  }
  registry.set(spec.opcode_id, spec);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getOpcode(opcode_id: string): OpcodeSpec | undefined {
  return registry.get(opcode_id);
}

export function listOpcodes(): OpcodeSpec[] {
  return [...registry.values()].sort((a, b) =>
    a.opcode_id.localeCompare(b.opcode_id),
  );
}

export function listOpcodesByVerb(verb: VmVerb): OpcodeSpec[] {
  return listOpcodes().filter((s) => s.verb === verb);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireBag(state: VmState, name: string): string | null {
  if (!(name in state.bags)) return `bag "${name}" does not exist`;
  return null;
}

function parseBagsList(s: string): string[] {
  return s
    .split(",")
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

// ===========================================================================
// ATTRACT family (4 opcodes)
// ===========================================================================

register({
  opcode_id: "attract.add",
  verb: "Attract",
  description: "Add amount to a bag (creates bag if missing)",
  required_args: ["bag", "amount"],
  precondition: (_state, args) => {
    if (typeof args.amount !== "number" || args.amount < 0)
      return "amount must be >= 0";
    return null;
  },
  reduce: (state, args) => {
    const bag = String(args.bag);
    const amount = Number(args.amount);
    return {
      ...state,
      bags: { ...state.bags, [bag]: (state.bags[bag] ?? 0) + amount },
    };
  },
});

register({
  opcode_id: "attract.collect",
  verb: "Attract",
  description: "Sum multiple bags into a target, delete source bags",
  required_args: ["sources", "target"],
  precondition: (state, args) => {
    const sources = parseBagsList(String(args.sources));
    if (sources.length === 0) return "sources must be non-empty";
    for (const s of sources) {
      const err = requireBag(state, s);
      if (err) return err;
    }
    return null;
  },
  reduce: (state, args) => {
    const sources = parseBagsList(String(args.sources));
    const target = String(args.target);
    const sum = sources.reduce((acc, s) => acc + (state.bags[s] ?? 0), 0);
    const newBags = { ...state.bags };
    for (const s of sources) {
      delete newBags[s];
    }
    newBags[target] = (newBags[target] ?? 0) + sum;
    return { ...state, bags: newBags };
  },
});

register({
  opcode_id: "attract.select",
  verb: "Attract",
  description: "Pick a bag by RNG from a list of candidates",
  required_args: ["candidates", "into"],
  precondition: (state, args) => {
    const candidates = parseBagsList(String(args.candidates));
    if (candidates.length === 0) return "candidates must be non-empty";
    for (const c of candidates) {
      const err = requireBag(state, c);
      if (err) return err;
    }
    return null;
  },
  reduce: (state, args, _env, rng) => {
    const candidates = parseBagsList(String(args.candidates));
    const into = String(args.into);
    const idx = Math.floor(rng() * candidates.length);
    const chosen = candidates[idx];
    return {
      ...state,
      bags: { ...state.bags, [into]: state.bags[chosen] ?? 0 },
      notes: [
        ...state.notes,
        `selected "${chosen}" (index ${idx}) into "${into}"`,
      ],
    };
  },
});

register({
  opcode_id: "attract.increment",
  verb: "Attract",
  description: "Increment a bag by 1",
  required_args: ["bag"],
  precondition: (state, args) => requireBag(state, String(args.bag)),
  reduce: (state, args) => {
    const bag = String(args.bag);
    return {
      ...state,
      bags: { ...state.bags, [bag]: state.bags[bag] + 1 },
    };
  },
});

// ===========================================================================
// CONTAIN family (5 opcodes)
// ===========================================================================

register({
  opcode_id: "contain.threshold",
  verb: "Contain",
  description: "Set flag if bag >= threshold",
  required_args: ["bag", "threshold", "flag"],
  precondition: (state, args) => requireBag(state, String(args.bag)),
  reduce: (state, args) => ({
    ...state,
    flags: {
      ...state.flags,
      [String(args.flag)]:
        state.bags[String(args.bag)] >= Number(args.threshold),
    },
  }),
});

register({
  opcode_id: "contain.clamp",
  verb: "Contain",
  description: "Clamp bag to [min, max]",
  required_args: ["bag", "min", "max"],
  precondition: (state, args) => {
    const err = requireBag(state, String(args.bag));
    if (err) return err;
    if (Number(args.min) > Number(args.max)) return "min must be <= max";
    return null;
  },
  reduce: (state, args) => {
    const val = state.bags[String(args.bag)];
    const clamped = Math.max(Number(args.min), Math.min(Number(args.max), val));
    return { ...state, bags: { ...state.bags, [String(args.bag)]: clamped } };
  },
});

register({
  opcode_id: "contain.normalize",
  verb: "Contain",
  description:
    "Redistribute bags proportionally to sum to target (largest-remainder method)",
  required_args: ["bags_list", "target"],
  precondition: (state, args) => {
    const bags = parseBagsList(String(args.bags_list));
    if (bags.length === 0) return "bags_list must be non-empty";
    for (const b of bags) {
      if (!(b in state.bags)) return `bag "${b}" does not exist`;
    }
    const sum = bags.reduce((a, b) => a + (state.bags[b] ?? 0), 0);
    if (sum === 0) return "cannot normalize: sum is zero";
    return null;
  },
  reduce: (state, args) => {
    const bagNames = parseBagsList(String(args.bags_list));
    const target = Number(args.target);
    const sum = bagNames.reduce((a, b) => a + (state.bags[b] ?? 0), 0);
    const newBags = { ...state.bags };

    // Proportional redistribution with largest-remainder method
    const ratios = bagNames.map((b) => (state.bags[b] ?? 0) / sum);
    const floors = ratios.map((r) => Math.floor(r * target));
    let remainder = target - floors.reduce((a, b) => a + b, 0);

    // Distribute remainder by largest fractional parts (deterministic tiebreak by name)
    const fractionals = ratios
      .map((r, i) => ({
        i,
        frac: r * target - floors[i],
        name: bagNames[i],
      }))
      .sort((a, b) => b.frac - a.frac || a.name.localeCompare(b.name));

    for (let j = 0; j < remainder; j++) {
      floors[fractionals[j].i] += 1;
    }

    for (let i = 0; i < bagNames.length; i++) {
      newBags[bagNames[i]] = floors[i];
    }
    return { ...state, bags: newBags };
  },
});

register({
  opcode_id: "contain.bind",
  verb: "Contain",
  description: "Set a flag to a literal boolean",
  required_args: ["flag", "value"],
  reduce: (state, args) => ({
    ...state,
    flags: { ...state.flags, [String(args.flag)]: Boolean(args.value) },
  }),
});

register({
  opcode_id: "contain.commit_to_stack",
  verb: "Contain",
  description: "Push bag value onto stack, zero the bag",
  required_args: ["bag"],
  precondition: (state, args) => requireBag(state, String(args.bag)),
  reduce: (state, args) => {
    const bag = String(args.bag);
    return {
      ...state,
      bags: { ...state.bags, [bag]: 0 },
      stack: [...state.stack, state.bags[bag]],
    };
  },
});

register({
  opcode_id: "contain.env_threshold",
  verb: "Contain",
  description: "Set flag if bag >= env.params[threshold_key]",
  required_args: ["bag", "threshold_key", "flag"],
  precondition: (state, args) => requireBag(state, String(args.bag)),
  reduce: (state, args, env) => ({
    ...state,
    flags: {
      ...state.flags,
      [String(args.flag)]:
        state.bags[String(args.bag)] >=
        Number(env.params?.[String(args.threshold_key)] ?? 0),
    },
  }),
});

// ===========================================================================
// RELEASE family (4 opcodes)
// ===========================================================================

register({
  opcode_id: "release.decrement",
  verb: "Release",
  description: "Decrement a bag by amount",
  required_args: ["bag", "amount"],
  precondition: (state, args) => {
    const err = requireBag(state, String(args.bag));
    if (err) return err;
    if (state.bags[String(args.bag)] < Number(args.amount))
      return `bag "${String(args.bag)}" has ${state.bags[String(args.bag)]}, need ${Number(args.amount)}`;
    return null;
  },
  reduce: (state, args) => {
    const bag = String(args.bag);
    return {
      ...state,
      bags: { ...state.bags, [bag]: state.bags[bag] - Number(args.amount) },
    };
  },
});

register({
  opcode_id: "release.emit",
  verb: "Release",
  description: "Append a note string",
  required_args: ["message"],
  reduce: (state, args) => ({
    ...state,
    notes: [...state.notes, String(args.message)],
  }),
});

register({
  opcode_id: "release.finalize",
  verb: "Release",
  description: "Pop stack into a bag",
  required_args: ["bag"],
  precondition: (state) => {
    if (state.stack.length === 0) return "stack is empty";
    return null;
  },
  reduce: (state, args) => {
    const bag = String(args.bag);
    const newStack = [...state.stack];
    const val = newStack.pop();
    return {
      ...state,
      bags: { ...state.bags, [bag]: Number(val) },
      stack: newStack,
    };
  },
});

register({
  opcode_id: "release.export",
  verb: "Release",
  description: "Copy bag value to notes and zero it",
  required_args: ["bag"],
  precondition: (state, args) => requireBag(state, String(args.bag)),
  reduce: (state, args) => {
    const bag = String(args.bag);
    const val = state.bags[bag];
    return {
      ...state,
      bags: { ...state.bags, [bag]: 0 },
      notes: [...state.notes, `export:${bag}=${val}`],
    };
  },
});

// ===========================================================================
// REPEL family (3 opcodes)
// ===========================================================================

register({
  opcode_id: "repel.filter",
  verb: "Repel",
  description: "Zero out bags below a threshold",
  required_args: ["threshold", "bags_list"],
  precondition: (state, args) => {
    const bags = parseBagsList(String(args.bags_list));
    for (const b of bags) {
      const err = requireBag(state, b);
      if (err) return err;
    }
    return null;
  },
  reduce: (state, args) => {
    const threshold = Number(args.threshold);
    const bags = parseBagsList(String(args.bags_list));
    const newBags = { ...state.bags };
    for (const b of bags) {
      if ((newBags[b] ?? 0) < threshold) {
        newBags[b] = 0;
      }
    }
    return { ...state, bags: newBags };
  },
});

register({
  opcode_id: "repel.reject",
  verb: "Repel",
  description: "If flag is true, halt execution",
  required_args: ["flag", "reason"],
  precondition: (state, args) => {
    if (state.flags[String(args.flag)]) return String(args.reason);
    return null;
  },
  reduce: (state) => state,
});

register({
  opcode_id: "repel.guard",
  verb: "Repel",
  description: "If bag < min, halt execution",
  required_args: ["bag", "min", "reason"],
  precondition: (state, args) => {
    const bag = String(args.bag);
    if (!(bag in state.bags)) return `bag "${bag}" does not exist`;
    if (state.bags[bag] < Number(args.min)) return String(args.reason);
    return null;
  },
  reduce: (state) => state,
});

// ===========================================================================
// TRANSFORM family (3 opcodes)
// ===========================================================================

register({
  opcode_id: "transform.convert",
  verb: "Transform",
  description: "Move amount from source bag to dest bag",
  required_args: ["source", "dest", "amount"],
  precondition: (state, args) => {
    const err = requireBag(state, String(args.source));
    if (err) return err;
    if (state.bags[String(args.source)] < Number(args.amount))
      return `bag "${String(args.source)}" has ${state.bags[String(args.source)]}, need ${Number(args.amount)}`;
    return null;
  },
  reduce: (state, args) => {
    const source = String(args.source);
    const dest = String(args.dest);
    const amount = Number(args.amount);
    return {
      ...state,
      bags: {
        ...state.bags,
        [source]: state.bags[source] - amount,
        [dest]: (state.bags[dest] ?? 0) + amount,
      },
    };
  },
});

register({
  opcode_id: "transform.derive",
  verb: "Transform",
  description:
    'Compute dest = f(source) where f is "multiply" or "divide" with param',
  required_args: ["source", "dest", "fn", "param"],
  precondition: (state, args) => {
    const err = requireBag(state, String(args.source));
    if (err) return err;
    const fn = String(args.fn);
    if (fn !== "multiply" && fn !== "divide")
      return `fn must be "multiply" or "divide", got "${fn}"`;
    if (fn === "divide" && Number(args.param) === 0)
      return "cannot divide by zero";
    return null;
  },
  reduce: (state, args) => {
    const source = String(args.source);
    const dest = String(args.dest);
    const fn = String(args.fn);
    const param = Number(args.param);
    const srcVal = state.bags[source];
    const result =
      fn === "multiply" ? srcVal * param : Math.floor(srcVal / param);
    return {
      ...state,
      bags: { ...state.bags, [dest]: result },
    };
  },
});

register({
  opcode_id: "transform.compose",
  verb: "Transform",
  description: "Merge two bags into one via addition",
  required_args: ["a", "b", "into"],
  precondition: (state, args) => {
    const errA = requireBag(state, String(args.a));
    if (errA) return errA;
    const errB = requireBag(state, String(args.b));
    if (errB) return errB;
    return null;
  },
  reduce: (state, args) => {
    const a = String(args.a);
    const b = String(args.b);
    const into = String(args.into);
    const sum = (state.bags[a] ?? 0) + (state.bags[b] ?? 0);
    const newBags = { ...state.bags };
    delete newBags[a];
    delete newBags[b];
    newBags[into] = sum;
    return { ...state, bags: newBags };
  },
});
