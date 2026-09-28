# zapchat (Python)

**Terminal-native LAN chat. No accounts, no cloud, no servers — just your
local network.**

This is the Python distribution of [zapchat](https://github.com/Sam3360/zapchatnpm).
It speaks the same discovery protocol as the Node.js version, so a Python user
and an npm user on the same Wi-Fi can chat with each other.

> The Python client runs the proven protocol v1 wire format (JSON envelopes
> over TCP, discovery beacons). The Node.js client's protocol v2 adds
> TLS-style encryption on top of the same envelope shapes. Since zapchat v5
> the stacks see each other's discovery beacons again, and an npm peer that
> runs with `--allow-plaintext` will chat with you over an **unencrypted** v1
> link (the npm side warns loudly about this). npm ↔ npm links stay
> end-to-end encrypted; if the npm user does not opt in, no cross-stack link
> is opened.

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
zapchat 3.0.0 — LAN chat, no accounts, no server
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
  announcing its username, room and TCP port.
- Beacons are how instances find each other; then they open direct TCP
  connections and exchange newline-delimited JSON messages.
- Rooms are derived, not stored: a room exists while somebody is in it.
- There is no server of any kind. If the LAN works, zapchat works.

Works with the npm version of zapchat on the same network (same beacons, same
message protocol). Actions (`/me`) use the same CTCP-style framing as the npm
client, so an npm user sees `* sam waves` exactly like a Python user does.

## Privacy

- No accounts, no telemetry, no cloud: the only network traffic is UDP
  beacons and TCP messages on your local network.
- Config is one small JSON file (your username, a random client id, the last
  room). Chat history stays in memory.
- Messages are plain text on your LAN — anyone who can capture that traffic
  can read it. For sensitive conversations use an encrypted messenger.

## Requirements

- Python 3.9+ (standard library only — zero dependencies)
- Python 3.9+ on any OS: Windows, macOS, Linux

## License

MIT © Samarth Chugh (Sam3360)
