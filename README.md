# Goslynk Booster

Latency reducer: game traffic goes through a Linux VPS relay. Client is **Rust** (TUN/route)
with a **Tauri + React** UI.

## Layout

```
client-rs/     Rust crates + Tauri app (macOS / Windows)
relay/         Go relayd for Linux VPS
backend/       Accounts API (Node.js + MySQL)
profiles/      Game IP ranges (JSON), compiled into the app
testdata/      Protocol golden vectors
docs/          Protocol & architecture
```

## Client (Tauri)

Pre-fill the relay (optional). Create `client-rs/gpb-app/src-tauri/relay.local.json`; it is
gitignored because it holds the PSK:

```json
{
  "endpoint": "203.0.113.10:51820",
  "psk": "PASTE-THE-PSK-FROM-THE-VPS-HERE"
}
```

The tunnel needs elevated rights on every OS.

**Windows** (PowerShell as Administrator):

```powershell
cd client-rs\gpb-app
npm install
npm run dev            # fetches wintun.dll into src-tauri\wintun\ first
npm run tauri:build    # installer; the exe asks for Administrator
```

**macOS**:

```bash
cd client-rs/gpb-app
npm install
npm run tauri:build
sudo "../target/release/bundle/macos/Goslynk Booster.app/Contents/MacOS/gpb-app"
```

Players sign in with a Goslynk account; the app gets the relay endpoint and PSK from the API
after login. Accounts with the `admin` role get a **Quản trị** screen in the app (developer mode,
roles, locks, relay, history). To point a dev build at a local API:
`VITE_API_BASE=http://127.0.0.1:8787/api npm run dev`.

GitHub Actions builds both installers on every push to `main` (workflow **Build apps**); download
them from the run's artifacts, or from the release when a `v*` tag is pushed.

### Profiles

Game ranges live in `profiles/*.json` and are compiled into the app. To change them without
rebuilding, put a file named `<game id>.json` (`lol`, `tft`, `pubg`, `valorant`, `cs2`,
`naraka`, `deltaforce`) in `<app data>/profiles/`:

- Windows: `%APPDATA%\com.goslynk.booster\profiles\`
- macOS: `~/Library/Application Support/com.goslynk.booster/profiles/`

Only route regions close to the relay. A region with `"defaultOn": false` (a server far from
the relay, e.g. Naraka Tokyo or Delta Force Hong Kong from Singapore) stays unticked until the
player asks for it.

### Daemon (CLI)

Create `client-rs/gpb-mac.json` (or `gpb-win.json`, both gitignored):

```json
{
  "profilePath": "../profiles/lol-vn.json",
  "psk": "PASTE-THE-PSK-FROM-THE-VPS-HERE",
  "relayEndpoint": "203.0.113.10:51820",
  "defaultGameId": "lol",
  "regionIds": ["vn"],
  "clientIdPath": "gpb-client-id",
  "adapterName": "Goslynk Booster",
  "routeWithoutGame": true
}
```

```bash
cd client-rs
cargo build --release -p gpb-daemon
sudo ./target/release/gpb-daemon connect --config gpb-mac.json
```

## Relay (Linux VPS)

Create `gpb.conf` in the repository root (gitignored):

```sh
RELAY_SG_HOST=203.0.113.10
RELAY_SG_USER=root
RELAY_SG_PORT=22
RELAY_SG_KEY=~/.ssh/id_ed25519
RELAY_SG_LISTEN=51820
RELAY_SG_MODE=psk
RELAY_DEFAULT=sg
```

```bash
cd relay
make build
make deploy HOST=root@YOUR_VPS_IP
```

See [relay/README.md](relay/README.md).

## Tests

```bash
cd client-rs && cargo test
cd relay && make test
```

## License

Proprietary, © Goslynk LLC. See [LICENSE](LICENSE).
