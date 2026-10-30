# RTMP Live for Sharkord

[简体中文](README.md) | **English**

Takes a single RTMP push and publishes it as a live stream inside a Sharkord voice channel. Built for "stream from a DJI Action camera into a channel", but anything that speaks RTMP works too — OBS, Larix, ffmpeg.

> **Status**: verified end to end on a local Docker deployment of Sharkord (v0.0.28) with a Windows host — plugin load, RTMP ingest (H.264 + AAC), stream-key check, ffmpeg transcode, RTP into mediasoup, video in the browser.
>
> Two environment gotchas (neither is the plugin's fault) are documented under "Three things the deployment must get right". Leaving `webRtc.announcedAddress` empty shows up as **video that never appears**.

## How it works

```
OBS / DJI Action
      │  RTMP push  rtmp://<host>:1935/live/<streamKey>
      ▼
node-media-server ── validates the stream key, keeps the session open
      │  loopback rtmp://127.0.0.1:1935/live/<streamKey>
      ▼
ffmpeg ── H.264 transcode + AAC→Opus, two RTP outputs
      │  UDP 127.0.0.1:<port>
      ▼
mediasoup PlainTransport → Producer → ctx.voice.createStream()
      │
      ▼
a live card appears in the voice channel
```

The plugin is not a separate service and exposes no port of its own — Sharkord `import()`s it into its own process and it reuses the voice runtime (mediasoup router) that is already there.

Two independent conditions decide what happens:

| Publisher | Listeners in channel | Result |
|---|---|---|
| pushing | none | RTMP session is held, no transcoding, no CPU |
| pushing | someone | ffmpeg starts, video goes into the channel |
| pushing | everyone just left | ffmpeg stops, card is removed, **RTMP session stays up**; it resumes when the next person joins |
| disconnected | — | ffmpeg stops, back to idle |

ffmpeg and mediasoup live in the same process tree and RTP runs over `127.0.0.1`, so **no extra UDP port has to be mapped for the transcode leg**.

## Project layout

| Path | Purpose |
|---|---|
| `src/server/index.ts` | Plugin entry: setting registration, event listeners, the `/live` and `/live-refresh` commands |
| `src/server/session.ts` | State machine tying the "publisher" and "voice runtime" lifecycles together; every transition is serialised |
| `src/server/rtmp-server.ts` | `node-media-server` wrapper: path parsing, key validation, single-publisher lock, kicking |
| `src/server/bridge.ts` | ffmpeg → RTP → mediasoup PlainTransport ×2 → Producer ×2 → `createStream` |
| `src/server/ffmpeg.ts` | Transcode arguments, ffmpeg discovery, child process management |
| `src/server/keys.ts` | 32-char random stream key, persistence, rotation, timing-safe compare |
| `src/types.ts` | Contract between the server half and the (former) browser half; now just the two commands |
| `src/client/index.ts` | Empty module — the bundler requires the entry to exist. There is no frontend |
| `build.ts` / `scripts/deploy.ts` | Build, then copy the output into the server's plugin directory |
| `icon.svg` / `logo.svg` / `logo.png` | Plugin icon. `icon.svg` is the raw mark; `logo.svg`/`logo.png` add a white rounded plate because the black strokes nearly vanish on Sharkord's dark cards |
| `scripts/registry.ts` | Turns the build output into the two files the official registry needs, written to `registry/` |
| `docs/rtmp-live-plan.md` | Plan, phase breakdown and the debugging log (including the five bugs found on real hardware) |

## Install

The plugin is not a container; it is JavaScript that the Sharkord process `import()`s. Copy the build output into the server's plugin directory and restart the server.

```bash
bun install
bun run build
bun run deploy /path/to/sharkord/plugins   # or put the path in .env as SHARKORD_PLUGINS_PATH
```

Where the plugin directory is:

| Deployment | Plugin directory |
|---|---|
| Docker (`-v ./data:/home/bun/.config/sharkord`) | `./data/plugins` on the host |
| Bare metal / binary | `~/.config/sharkord/plugins` |
| Development | `<sharkord repo>/apps/server/data/plugins` |

The server scans that directory only at startup (the watcher only reacts to removals), so **a new plugin needs a restart**. After restarting, confirm it is enabled under Server Settings → Plugins.

### Three things the deployment must get right

**1. Set `webRtc.announcedAddress`**

Easiest to miss, hardest to diagnose. With it empty, Sharkord looks up the **public IP** and hands that to the browser as an ICE candidate. On a LAN or localhost, reaching that public IP requires NAT hairpinning, which does not work on Windows — ICE fails outright.

The failure looks nothing like its cause: the video consumer is created, the server logs no errors, "starting to publish live" appears, and the browser stays black until the card degrades into a headphone icon a few seconds later.

```ini
[webRtc]
port=40000
announcedAddress=192.168.1.86   ; the address the browser can actually reach
maxBitrate=30000000
```

Restart the server afterwards. To confirm, temporarily set `[server] debug = true`; the startup log then contains

```
debug: WebRtcServer created on port 40000 with announcedAddress 192.168.1.86
```

Set it back to `false` once verified.

**2. Map the ports.** The plugin listens on 1935 inside the container; without a mapping no device outside can push. 40000 is Sharkord's WebRTC port and needs both TCP and UDP:

```bash
docker run -d \
  -p 4991:4991/tcp -p 40000:40000/tcp -p 40000:40000/udp \
  -p 1935:1935/tcp \
  -v ./data:/home/bun/.config/sharkord \
  --name sharkord sharkord/sharkord:latest
```

**3. Give the container an ffmpeg.** The official image ships without one. Two options:

- **Keep it out of the image** (recommended, already supported): drop a static Linux ffmpeg at
  `./data/plugin-data/sharkord-rtmp-live/ffmpeg` on the host and the plugin picks it up at startup.
  `plugin-data` is mounted into the container, so the binary must be **Linux x86_64** — a Windows
  `ffmpeg.exe` will not run. `chmod +x` it and confirm it executes inside the container.
- **Build your own image**: `FROM sharkord/sharkord:latest` plus `apt-get install -y ffmpeg`, then set
  `ffmpegPath` to `/usr/bin/ffmpeg` (or leave it empty and let PATH resolve it).

## Production deployment

The plugin is not an image and does not need packing into a `.tar.gz` — `dist/sharkord-rtmp-live/` is the final form.

```
sharkord-rtmp-live/
├── manifest.json
├── server/index.js      ← one file, dependencies inlined
└── client/index.js      ← empty module, but all three must be present
```

```bash
# build machine
bun run build
tar -cf rtmp-live.tar -C dist sharkord-rtmp-live

# production machine (no bun / node needed)
tar -xf rtmp-live.tar -C /path/to/data/plugins
docker restart sharkord
```

Why no packaging: the host `import()`s an already-flattened `server/index.js` and never touches `node_modules` at runtime. The plugin is unrelated to the container image, so no `docker build` and no image changes are involved.

- **A restart is mandatory**: the host's watcher on the plugin directory only reacts to removals, never to additions
- **Upgrading** means overwrite the directory and restart. `bun run build` removes the target first, so no stale files survive
- **Nothing is lost**: ffmpeg lives in `data/plugin-data/sharkord-rtmp-live/` and the stream key in `data/db.sqlite` — neither is under `plugins/`
- **Permission settings survive too**: the role allow list is stored in the database

### Can it go into the plugin marketplace

Yes, but not by dropping it in. The marketplace is not an import channel but a fixed registry — from the host source:

```ts
const MARKETPLACE_REGISTRY_URL =
  'https://raw.githubusercontent.com/Sharkord/plugins/refs/heads/main/plugins.json';
```

Both the client's list and the server's install path read that one URL, and no environment variable overrides it. Installing means "look up id + version in the registry → download `downloadUrl` → verify sha256 → extract and swap". There is no install-from-URL and no archive upload.

The full walkthrough is in [Publishing to the marketplace](#publishing-to-the-marketplace) below. The one thing worth stressing here: there is no install-from-URL and no archive upload — the server only knows `id + version`, then downloads `downloadUrl`, verifies the sha256 and swaps the directory itself.

Only the maintainers can set `verified: true`; third-party entries stay `false`, which does not affect installing or updating.

### Go-live checklist

- [ ] Run the container with `--restart unless-stopped` (default is `restart=no`, so a host reboot leaves it down)
- [ ] `[webRtc] announcedAddress` set to an address the browser can actually reach
- [ ] 1935/TCP mapped; if you changed the port, update Public port as well
- [ ] ffmpeg placed at `data/plugin-data/sharkord-rtmp-live/ffmpeg` (Linux x86_64, `chmod +x`)
- [ ] `data/` backed up (the stream key lives in `db.sqlite`)
- [ ] Roles ticked on the permission page, and those roles holding `USE_PLUGINS`

## Settings

| Setting | Meaning |
|---|---|
| Live channel | Channel picker. With nothing selected (value 0) an incoming push is accepted but never published |
| RTMP listen port | Default 1935 — the port the plugin listens on inside the container |
| Public host | Host shown in the publish URL. The container cannot see the public address, so **this is mandatory behind Docker**. Empty falls back to the voice server's announced address |
| Public port | Port shown in the publish URL, i.e. the one mapped on the host. `0` means "same as the listen port"; with `-p 19350:1935` this must be 19350 |
| Video handling | `Transcode` (default, best compatibility) or `Copy` (saves CPU, only when the source is H.264 Baseline) |
| Bitrate | Default 2500 kbps. A DJI 1080p source tops out at 6 Mbps; 4000 is a reasonable bump |
| ffmpeg path | Empty searches the plugin data directory first, then PATH |

## Publish URL

Cameras (single address field):

```
rtmp://<public host>:<public port>/live/<streamKey>
```

OBS (separate server and key fields):

```
Server:    rtmp://<public host>:<public port>/live
Stream key: <streamKey>
```

The port defaults to 1935; with `-p 19350:1935` the URL must say 19350 (set Public port to 19350 and the address the command prints is correct).

The stream key is a password — anyone holding the URL can push. If it leaks, run `/live-refresh`: the old URL dies immediately and the running stream is cut.

### Filling in a DJI Action 6

The Action 6 can only go live through the **DJI Mimo app** (the camera has no live menu of its own), and custom RTMP there has **one address field**, so the address and the key have to be joined:

1. Connect the phone to the camera (DJI Mimo → connect device) and open the camera view
2. Tap **Live** at the bottom → choose **RTMP**
3. Connect Wi-Fi first: pick the phone's 4G/5G hotspot and enter its name and password (this comes before the address)
4. Paste the full address from `/live`, e.g. `rtmp://live.example.com:1935/live/<streamKey>` — **no spaces anywhere**
5. Resolution **1080P**, bitrate **6 Mbps** (the app offers 3 or 6 only; frame rate is fixed at 30 fps)
6. Tap **Start live**; the preview window appearing means the push is up
7. When finished, **stop the stream in the app** — turning the camera off does not close the session, it just hangs

Video appears only once someone is in the live channel (see the two rules above).

## Commands and permissions

Two commands, both answering only the person who ran them:

| Command | What it does |
|---|---|
| `/live` | Sends you the current publish address (server / stream key / full URL) plus the current state |
| `/live-refresh` | Rotates to a new stream key, cuts the running stream, and sends you the new address |

**Who may use them is decided on the permission page** (Server Settings → Plugins → Permissions): the roles ticked there are the allow list. Change the ticks, not the code.

- Left untouched, the default applies: `requires: MANAGE_PLUGINS` — admins only.
- To let another role in, tick that role and enable both commands on that page.
- One host-level gate sits in front: **every plugin command requires `USE_PLUGINS`**. A role granted above but missing that permission will not even see the commands in its `/` menu, so add it in the role settings first.

No tabs, no buttons, no other switches: those two commands are all the permission page will ever show.

Both commands are ephemeral (temporary messages), so nothing lands in channel history. If no reply shows up after running one, run the same command from Server Settings → Plugins → Commands — the response is printed right there.

### Languages

**The plugin ships Chinese-only UI text** (setting names, descriptions, command descriptions).

This is a host limitation, not a shortcut: `settings.register` and `commands.register` take a **single string** for `name` / `description`. Definitions are registered once at load and apply to the whole server, and the host renders them verbatim (`<Group label={definition.name}>` in `settings.tsx`, `{command.description}` in `commands.tsx`). There is no per-locale lookup and nothing like a `locales` field in the manifest.

What *is* possible is letting replies follow the caller: `executes(invoker)` receives `invoker.locale` (`en`, `zh`, `cs`, `es`, `fr`, `it`, `ru`, `pt-BR`). That is planned for a follow-up PR, together with bilingual static labels.

## When no picture appears

Work down this list; each step halves the search space.

| Symptom | Meaning | Check |
|---|---|---|
| No "received push" in the log | Packets never reached the plugin | Push URL, the 1935 mapping, `docker logs \| grep "rtmp connect"` |
| "Received push" but "no live channel selected" | No channel picked | Plugin settings → Live channel |
| "Starting to publish to channel N" but the browser stays black | Server side is fine, problem is in the browser | next two rows |
| The card turns into a headphone icon | Video track was removed — usually a dead consumer transport | Search the browser console for `ice failed` |
| `consumer transport: connection state failed` | ICE cannot connect; almost always `announcedAddress` | Item 1 of "Three things the deployment must get right" |
| Picture but stuttering or broken | Bitrate or CPU | Lower the bitrate, check the container is not CPU-bound |

The two most useful server logs:

```
[observe] a viewer started watching (video)   ← the browser really created a consumer
ffmpeg ... -f rtp ...                          ← the transcode command actually launched
```

If "a viewer started watching" never appears, the browser never subscribed (usually the wrong channel). If it appears and the picture is still black, the problem is transport or decoding.

## Known limitations

- **One stream at a time.** A second publisher is rejected outright; the first is never interrupted.
- **ffmpeg is bring-your-own.** The plugin does not download a binary. Put one at `plugin-data/sharkord-rtmp-live/ffmpeg` (static Linux build) or point `ffmpegPath` at it. Testing used the johnvansickle static build (66 MB, with libx264 + libopus).
- **Copy mode constrains the source.** The producer advertises H.264 Baseline 3.1; a mismatched source can show black. Switch back to transcode to confirm.
- **No idle timeout yet.** With a camera pushing into an empty channel the RTMP session stays up indefinitely (`gop_cache` is off, so no frames accumulate).
- **Verified on a single setup only.** One channel, one stream, Docker on a Windows host.

## Development

```bash
bun run setup    # clone SDK / builder into .repos and link them (first time)
bun run build    # build; also deploys when SHARKORD_PLUGINS_PATH is set in .env
bun run deploy   # deploy only
bunx tsc --noEmit
```

Notes:

- `ctx.path` is wiped on every update; anything that must survive belongs in `ctx.dataPath`. The stream key lives in `ctx.storage`.
- There is no frontend (`src/client/index.ts` is an empty module). The bundler requires the entry to exist, but no tab or component is registered, so a normal user's browser never loads it.
- `sdkVersion` must match the server exactly; `bun run build` writes it for you.
- `version` comes from `package.json`, not `manifest.json`.
- Keep `as const` on the `settings.register` definitions or `settings.get` loses its types.
- `bunx tsc --noEmit` also reports errors from the linked SDK package (`@sharkord/shared` imports types back out of `apps/server`); only `src/` matters. `tsconfig.json` already scopes the check to `src`/`scripts`/`build.ts`/`publish.ts`.
- `publish.ts` no longer hardcodes a repository: it reads `GITHUB_REPOSITORY` (exported by GitHub Actions) or the `repository` field in `package.json`, and exits with an error when neither is set.

The plan and phase breakdown live in [`docs/rtmp-live-plan.md`](docs/rtmp-live-plan.md) (Chinese).

## Publishing to the marketplace

The marketplace is a registry file (`plugins.json`) inside [`Sharkord/plugins`](https://github.com/Sharkord/plugins), fetched by every server. Your code stays in your own repository; only metadata goes into the registry.

1. **Cut a GitHub release** tagged `v<version>` with two assets: `<id>-<version>.tar.gz` and `<version>.json`. `bun run publish` does both (needs `GITHUB_TOKEN`; the repository comes from `GITHUB_REPOSITORY` or the `repository` field in `package.json`).
2. **Generate the two PR files** with `bun run registry` (after `bun run build`). It reads `manifest.json` plus `dist/<version>.json` and writes `registry/plugins/sharkord-rtmp-live/`, laid out exactly like the official repo, ready to copy in:
   - `plugin.json` — `id`/`name`/`description`/`author`/**`logo` (required, publicly reachable image URL)**/`homepage`/`tags`/`categories`/`screenshots`
   - `versions/<version>.json` — `version`, `downloadUrl` (the HTTPS release asset), `checksum` (sha256 of the asset), `sdkVersion`, `size`, `timestamp`
3. **Open a PR against `Sharkord/plugins`** and drop that directory in.
4. CI runs `bun run validate`: missing fields, an `id` that differs from the directory name, or a version that differs from the filename all fail. After the merge the maintainers regenerate `plugins.json` and your plugin shows up everywhere.
5. You do not set `verified` — it is a hardcoded allowlist in `scripts/statics.ts` of the registry repo. It means the maintainers recognise the publisher, not that the code was audited.
6. `tags` / `categories` currently allow no values, so leave them empty.

Two hard rules: `sdkVersion` must equal the server's SDK version (2 right now) or the version will not be offered to that server, so re-release after every SDK bump; release assets get scanned through VirusTotal by the maintainers.

`logo` points at a pinned commit on jsDelivr (`cdn.jsdelivr.net/gh/<owner>/<repo>@<commit>/logo.png`): write it once and it never breaks, at the cost of having to change the URL when the icon changes. GitHub raw is the accepted alternative, but it is blocked by the proxy on the machine this was built on while jsDelivr is not.

None of this is needed for private use — dropping `dist/sharkord-rtmp-live/` into the plugins directory is enough.

## License

[MIT](LICENSE) © 2026 AndreasByrsting, matching the `license` field in `package.json`.
