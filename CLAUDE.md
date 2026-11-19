# MongBoard — notes for AI agents

Desktop MongoDB client (Tauri 2 + React/TS + official `mongodb` Rust crate). The owner does not write code; agents make all changes. Keep things simple and tested.

## Rules
- Every window loads the same bundle; `?view=manager|editor|browser` in `src/main.tsx` picks the screen. Windows are created in Rust (`commands.rs::focus_or_build`).
- All database access goes through `src-tauri/src/mongo.rs`. The UI never builds BSON: it sends shell-JSON text, Rust parses it with `shell_json.rs`.
- Passwords only in the keychain (`secrets.rs`). Never write secrets to `connections.json` or logs.
- Writes must go through `commands::writable()` (read-only profiles). Production confirmation is in the UI (`DocPanel`).
- Number convention in shell JSON: integer literal → Int32 (or Int64 if large), decimal → Double, `NumberLong(…)` → Int64. Keep the writer/parser round-trip test green.
- Colours are CSS variables in `src/styles.css` with a `prefers-color-scheme: dark` block; don't hard-code colours in components.

## Checks before committing
```sh
npm run build                       # tsc + vite
cd src-tauri && cargo test          # unit tests
MONGODB_URI=… cargo test -- --include-ignored   # CRUD integration (CI runs this with a mongo:8 service)
```
