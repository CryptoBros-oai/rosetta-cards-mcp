# Demo: Quick verification

This example shows the minimal steps to create sample artifacts and inspect
them locally.

Run the demo script:

```bash
bash examples/run_demo.sh
```

What it does:

- Installs dependencies (`npm ci`)
- Runs the `scripts/seed.ts` seeding script to create sample docs, cards, and a
  behavior pack
- Lists `data/cards`, `data/blobs`, and `data/text` to verify artifacts were
  created

After the demo, you can run `npm run tui` to open the textual UI.
