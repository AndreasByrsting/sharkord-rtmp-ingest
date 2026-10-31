<p align="center"><img src="logo.png" width="96" alt="RTMP Live"></p>

# RTMP Live for Sharkord

[简体中文](README.md) | **English**

Turns a single RTMP push — from a camera, OBS or a phone — into a live stream inside a Sharkord voice channel. Built for devices like the DJI Action that only give you one RTMP field, and compatible with any RTMP publisher.

- **One command for the address**: `/live` sends the publisher the RTMP URL and stream key, no config digging.
- **No viewers, no transcoding**: with an empty channel the plugin only holds the RTMP session and costs no CPU. A viewer joining starts the stream, everyone leaving stops it — and **the push stays connected**.
- **Rotatable stream key**: `/live-refresh` invalidates the old address and cuts the running stream immediately.
- **Just a plugin**: not a service, no extra ports — Sharkord `import()`s it and it reuses the existing voice runtime.

## How it works

```
OBS / DJI Action
      │  RTMP push  rtmp://<host>:1935/live/<streamKey>
      ▼
node-media-server ── validates the key, keeps the session alive
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

ffmpeg and mediasoup share the same process tree and the RTP hops over `127.0.0.1`, so **the transcoding path needs no extra port mapping**.

"Someone is pushing" and "someone is watching" are independent, and their combination decides what the plugin does:

| Publisher | Viewers in the channel | Behaviour |
|---|---|---|
| pushing | none | keeps the RTMP session only, no transcoding |
| pushing | present | starts ffmpeg, picture goes live |
| pushing | just left | stops ffmpeg, removes the card, **keeps the RTMP session**; resumes for the next viewer |
| gone | — | stops ffmpeg, back to idle |

## Requirements

| Item | Requirement |
|---|---|
| Sharkord | 0.0.28 (plugin SDK 2). `sdkVersion` must match the server or the plugin is not loaded |
| ffmpeg | must carry `libx264` and `libopus`; a static build is fine. **The official image ships without ffmpeg** — see the install step |
| Ports | `1935/tcp` (publishing), `40000/tcp` + `40000/udp` (Sharkord's WebRTC) |

## Installation

The plugin is JavaScript that the server `import()`s, not a container. Drop the built directory into the plugins folder and restart the server.

Where the plugins folder is:

| Deployment | Plugins folder |
|---|---|
| Docker (`-v ./data:/home/bun/.config/sharkord`) | `./data/plugins` on the host |
| Bare metal / binary | `~/.config/sharkord/plugins` |
| Development | `<sharkord repo>/apps/server/data/plugins` |

The server scans that folder at startup only (the watcher handles deletions only), so **a new plugin needs a restart**. Afterwards check it is enabled under Server Settings → Plugins.

### 1. Install the plugin

Grab the latest attachment from [Releases](https://github.com/AndreasByrsting/sharkord-rtmp-ingest/releases), unpack it to get `sharkord-rtmp-live/`, then:

```bash
# next to sharkord's data directory
cp -r sharkord-rtmp-live ./data/plugins/
```

Or build from source:

```bash
bun install
bun run build
bun run deploy /path/to/sharkord/plugins   # or set SHARKORD_PLUGINS_PATH in .env
```

### 2. Provide ffmpeg

The official `oven/bun` image has no ffmpeg. Two options — the first is recommended because it leaves the image untouched:

**Drop a static binary into the plugin data folder** (the plugin prefers it):

```bash
curl -LO https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xf ffmpeg-release-amd64-static.tar.xz
mkdir -p ./data/plugin-data/sharkord-rtmp-live
cp ffmpeg-*-amd64-static/ffmpeg ./data/plugin-data/sharkord-rtmp-live/ffmpeg
chmod +x ./data/plugin-data/sharkord-rtmp-live/ffmpeg
```

`plugin-data` is mounted into the container, so the binary must be a **Linux** build — a Windows `ffmpeg.exe` will not run there.

**Or build your own image**: `FROM sharkord/sharkord:latest` plus `apt-get install -y ffmpeg`, then leave the ffmpeg path empty (resolved from PATH) or point it at `/usr/bin/ffmpeg`.

Verify:

```bash
docker exec -it sharkord /home/bun/.config/sharkord/plugin-data/sharkord-rtmp-live/ffmpeg \
  -hide_banner -encoders | grep -E "libx264|libopus"
```

### 3. Configure

Set **`announcedAddress`** in `config.ini`, or viewers will never see a picture:

```ini
[webRtc]
port=40000
announcedAddress=192.168.1.86   ; an address browsers can actually reach
maxBitrate=30000000
```

When it is empty Sharkord looks up the public IP and hands that to browsers as the ICE candidate. On a LAN that requires NAT hairpinning, which usually fails, and ICE dies. The symptom is misleading: the consumer is created, the server logs no error, "starting to publish" appears — and the picture stays black until the card collapses into a headphone icon.

Full run command (note the 1935 and 40000 mappings):

```bash
docker run -d \
  -p 4991:4991/tcp \
  -p 40000:40000/tcp -p 40000:40000/udp \
  -p 1935:1935/tcp \
  -v ./data:/home/bun/.config/sharkord \
  --restart unless-stopped \
  --name sharkord sharkord/sharkord:latest
