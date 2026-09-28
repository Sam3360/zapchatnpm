# zapchat

**Install it. Run it. Chat with people on your LAN.**

LAN chat in your terminal. No accounts, no cloud, no servers, no setup. Two
machines on the same Wi-Fi find each other automatically and start talking.

```bash
npm install -g zapchat
zapchat
```

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ zapchat sam                                    ● 1 peer connected  tcp:45913 │
│ #general                                                     2 online · alex │
│ ──────────────────────────────────────────────────────────────────────────── │
│  · you joined #general — nobody else is here yet                             │
│  · alex joined #general                                                      │
│ 23:32 alex  morning all 👋                                                   │
│ 23:32 sam   morning! which room are we using today?                           │
│ 23:32 alex  this one — anyone can join it, nothing to set up                  │
│             on the other machine                                              │
│ ──────────────────────────────────────────────────────────────────────────── │
│ › message #general                                                           │
│ enter send · ↑↓ scroll · pgup/pgdn page · esc leave · /help                   │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Why

Sometimes the people you want to talk to are sitting ten metres away, and the
fastest way to send them a line is still... some account, some server, some
invite link. `zapchat` is the smallest thing that fixes that: a terminal app
that discovers other instances on your local network and passes messages
between them. Everything happens on your LAN.

It is a small, focused tool, not a replacement for Discord, Slack or WhatsApp —
and it does not want to be. If you need message history, file sharing, voice or
accounts, use those. `zapchat` is for "we are on the same network right now".

## Requirements

- **Node.js 22 or newer** (`node --version`)
- Two or more machines on the same LAN/Wi-Fi (or one machine, with two terminals)
- Terminal: anything with ANSI colour support — Windows Terminal, PowerShell,
  cmd.exe, iTerm2, GNOME Terminal, kitty, Alacritty, tmux all work

### Python users: `pip install zapchat`

There is also a Python distribution of zapchat that speaks the same discovery
beacons and message protocol, so **Python and npm users on the same Wi-Fi chat
with each other out of the box**:

```bash
pip install zapchat
zapchat            # same idea: name, rooms, /commands, no accounts
```

- The `zapchat` command is installed on your PATH; Python 3.9+ on Windows,
  macOS or Linux, standard library only (zero dependencies).
- Same UDP discovery (multicast + broadcast), same TCP messaging, same rooms.
- Command set is a friendly subset: `/rooms`, `/users`, `/me`, `/join`, `/name`,
  `/connect`, `/status`, `/quit` (see [python/README.md](python/README.md)).
- Line-based plain-text UI — ideal for SSH sessions, tmux and old terminals.
- Wire format note: Python and npm speak the same envelope *shapes*, but the
  npm client's encrypted transport is v2-only (a v1 peer is refused with an
  upgrade notice) — see *Interoperability* below for exactly what works today.

## Installation

```bash
npm install -g zapchat
zapchat
```

Python: `pip install zapchat` (see the section above).

On Windows, the `zapchat` command works in PowerShell, cmd and Windows
Terminal. No shell-specific paths or `/bin/bash` assumptions.

### Interoperability (npm ↔ Python)

> **Status since npm v2:** cross-stack discovery is currently broken. npm's
> discovery parser only accepts its own `v: 2` beacons and stamps its own
> beacons `v: 2`, while the Python client speaks `v: 1` — so the two do not
> see each other's announcements. v5 restores beacon interop (dual-version
> beacons) and adds opt-in plaintext links; see the table for what works.

Chat compatibility is per-link:

| Link | Works today? | Why |
| --- | --- | --- |
| npm ↔ npm | ✅ | Encrypted TCP (protocol v2: X25519 + AES-256-GCM) |
| Python ↔ Python | ✅ | JSON envelopes over TCP (protocol v1) |
| npm ↔ Python | ❌ not yet | npm v2 refuses v1 peers with an upgrade notice; there is no plaintext fallback by design |

