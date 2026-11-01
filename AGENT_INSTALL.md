# Agent Installation Protocol (`deckseb`)

If a user asked you (an AI coding agent) to install or set up `deckseb`:

> [!NOTE]
> `deckseb` is the **100% optional** desktop mission control station, PTY terminal hub, and passive telemetry viewer for the `*seb` ecosystem ([`hubseb`](../hubseb), [`crewseb`](../crewseb), [`memoseb`](../memoseb)). All CLI tools and agent subroutines function completely without it.

---

## Option A: Install via npm (Recommended)

```sh
npm install -g deckseb
deckseb setup
```

---

## Option B: Install from Source (Local Development)

### 1. Ensure `hubseb` is built first
If `../hubseb` exists locally, ensure it is built:
```sh
cd ../hubseb && npm install && npm run build && cd ../deckseb
```

### 2. Install dependencies, compile TypeScript, and run test suite
```sh
npm install
npm run build
npm test
```

### 3. Verify native Rust backend test suite
```sh
cd src-tauri && cargo test && cd ..
```

### 4. Link CLI and register `deckseb` in `hubseb` topology
```sh
chmod +x dist/cli/deckseb.js
ln -sf "$(pwd)/dist/cli/deckseb.js" ~/.local/bin/deckseb
deckseb setup
```

### 5. Verify Ecosystem Status and Connection with `hubseb`
```sh
deckseb status
hubseb ls
hubseb doctor
```

---

## Complete Verification Suite

To verify full health across frontend, integration bridges, and native Rust backend:

```sh
npm run typecheck && npm test && (cd src-tauri && cargo test)
```

---

## (Optional) Disconnect / Unlink

Because `deckseb` is a non-blocking leaf node (`ui.deck`), you can disconnect it from `hubseb` at any time without affecting any other tools:

```sh
deckseb purge
```
