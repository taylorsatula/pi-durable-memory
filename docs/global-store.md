# Global (shared) memory stores

pi-durable-memory can read from an additional SQLite database, the **global** store, alongside the
user's **local** store. This lets teams or organizations share a corpus of memories that every
member draws on, while each user still writes privately to their own local store.

## How it works

- Two stores: `local` (always present, writable) and `global` (optional, readable + annotatable).
- `surface` queries both and merges the top results.
- `create`, `edit`, `delete`, and `vote` always target `local`.
## Configuration

Set the global store location. Either in `~/.pi/agent/durable-memory/config.json`:

```json
{
  "globalStoreDir": "/shared/pi-durable-memory",
  "globalEncrypted": false
}
```

or via environment variables:

```sh
export DURABLE_MEMORY_GLOBAL_DIR=/shared/pi-durable-memory
export DURABLE_MEMORY_GLOBAL_ENCRYPTED=false
```

Only `local` is created by default. The global directory must already exist and contain a
`memory.db` (and `memory.key` if encrypted). Use the seed script to create one.

## Seeding a global corpus

Run the standalone seeder:

```sh
node scripts/seed-global.mjs --dir /shared/pi-durable-memory --file corpus.txt
```

Each non-empty line of `corpus.txt` becomes one memory. The seeder embeds and stores them in
the global database using the configured endpoint/model, so the global store's embedder meta
matches what clients expect.

## Encryption

Global stores may be encrypted with a shared key (`memory.key`) distributed out of band, or
left unencrypted for broad read access. The choice is a deployment decision; the extension
treats both uniformly.
