# Goslynk Booster (Rust + Tauri)

Latency reducer: game traffic goes through a Linux VPS relay. Client is **Rust** (TUN/route)
with a **Tauri + React** UI.

## Layout

```
client-rs/     Rust crates + Tauri app (macOS / Windows)
relay/         Go relayd for Linux VPS
profiles/      Game IP range JSON (*.example.json)
testdata/      Protocol golden vectors
docs/          Protocol & architecture
```

## Client (Tauri)

```bash
cd client-rs/gpb-app
npm install
npm run dev          # opens Tauri window (not the browser)
```

Daemon CLI / crates: [client-rs/README.md](client-rs/README.md).

## Relay (Linux VPS)

```bash
cp gpb.conf.example gpb.conf
# edit HOST / KEY

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