> Both stacks keep the same envelope shapes and limits (`HELLO`, `ANNOUNCE`,
> `MESSAGE`, …, same size caps, same sanitisation rules), and actions
> (`/me waves` → `* sam waves`) use the identical CTCP framing on both sides —
> so the remaining gap is only the transport layer, not the messaging format.
> A v1 compatibility mode is on the roadmap; tracking it in
> [issues](https://github.com/Sam3360/zapchatnpm/issues).

## First run

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│                                                                              │
│                            Welcome to zapchat                                │
│                     LAN chat in your terminal — no accounts                  │
│                                                                              │
│                   What should people call you?                               │
│                   › sam_                                                     │
│                                                                              │
│                   ● searching                                                │
│                   enter to continue · ctrl+c to quit                         │
│                                                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Your username is prefilled from your OS account. Press Enter, then pick a room
from the lobby (or type a room name and press Enter to create it).

```text
ROOMS
❯ #general                     3 online
  #coding                      1 online
  #gaming                      empty

ON THE LAN                                              2 peers
  alex                                                  #general
  jay                                                   #coding
```

## Commands

Type `/help` inside the app. Commands run locally — they are never sent to
other people in the room.

| Command | What it does |
| --- | --- |
| `/help` `/h` `/?` | Show the command list |
| `/rooms` | List rooms discovered on the LAN |
| `/users` `/who` | Who is online on the LAN and who is in this room |
| `/join <room>` | Join a room (creates it if nobody is in it) |
| `/create <room>` | Create a room and join it |
| `/leave` | Leave the current room, back to the lobby |
| `/clear` | Clear the local view for this room |
| `/name <username>` | Change your display name |
| `/me <action>` | Send an action message: `/me waves` → `* sam waves` |
| `/connect <host[:port]>` | Connect straight to a peer when discovery is blocked |
| `/status` | Discovery, ports, peers and rejected frames |
| `/quit` `/q` | Exit |

Keyboard: `↑`/`↓` scroll the conversation, `PgUp`/`PgDn` page, `Ctrl+P`/`Ctrl+N`
walk your command history, `Esc` clears the line (and leaves the room when the
line is empty), `Ctrl+C` exits cleanly.

## How LAN discovery works

There is no server and no broker of any kind. Each `zapchat` instance:

1. binds one UDP socket and joins the discovery multicast group
   (`239.255.42.99:45912` by default), also enabling broadcast;
2. every 2 seconds it sends a small signed-shape `ANNOUNCE` beacon (username,
   current room, TCP port) to the multicast group, the subnet broadcast
   addresses and loopback, so several instances work on one machine too;
3. it listens for other beacons, which is how it learns who exists, what rooms
   they are advertising and which TCP port to reach them on;
4. it opens a direct TCP connection to each peer (the client with the
   lexicographically smaller id dials, so two links never fight), and the two
   run an encrypted handshake: both sides exchange HELLO frames carrying a
   signed ephemeral X25519 key exchange, derive one-use AES-256-GCM session
   keys, and then exchange sealed, sequence-numbered frames containing the JSON
   envelopes `HELLO`, `ANNOUNCE`, `ROOM_LIST`, `PEER_LIST`, `JOIN`, `LEAVE`,
   `MESSAGE`, `PING`, `PONG`;
5. messages are delivered to connected peers in the same room, with a
   duplicate-suppressing relay so a message still lands if one peer is not
   directly reachable from another. Every message carries a unique id, and
   clients only ever forward traffic inside the room they are in.

```
                 LAN
                  │
       ┌──────────┼──────────┐
       │          │          │
    Client A   Client B   Client C
       │          │          │
       └── UDP discovery ────┘   multicast + broadcast beacons
       └── TCP mesh ─────────┘   direct links, HELLO + messages
```

**Rooms are derived, not stored.** A room exists while somebody announces it.
There is no room registry to keep in sync, no leader election and no "room
server" — which is why there is nothing to host and nothing to go down.

**If discovery is blocked** (guest Wi-Fi with client isolation, a corporate
network that drops multicast, or a firewall), `zapchat` says so in plain
language instead of failing silently, and you can still connect directly:

```bash
zapchat --connect 192.168.1.24            # default port 45913
# or from inside the app:
/connect 192.168.1.24
```

Connection state is live: peers appear within a few seconds, disappear when they
quit, and reconnect on their own when they come back. `tcp:45913` in the header
is the port this instance is listening on.

## Privacy model

- **No accounts, no cloud, no telemetry.** The app never contacts any server.
  There is no analytics, no crash reporting, no ads, no tracking — and no code
  path that sends chat content anywhere except direct TCP connections to peers
  on your LAN.
- **No database.** Chat history lives in memory only, for the current session,
  and is dropped when you quit. (v1 keeps it simple: nothing is written to disk.)
- **Local config only.** One tiny JSON file holds your username, your client id
  and the last room you visited. Its location:
  - Windows: `%APPDATA%\zapchat\config.json`
  - macOS: `~/Library/Application Support/zapchat/config.json`
  - Linux/BSD: `$XDG_CONFIG_HOME/zapchat/config.json` or `~/.config/zapchat/config.json`
  - anywhere: whatever `ZAPCHAT_CONFIG_DIR` points at
- **Encrypted transport (protocol v2).** Every TCP link runs an ephemeral
  X25519 key exchange; all traffic after the handshake is sealed with
  AES-256-GCM and sequence-numbered so tampering, replay and frame dropping are
  detectable and the connection is dropped. Each install has a long-term
  Ed25519 identity key that signs its handshakes; the first key seen for a peer
  is pinned (TOFU) and a changed key is refused loudly. Keys are derived with
  HKDF and live only for the connection (forward secrecy). This protects
  traffic on your LAN — it is still not anonymous and not a replacement for
  Signal: there is no central authority verifying who anybody "really" is.
- **Internet-free chatting.** With the network cable pulled out but the LAN
  intact, everything still works.

## What the app does with untrusted input

Everything arriving from the network is treated as hostile:

- packets must be valid protocol envelopes; malformed JSON, unknown message
  types, bad ids, out-of-range timestamps and wrong payload shapes are dropped
  and counted (`/status` shows the count);
- frames are capped (8 KiB) and beacons are capped (1100 bytes), and a peer that
  streams bytes without a frame delimiter gets cut off rather than buffered;
- usernames and room names are validated against a strict character set, and
  control characters and ANSI escape sequences are stripped from all incoming
  text so a message can never repaint or corrupt your terminal;
- messages are size-limited, identifiers are unique so duplicates and relayed
  copies are suppressed, and nothing received is ever executed;
- per-peer rate limiting (token bucket) caps incoming MESSAGE floods — a peer
  hammering the room is throttled instead of being able to wash out the screen;
- connections that never complete a `HELLO` handshake are closed, and a peer
  that stops responding mid-stream is dropped.

## Platform support

| Platform | Status |
| --- | --- |
| Windows 10/11 (Windows Terminal, PowerShell, cmd) | Supported and tested |
| macOS (iTerm2, Terminal.app) | Supported |
| Linux/BSD (any ANSI terminal, tmux) | Supported |
| Node.js | 22 or newer |

Windows gets specific care: no `/bin/bash` assumptions, no PowerShell-only
behaviour, no Unix-only paths, and the alternate screen buffer is used to keep
your scrollback intact.

## Command line options

```
zapchat [options]

  -n, --name <username>        display name (remembered between runs)
  -r, --room <room>            join this room on start
  -c, --connect <host[:port]>  connect straight to a peer (default port 45913)
      --discovery-port <port>  UDP discovery port (default 45912)
      --multicast <address>    discovery multicast group (default 239.255.42.99)
      --tcp-port <port>        first TCP port to try (default 45913)
      --no-discovery           share no beacons; manual connections only
      --inline                 render in the normal screen buffer
      --headless               plain text mode: stdin lines are sent, messages print
  -h, --help                   show help
  -v, --version                print the version
```

`--headless` is for scripting and for debugging a network over SSH — same client,
same protocol, no TUI:

```bash
zapchat --headless --name buildbot --room ops
[#ops] sam: deploy finished
```

## Development

```bash
git clone https://github.com/Sam3360/zapchatnpm.git   # https://github.com/Sam3360/zapchatnpm
cd zapchatnpm
npm install
npm run build      # compile TypeScript to dist/
npm test           # unit + integration tests (builds first)
npm start          # run the built CLI
```

Useful scripts:

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile `src/` → `dist/` with `tsc` |
| `npm test` | Build everything and run the full test suite |
| `npm run test:unit` | Protocol, registry, config, commands and view maths only |
| `npm run test:integration` | Real UDP/TCP tests, including two spawned CLI processes |
| `npm run typecheck` | Type-check `src/` and `test/` without emitting |

### Project layout

```
src/
├── cli/          argument parsing, entry point, --headless mode
├── commands/     /command registry and parser (pure, shared by TUI and CLI)
├── config/       local config file, identity, cross-platform paths
├── core/         ZapClient: wires discovery + transport + registry together
├── discovery/    UDP multicast/broadcast beacon + listener
├── network/      TCP mesh transport (HELLO, PING/PONG, framing), interface maths
├── protocol/     envelope types, validation, sanitisers, limits, framing
├── rooms/        presence, room derivation, duplicate suppression, history
└── tui/          Ink components, screens, and pure view maths
test/
├── unit/         protocol, registry, config, commands, line editor, view maths, renders
├── integration/  real sockets: two/three clients, reconnection, spawned CLI processes
└── helpers/      polling waits, snapshot factory
```

The split matters: `rooms/` and `protocol/` are pure logic with no sockets, so
the interesting behaviour (membership, duplicate ids, malformed packets) is
tested directly, and `tui/` renders an immutable snapshot so the UI can never
disagree with the network state.

### Dependencies

Deliberately small, all well maintained:

- [`ink`](https://github.com/vadimdemedes/ink) — the React-based TUI renderer
  (handles terminal resizing, colours, alternate screen and teardown)
- [`react`](https://react.dev) — Ink's renderer
- [`string-width`](https://github.com/sindresorhus/string-width) — correct
  display widths for CJK/emoji, so layout maths matches what terminals draw

Networking uses only Node's built-in `node:dgram`, `node:net` and `node:crypto`.

## Tests

`npm test` runs the whole suite; the integration tests use real sockets rather
than mocks:

- **protocol** — sanitising hostile text, stripping ANSI escapes, envelope
  validation, frame splitting across chunks, oversized-frame rejection,
  duplicate suppression, beacon round-trips and trimming;
- **rooms** — presence, room derivation, membership updates, peers going stale,
  message history limits;
- **config** — first-run creation, config repair after corruption, client id
  stability, path resolution for Windows/macOS/Linux;
- **commands** — parsing, aliases, and every command's behaviour against a real
  client;
- **view maths** — width-aware wrapping/truncation, frame layout, timeline
  building, scrolling, prompt rendering, lobby composition;
- **integration** — two and three real clients discovering each other over UDP
  and exchanging messages over TCP, room scoping, malformed TCP input, a peer
  disappearing and being rediscovered, manual `--connect` links;
- **end-to-end** — two spawned `zapchat --headless` processes chatting in both
  directions, renaming without replaying commands as chat, and reconnecting
  after one is restarted.

## Limitations (v2, stated plainly)

- **Encrypted, but not anonymous or centrally verified.** The v2 protocol
  encrypts every TCP link and detects impostors via TOFU key pinning, but the
  first connection to a new peer is still trust-on-first-use: a man-in-the-middle
  present at *first* contact is not detectable. No certificate authority, no
  QR-code verification, no safety numbers.
- **No history.** Chat history is in memory for the session only; quit and it is
  gone. There is no persistence to disk yet.
- **One room at a time** per instance. You can move between rooms, but you are
  in one at a time.
- **Same subnet only.** Discovery uses multicast/broadcast, so it does not cross
  routers or VLANs. `--connect <ip>` works for a directly reachable peer.
- **Rooms vanish when empty.** A room exists while somebody is in it or
  advertising it; the last person leaving retires it.
- **IPv4 only.** IPv6 discovery and connections are not implemented.
- **No file transfer, voice, threads or reactions** — and none are planned for
  v1. The core experience is the point.
- **No end-to-end verification of identity.** Any device on the LAN that speaks
  the protocol can appear and pick any unused username; a client id identifies a
  running instance, not a person.

## Author and creator

**Samarth Chugh (Sam3360)**

- GitHub: [@Sam3360](https://github.com/Sam3360)
- Repository: [github.com/Sam3360/zapchatnpm](https://github.com/Sam3360/zapchatnpm)
- npm: [zapchat](https://www.npmjs.com/package/zapchat)

## License

[MIT](LICENSE) © Samarth Chugh (Sam3360)
