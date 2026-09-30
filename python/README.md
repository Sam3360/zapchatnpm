# zapchat (Python)

**Terminal-native LAN chat. No accounts, no cloud, no servers — just your
local network.**

This is the Python distribution of [zapchat](https://github.com/Sam3360/zapchatnpm).
It speaks the same discovery protocol as the Node.js version, so a Python user
and an npm user on the same Wi-Fi can chat with each other.

> Since zapchat 6.0 the Python client runs the same **encrypted** wire
> protocol v2 as the Node.js client: ephemeral X25519 key exchange, all TCP
> frames sealed with AES-256-GCM, handshakes signed by a long-term Ed25519
> identity key with TOFU pinning. Cross-stack chat needs **no flags** on
> either side. The only dependency this adds is `cryptography`. Links to
> genuinely old peers (zapchat ≤ 5 Python clients) stay possible but remain
> opt-in plaintext on both stacks: run with `--allow-plaintext` to accept
> them (the link is then unencrypted v1 and `/status` says so).

## Install

```bash
pip install zapchat
```

## Run

```bash
zapchat
```

That is it. Everyone on the same network who runs `zapchat` shows up
automatically, and you can start chatting.

```
zapchat 6.0.0 — LAN chat, no accounts, no server
  you are sam on #general (tcp:45913)
  waiting for people on this network... (ctrl+c to quit, /help)
* alex connected
10:24 alex: morning all
10:25 sam: morning! which room are we using today?
```

## Commands

| Command | What it does |
| --- | --- |
| `/help` | Show the command list |
| `Tab` | Complete `/commands`, `@usernames` and `#rooms` while typing (readline; POSIX shells and most terminals) |
| `/rooms` | Rooms discovered on the LAN |
| `/users` `/who` | Who is on the LAN and connected |
| `/join <room>` | Join a room (created if nobody is in it) |
| `/name <username>` | Change your display name |
| `/me <action>` | Send an action message: `/me waves` → `* sam waves` |
| `/connect <ip[:port]>` | Connect straight to a peer when discovery is blocked |
| `/status` | Discovery state, ports, peers |
| `/quit` | Exit |

## How it works

- Every instance sends a small UDP beacon (multicast + subnet broadcast)
  announcing its username, room and TCP port — in both wire versions, so
  pre-6.0 peers are still discovered.
- Beacons are how instances find each other; then they open direct TCP
  connections and run the encrypted protocol v2 handshake (the same one the
  npm client uses) before any message flows.
- Rooms are derived, not stored: a room exists while somebody is in it.
- There is no server of any kind. If the LAN works, zapchat works.

Works with the npm version of zapchat on the same network (same beacons, same
encrypted message protocol, no flags needed either way). Actions (`/me`) use
the same CTCP-style framing as the npm client, so an npm user sees
`* sam waves` exactly like a Python user does.

## Privacy

- No accounts, no telemetry, no cloud: the only network traffic is UDP
  beacons and TCP messages on your local network.
- Config is one small JSON file (your username, a random client id, the last
  room, your identity key and peer key pins). Chat history stays in memory.
- Messages on a link are end-to-end encrypted with AES-256-GCM; peers are
  authenticated by TOFU key pinning, so an impostor with a changed key is
  refused loudly. This protects LAN traffic — it is still not anonymous.
- The exception is an opt-in link to a legacy peer (`--allow-plaintext`):
  that one link is unencrypted and `/status` warns about it.

## Requirements

- Python 3.9+ with the `cryptography` package (installed automatically by pip)
- Windows, macOS, Linux

## License

MIT © Samarth Chugh (Sam3360)
