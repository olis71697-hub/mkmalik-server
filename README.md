# MK Malik — Live Group Voice Chat

A complete, self-hosted live voice room platform. Ten mic seats per room, real
peer-to-peer audio, room chat, gifts, moments, direct messages and a coin
economy — all served from a single Node process you own.

The interface follows the reference design: an **Explore** home with
`Related / Hot / Explore` tabs, a category strip, and a two-column grid of live
room cards showing seat counts, face piles, category tags and how many mics are
still free.

```
┌─────────────────────────────────────┐
│  Related     Hot     Explore ✦   🏆 🔍 ⊕ │
│  Broadcast  Party  Sing  Birthday 2Pᵛ    │
│  ┌──────────┐   ┌──────────┐            │
│  │ 6/10  👥 │   │ 4/10  🔒 │            │
│  │  cover   │   │  cover   │            │
│  │ 🎙 Party │   │ 🎵 Music │            │
│  └──────────┘   └──────────┘            │
│  Share a happy thing 😊                 │
│  🎤 There are 4 seats left              │
│  ─────────────────────────────────────  │
│  Explore  Moments  ⊕  Chat  Profile     │
└─────────────────────────────────────┘
```

---

## The app is live here

**<https://raw.githack.com/olis71697-hub/mkmalik-server/main/public/index.html>**

Open it on a phone and the app runs full-screen; the install bar offers to put
it on the home screen, and Android/Chrome shows the real install prompt.

That address is served straight from this repository by raw.githack, so it is
static and permanent. The live server behind it is **not** on this repository's
host — it runs in the `live public app` workflow, which boots the real Node
server, opens a Cloudflare tunnel, proves the app answers through the public
hostname, and publishes the address into `backend.json`. The app reads
`backend.json`, finds the backend wherever it is, and talks to it
cross-origin. The backend address therefore changes as the workflow renews;
the app's address never does.

The moving parts, briefly:

| piece | what it does |
| --- | --- |
| `public/` | the whole app, plain static files |
| `backend.json` | where the live server currently is |
| `live public app` | runs the real server + public tunnel, renews itself |
| `verify the public app` | fetches the published app as a browser would, walks the module graph, then checks REST and socket.io CORS from the app's origin |
| `deploy static app to GitHub Pages` | publishes the same files to Pages — it needs *Settings → Pages → Source: GitHub Actions* once, which only a repository owner can do |
| `probe static hosts` | which hosts actually serve the app as a page rather than as `text/plain` |

If you would rather have a permanent backend at a fixed address, deploy this
repository to Render with the button below and put that address in
`backend.json`; everything else keeps working unchanged.

## Put it online — get a link you can share

A preview URL inside the sandbox only works while that session is alive. For a
**permanent link anyone can open**, deploy the repo to a host. About two
minutes, no server knowledge needed.

### Render — one click

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/olis71697-hub/mkmalik-server)

1. Click the button above, or open
   `https://render.com/deploy?repo=https://github.com/olis71697-hub/mkmalik-server`
2. Sign in with GitHub — Render reads `render.yaml` from this repo
3. Press **Apply**. When the build finishes you get a URL like
   `https://mkmalik.onrender.com`

That link is **HTTPS**, which is what actually matters: browsers only hand over
the microphone on `https://` or `localhost`. Share it and voice works.

Free plan notes: the service sleeps after ~15 minutes idle (first hit takes
~30s to wake), and its filesystem is ephemeral — rooms and accounts reset on
redeploy. The server re-seeds itself, so the app always comes up populated.
Attach a disk on a paid plan for permanent storage.

### Railway

1. <https://railway.com/new> → **Deploy from GitHub repo** → pick this repo
2. Railway detects Node and uses `railway.json`
3. Add variable `NODE_ENV=production` (plus `JWT_SECRET`, and `SMS_API_URL` / `PURCHASE_VERIFY_URL` when you have them)
4. **Settings → Networking → Generate Domain**

### Fly.io (keeps your data)

Deploys from the bundled `Dockerfile` and attaches a volume, so accounts, rooms
and uploads survive.

```bash
fly launch --no-deploy
fly volumes create mkmalik_data --size 1
fly secrets set JWT_SECRET=$(openssl rand -hex 48)
fly deploy
```

### Your own server