```

To confirm it took effect, temporarily set `[server] debug = true`; the startup log will show `WebRtcServer created on port 40000 with announcedAddress ...`. Set it back to `false` afterwards.

### 4. Publish

Send `/live` in chat to get the server address, the stream key and the full URL. Devices with a single field take the full URL:

```
rtmp://<public host>:<public port>/live/<streamKey>
```

OBS splits it:

```
Server:  rtmp://<public host>:<public port>/live
Stream key: <streamKey>
```

The port is 1935 by default. With `-p 19350:1935`, set "public publish port" to 19350 and the generated address will carry the right port.

> The stream key is a password — anyone with the URL can publish. After a leak, run `/live-refresh`; the old address dies immediately.

### DJI Action 6

The Action 6 only streams through the **DJI Mimo app** (the camera has no streaming menu), and custom RTMP has a single field, so the address and key must be concatenated:

1. Connect the phone to the camera (DJI Mimo → connect), open the live view
2. Tap "Live" at the bottom → platform **RTMP**
3. Join Wi-Fi first: pick the phone's hotspot and enter its name and password (before the address)
4. Paste the full address from `/live`, with **no spaces**
5. Resolution **1080P**, bitrate **6 Mbps** (only 3 / 6 Mbps are offered; 30 fps fixed)
6. Tap "Start live" — a preview window means the push is live
7. When done, **tap "End live" in the app** — closing the camera does not disconnect

## Settings

| Setting | Description |
|---|---|
| Live channel | Channel picker. When unset (0) an incoming push is not published |
| RTMP listen port | 1935 by default, the port the plugin listens on inside the container |
| Public host / IP | Host shown in the publish URL. The container cannot see the public address, so **Docker deployments must set it**. Empty falls back to the voice server's public address |
| Public publish port | Port shown in the URL, i.e. the host-side mapping. `0` means "same as the listen port" |
| Video handling | `transcode` (default, best compatibility) or `copy` (cheap, only for H.264 Baseline sources) |
| Bitrate | 2500 kbps by default. DJI 1080p sources go up to 6 Mbps; 4000 is a reasonable bump |
| ffmpeg path | Empty resolves to the plugin data folder, then PATH |

## Commands and permissions

| Command | Effect |
|---|---|
| `/live` | Sends the current publish URL (server / key / full address) plus the current state |
| `/live-refresh` | Issues a new key, cuts the running stream, returns the new address |

Both are ephemeral and never land in channel history.

**Who may use them is decided by the permissions page** (Server Settings → Plugins → Permissions): tick a role and it can run them, no config edits needed. Untouched, they follow `MANAGE_PLUGINS`, i.e. admins only.

Note the host has a second gate: **every plugin command requires "Use plugins" (`USE_PLUGINS`)**. Without it the commands do not even appear in the `/` menu.

## Troubleshooting

Work down this list; each row narrows the problem by half:

| Symptom | Meaning | Check |
|---|---|---|
| No "received push" in the log | the packets never reach the plugin | publisher URL, 1935 mapping, `docker logs \| grep "rtmp connect"` |
| "received push" but "no live channel selected" | channel not set | plugin settings → live channel |
| `找不到可执行文件 "ffmpeg"` | no ffmpeg in the container; unrelated to reverse proxies or the publisher | see "Provide ffmpeg" above |
| "starting to publish to channel N" but the browser is black | server side is fine, problem is in the browser | next two rows |
| Card turns into a headphone icon | video track removed — usually a dead consumer transport | search F12 for `ice failed` |
| `consumer transport: connection state failed` | ICE cannot connect; almost always `announcedAddress` | step 3 above |
| Picture but stuttering or broken | bitrate or CPU | lower the bitrate, check the container is not CPU-bound |

Since 0.2.3 a missing ffmpeg is detected **before** anything is allocated, and the error names all three locations tried plus both ways out — no more "the card flashes and disappears".

The two most useful server-side lines:

```
有观众开始观看（视频）      ← the browser really created a consumer
ffmpeg ... -f rtp ...      ← the actual transcoding command
```

If the first one never appears the browser is not subscribing (wrong channel, most likely); if it appears but the picture is black, it is transport or decoding.

## Limitations

- **One push at a time.** A second publisher is rejected and does not interrupt the first.
- **Bring your own ffmpeg.** The plugin never downloads a binary.
- **Passthrough has requirements.** Producers announce H.264 Baseline 3.1; a mismatched source can render black — switch back to transcoding to confirm.
- **No idle timeout yet.** If the camera keeps pushing with nobody watching, the RTMP session stays up (`gop_cache` is off, so no frame cache accumulates).
- **UI strings are Chinese only.** The host has no locale lookup for `settings.register` / `commands.register`; the text is fixed at registration time.
- **Validated on a single instance.** One channel, one stream, Docker on a Windows host.

## Development

Build, deploy, release and marketplace submission are documented in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md); the plan and debugging log live in [`docs/rtmp-live-plan.md`](docs/rtmp-live-plan.md) (Chinese).

## License

[MIT](LICENSE) © 2026 AndreasByrsting
