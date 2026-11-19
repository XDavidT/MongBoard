# MongBoard

A desktop MongoDB client for macOS: connection manager, collection browser with a Studio 3T-style tree view, and single-document add / edit / duplicate / delete.

Built with [Tauri 2](https://tauri.app) (Rust backend + React/TypeScript UI) and the **official MongoDB Rust driver**, so it supports username/password (SCRAM) and **AWS IAM** (`MONGODB-AWS`) sign-in.

## What works (v0.1)

- **Connection Manager** (its own window): saved connections grouped by environment tag, new / edit / duplicate / delete, filter, connect.
- **Connection editor** (its own window): connection string (`mongodb://` or `mongodb+srv://`), username + password (stored in the macOS Keychain, never in files), AWS IAM (default credential chain or a named `~/.aws` profile), environment tag, read-only mode, "confirm writes on Production", Test button.
- **Browser window** per connection: databases → collections sidebar, filter / projection / sort / limit, paging, **Tree** and **JSON** views.
- **Documents**: select one document, then Add, Edit (replace by `_id`), Duplicate, or Delete. Read-only connections block writes; Production connections ask for a second confirmation.
- Shell syntax in all inputs: `ObjectId("…")`, `ISODate("…")`, `NumberLong(…)`, `/regex/i`, unquoted keys, Extended JSON (`{"$oid": …}`).
- Light / dark mode follows macOS.

Next: aggregation builder, indexes + stats + explain, import/export, Fields editor tab.

## Install a build

Every push to `main` builds a `.dmg` in GitHub Actions (**Actions → CI → MongBoard-macOS** artifact). The app is not signed yet, so on first launch right-click it → **Open**, or run:

```sh
xattr -dr com.apple.quarantine /Applications/MongBoard.app
```

## Develop

Requirements: Node 22+, Rust (stable), Xcode Command Line Tools on macOS.

```sh
npm install
npm run tauri dev      # run the app with hot reload
npm run tauri build    # build MongBoard.app + .dmg
```

Tests:

```sh
cd src-tauri
cargo test                                                        # unit tests
MONGODB_URI=mongodb://localhost:27017 cargo test -- --include-ignored  # + CRUD against a real server
```

## Layout

| Path | What |
|---|---|
| `src-tauri/src/shell_json.rs` | Parser/writer for mongosh-style JSON (keeps BSON types on round trip) |
| `src-tauri/src/mongo.rs` | Driver calls: connect (SCRAM / AWS IAM), list, find, count, insert/replace/delete |
| `src-tauri/src/profiles.rs` | Saved connections (`connections.json` in the app config folder) |
| `src-tauri/src/secrets.rs` | Keychain access |
| `src-tauri/src/commands.rs` | Commands the UI calls + window management |
| `src/views/` | Connection Manager, Connection editor, Browser |
| `src/components/` | Tree view, document edit panel |