Any VPS with Node 22 works — see [Self-hosting](#self-hosting) for the systemd
unit and nginx config.

### Before opening it to the public

| Setting | Why |
|---|---|
| `JWT_SECRET=<random>` | Set it explicitly and never let it change |
| `SMS_API_URL` + `SMS_API_KEY` | Phone/OTP sign-in needs a real SMS gateway |
| `PURCHASE_VERIFY_URL` (+ `PAYMENTS_MODE=live`) | Coin purchases need a real payment gateway |
| `TURN_URL` + credentials | Voice across mobile networks needs a relay |

---

## Install it like a real app

MK Malik is a **PWA**. Once it is open in a browser it can be installed to the
home screen and then launches full screen, with its own icon, no browser bars.

**Android / Chrome** — an install bar appears at the bottom of the app; tap
**Install**. Or use the browser menu → *Install app*.

**iPhone / Safari** — tap **Share** → *Add to Home Screen*. (iOS has no install
API, so the in-app button tells you the steps instead.)

The service worker is deliberately conservative: it never caches `/api/` or
`/socket.io/`, so a room you open is always live. It only caches the shell, the
icons and the manifest — enough to be installable and to show something
sensible if the network drops.

Two things to know:

* Installation needs `https://` (or `localhost`). A plain `http://` address
  cannot be installed, and the microphone stays blocked there too.
* Installing does not create a separate app — it is the same server, opened
  without browser chrome.

---

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:8080>. The database starts **empty** — no demo
accounts, no fake rooms, no auto-login. Register a real account
(username + password) and create the first room yourself.

Everything you see from that point is real data in a real database. If you
ever want throwaway test data on a dev machine, `npm run seed` creates it on
purpose — it is never run automatically.

### Talk between two devices

Voice needs both browsers open. Log in twice — different browsers, an incognito
window, or two phones on the same network:

1. Both open the app and enter the same room.
2. Each takes a mic seat (tap **Join mic**).
3. Unmute and talk. Audio is peer-to-peer.

> Browsers only allow microphone access on **HTTPS** (or `localhost`). On a NAS
> or server, put it behind a TLS proxy.

---

## What is real and what needs a third-party service

| Real (server-authoritative, works today) | Needs configuration |
|---|---|
| WebRTC audio, peer-to-peer mesh | SMS for phone/OTP login (`SMS_API_URL`) |
| Chat safety filter: profanity/slurs (bn/en/romanized + leetspeak & separator evasion) rejected server-side, 3 strikes → 10-min chat timeout (`CHAT_FILTER=off` to disable) | |
| Seat occupancy, mute, hand-raise, locks | Google Sign-In (`GOOGLE_CLIENT_ID`) |
| Room chat + rate limiting, moderation | Coin purchases (`PAYMENTS_MODE=live` + verify URL) |
| Gifts, coins, diamonds, diamond→coin exchange | TURN relay for strict NATs (`TURN_URL`) |
| Followers, DMs, leaderboards, Web Push (VAPID) | |
| "Your followed host is live" notifications | |
| Moments, likes, comments | — |
| Direct messages | — |
| Accounts, sessions, follows | — |

Seeded hosts hold mic seats but have no browser, so **the server never opens a
WebRTC connection to them** — only real, connected people are paired for audio.
Human-owned rooms close on their own when everyone leaves; official rooms stay
open so there is always somewhere to go.

---

## Voice architecture

```
speaker  ⇄  speaker      WebRTC sendrecv   (both publish and receive)
speaker  →  listener     WebRTC sendonly / recvonly
listener ⇄  listener     no connection      (no audio path needed)
```

* The server relays **SDP offers/answers and ICE candidates only** — media never
  touches it.
* Glare is resolved with perfect negotiation; the polite peer rolls back.
* Listeners release the microphone hardware entirely until they take a seat.
* Speaking detection uses an `AnalyserNode` on the local stream and is mirrored
  to other clients over the socket.

### TURN (needed for real-world mobile networks)

STUN alone works on most home networks. Behind carrier-grade NAT you need a
relay, otherwise the call connects but stays silent:

```bash
TURN_URL=turn:turn.example.com:3478
TURN_USERNAME=myuser
TURN_CREDENTIAL=mypassword
```

or, with coturn's REST API (per-request, auto-expiring credentials):

```bash
TURN_URL=turn:turn.example.com:3478
TURN_SECRET=your-static-auth-secret
```

The bundled compose file can run coturn for you:

```bash
TURN_SECRET=$(openssl rand -hex 24) docker compose --profile turn up -d
```

Credentials are handed to the browser from `/api/ice-servers`, never baked into
the bundle.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Create an account (1500 welcome coins) |
| `POST` | `/api/auth/login` | Sign in, returns a JWT |
| `GET` | `/api/me` | Current profile + wallet |
| `PATCH` | `/api/me` | Update name, bio, avatar, country |
| `POST` | `/api/me/daily-bonus` | Claim the daily coin bonus |
| `GET` | `/api/rooms` | Explore feed (`?category=&q=&sort=hot\|new\|seats\|related`) |
| `POST` | `/api/rooms` | Open a room |
| `GET` | `/api/rooms/:id` | Full room snapshot |
| `GET` | `/api/search?q=` | Search rooms and people |
| `POST` | `/api/users/:id/follow` | Follow / unfollow |
| `GET` | `/api/gifts` | Gift catalog |
| `GET` | `/api/moments` | Social feed |
| `POST` | `/api/moments` | Publish a moment (multipart `image` optional) |
| `POST` | `/api/moments/:id/like` | Like / unlike |
| `GET` | `/api/chat/conversations` | DM threads |
| `GET` | `/api/chat/:userId/messages` | Thread history |
| `GET` | `/api/leaderboard?period=day\|week` | Top hosts and gifters |
| `GET` | `/api/ice-servers` | WebRTC ICE config (incl. TURN) |
| `GET` | `/api/health` | Uptime, live room and seat counters |

### Socket.IO events

| Direction | Event | Meaning |
|---|---|---|
| → | `room:join` / `room:leave` | Enter or leave a room |
| → | `seat:take` `seat:leave` `seat:mute` `seat:lock` `seat:kick` | Mic seat control |
| → | `hand:raise` `chat:send` `gift:send` | Audience actions |
| → | `rtc:signal` | SDP / ICE relay to one peer |
| → | `presence:ping` | Heartbeat |
| ← | `room:state` `room:message` `room:gift` `room:seat` | Room updates |
| ← | `room:peers` | Your personalised peer list — drives the audio graph |
| ← | `rtc:signal` | Incoming SDP / ICE |
| ← | `dm:new` `notification` | Direct messages and alerts |

---

## Coin economy

Coins are **server-authoritative** — the client can never credit itself.

* New accounts receive `WELCOME_COINS` (default 1500).
* A gift debits the sender, credits the receiver with diamonds, and shares
  `HOST_SHARE_PCT` (60%) with the room owner when someone else is gifted.
* Every movement is written to an append-only `coin_ledger`.
* Top-ups are disabled by default. Set `ADMIN_TOPUP_TOKEN` to enable
  `POST /api/wallet/topup { amount, token }` for manual credit.

---

## Self-hosting

### Docker

```bash
docker compose up -d --build
```

State lives in the `mkmalik-data` volume, so rebuilds keep accounts, rooms and
uploads.

### Bare metal with systemd

```ini
[Unit]
Description=MK Malik live voice rooms
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mkmalik-server
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=JWT_SECRET=replace-me-with-openssl-rand-hex-48
User=mkmalik

[Install]
WantedBy=multi-user.target
```

### Reverse proxy (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name voice.example.com;

  client_max_body_size 10m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # websockets
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
  }
}
```

---

## Configuration

Copy `.env.example` to `.env`. Everything has a working default — highlights:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `JWT_SECRET` | generated | **Set this in production** |
| `MAX_LISTENERS` | `60` | Audience cap per room |
| `WELCOME_COINS` | `1500` | Signup grant |
| `MAX_UPLOAD_MB` | `8` | Avatar / moment images |
| `STUN_URLS` | Google STUN | Comma-separated |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | — | Static TURN |
| `TURN_SECRET` | — | coturn REST credentials |
| `ADMIN_TOPUP_TOKEN` | — | Enables coin top-ups |
| `CORS_ORIGINS` | `*` | Restrict for native clients |
| `AUTH_ATTEMPTS_PER_MIN` | `12` | Sign-in / sign-up attempts per IP |
| `OTP_DEV_BYPASS` | off | Dev-only: surface OTP codes without an SMS gateway |
| `CHAT_FILTER` | on | Server-side profanity/slur filter for chat, DMs, titles, profiles |
| `ROOMS_PER_HOUR` | `6` | Rooms one account may open per hour |

---

## Testing

```bash
npm start          # in one terminal
npm test           # in another   (~75s)
```

Seven suites run against the real server — nothing is mocked. They drive
actual Socket.IO clients through full sessions, boot the app in jsdom, and
serve it from a stand-in static host:

| Suite | What it proves |
|---|---|
| `fresh-visit.mjs` | A first-time visitor lands on the real sign-in screen — no silent demo session, no fake data, and the gift catalog (product data) exists on a fresh database |
| `pwa.mjs` | The app is genuinely installable: valid manifest, real PNG icons at both sizes, a maskable icon, a registered service worker that never caches live data, and the iOS meta tags |
| `voice-e2e.mjs` | Room creation, seat taking, SDP/ICE relayed both ways, outsiders cannot inject signalling, chat delivery, gifts moving coins server-side, host moderation, empty rooms closing |
| `peer-topology.mjs` | The audio graph is right at every stage: `sendonly/recvonly` for speaker→listener, `sendrecv` between speakers, no listener↔listener links, and a full 10-seat room refusing an 11th speaker |
| `presence.mjs` | A backgrounded phone that stops sending heartbeats keeps its mic seat, while a real disconnect frees it instantly |
| `static-host.mjs` | The app works when it is *not* served by its own backend: a Pages-like host under a sub-path, the full asset and ES-module graph, the manifest and service worker under that prefix, and every workflow file parsing |
| `push.mjs` | Web Push is real: stable VAPID keypair, subscribe/unsubscribe storage, dedupe, auth required, dead-endpoint pruning, and honest structured delivery answers |

```
════ RESULT:  5 passed, 0 failed ════   fresh-visit
════ RESULT: 32 passed, 0 failed ════   pwa
════ RESULT: 28 passed, 0 failed ════   voice-e2e
════ RESULT: 13 passed, 0 failed ════   peer-topology
════ RESULT:  7 passed, 0 failed ════   presence
════ RESULT: 29 passed, 0 failed ════   static-host
✅ all integration tests passed         6 suites in 78s
```

`SKIP_SLOW=1 npm test` skips the 70-second presence suite.

Running the suite repeatedly creates real accounts, so it can trip the server's
per-IP rate limits. The tests wait out any `429` automatically; to make repeat
runs instant, start the server with generous limits:

```bash
AUTH_ATTEMPTS_PER_MIN=400 ROOMS_PER_HOUR=400 npm start
```

---

## Project layout

```
server/
  index.js         HTTP + Socket.IO bootstrap, graceful shutdown
  config.js        env parsing and defaults
  db.js            node:sqlite schema (no native build step)
  api.js           REST routes
  realtime.js      sockets, seat events, signalling relay, room ambience
  state.js         the live room map — seats, members, host hand-over
  auth.js          JWT sign/verify, middleware
  dm.js            direct messages
  push.js          Web Push (VAPID) delivery
  seed.js          dev fixture only (never auto-run) — throwaway test data
public/
  index.html       app shell
  manifest.json         PWA install metadata
  sw.js            service worker (shell only — never caches live data)
  icons/           generated PNG app icons
  css/app.css      the whole design system
  js/app.js        session, routing, socket lifecycle
  js/api.js        REST client
  js/rtc.js        WebRTC mesh + speaking detection
  js/util.js       DOM helpers, procedural room covers
  js/screens/      explore, room, moments, chat, profile, auth
tests/             integration suite
```

Room covers are generated as SVG data-URIs from a deterministic theme seed, so
the grid is instantly populated with no external image requests and no
third-party CDN.

---

## Notes

* SQLite runs through Node's built-in `node:sqlite` — no compiler, no native
  module, no separate database server.
* Image uploads are validated by MIME type and capped at `MAX_UPLOAD_MB`.
* Room chat, gifts, follows, logins and room creation are all rate limited.
* The server persists the room map and checkpoints the WAL on `SIGTERM`/`SIGINT`
  so a restart is not a data loss event.
