<p align="center"><img src="logo.png" width="96" alt="RTMP Live"></p>

# RTMP Live for Sharkord

**简体中文** | [English](README.en.md)

把摄像机、OBS 或手机推上来的一路 RTMP，变成 Sharkord 语音频道里的直播画面。为大疆 Action 这类「只能填一个 RTMP 地址」的设备而做，任何 RTMP 推流软件都兼容。

- **一条命令换地址**：`/live` 直接把推流地址和推流码发给执行者，不用翻配置文件。
- **没人看就不转码**：频道里没听众时只保持 RTMP 会话，CPU 占用为零；有人进来自动开始，人走光自动停，**推流不断**。
- **推流码可轮换**：`/live-refresh` 立刻作废旧地址并断开正在进行的推流。
- **纯插件**：不是独立服务、不额外占端口，被 Sharkord 进程 `import()` 进来，复用现有语音运行时。

## 工作原理

```
OBS / 大疆 Action
      │  RTMP 推流  rtmp://<host>:1935/live/<streamKey>
      ▼
node-media-server ── 校验推流码，始终持有会话
      │  本机回环 rtmp://127.0.0.1:1935/live/<streamKey>
      ▼
ffmpeg ── H.264 转码 + AAC→Opus，输出两路 RTP
      │  UDP 127.0.0.1:<port>
      ▼
mediasoup PlainTransport → Producer → ctx.voice.createStream()
      │
      ▼
语音频道里出现一张直播卡片
```

ffmpeg 与 mediasoup 在同一个进程树里，RTP 走 `127.0.0.1`，所以**转码链路不需要额外的端口映射**。

「是否有人看」和「是否在推流」是两个独立条件，组合起来决定插件在做什么：

| 推流端 | 频道里有听众 | 行为 |
|---|---|---|
| 在推 | 没人 | 只保持 RTMP 会话，不启动转码 |
| 在推 | 有人 | 自动启动 ffmpeg，画面进频道 |
| 在推 | 人刚走光 | 停 ffmpeg、移除卡片，RTMP 会话保持；下一个人进来自动恢复 |
| 断开 | — | 停 ffmpeg，回到空闲 |

## 环境要求

| 项 | 要求 |
|---|---|
| Sharkord | 0.0.28（插件 SDK 2）。`sdkVersion` 必须与服务端一致，否则插件不会被加载 |
| ffmpeg | 需要自带 `libx264` 与 `libopus`，静态构建即可。**官方镜像里没有 ffmpeg**，见下方安装步骤 |
| 端口 | `1935/tcp`（推流）、`40000/tcp` + `40000/udp`（Sharkord 的 WebRTC） |

## 安装

插件是一段被服务端 `import()` 的 JavaScript，不是独立容器。把构建产物放进插件目录，重启服务端即可。

插件目录位置：

| 部署方式 | 插件目录 |
|---|---|
| Docker（`-v ./data:/home/bun/.config/sharkord`） | 宿主机的 `./data/plugins` |
| 裸机 / 二进制 | `~/.config/sharkord/plugins` |
| 开发环境 | `<sharkord repo>/apps/server/data/plugins` |

服务端只在启动时扫描插件目录（目录监听只处理「插件被删除」），**新增插件必须重启服务端**。重启后在「服务器设置 → 插件」里确认它是启用状态。

### 1. 放好插件

从 [Releases](https://github.com/AndreasByrsting/sharkord-rtmp-ingest/releases) 下载最新附件解包，得到 `sharkord-rtmp-live/`，然后：

```bash
# 在 sharkord 的 data 目录旁执行
cp -r sharkord-rtmp-live ./data/plugins/
```

或者从源码构建：

```bash
bun install
bun run build
bun run deploy /path/to/sharkord/plugins   # 也可把路径写进 .env 的 SHARKORD_PLUGINS_PATH
```

### 2. 准备 ffmpeg

官方镜像 `oven/bun` 里没有 ffmpeg。两个办法，推荐第一个（不用改镜像）：

**放到插件数据目录**（插件会优先使用它）：

```bash
curl -LO https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xf ffmpeg-release-amd64-static.tar.xz
mkdir -p ./data/plugin-data/sharkord-rtmp-live
cp ffmpeg-*-amd64-static/ffmpeg ./data/plugin-data/sharkord-rtmp-live/ffmpeg
chmod +x ./data/plugin-data/sharkord-rtmp-live/ffmpeg
```

`plugin-data` 是挂载进容器的，所以这个二进制必须是 **Linux** 的（不能在 Windows 上直接下载一个 `ffmpeg.exe` 丢进去）。

**自建镜像**：`FROM sharkord/sharkord:latest` + `apt-get install -y ffmpeg`，然后把「ffmpeg 路径」留空（走 PATH）或填 `/usr/bin/ffmpeg`。

验证二进制可用：

```bash
docker exec -it sharkord /home/bun/.config/sharkord/plugin-data/sharkord-rtmp-live/ffmpeg \
  -hide_banner -encoders | grep -E "libx264|libopus"
```

### 3. 配置

`config.ini` 里**务必填 `announcedAddress`**，否则观众侧画面永远出不来：

```ini
[webRtc]
port=40000
announcedAddress=192.168.1.86   ; 填浏览器实际能访问到的地址
maxBitrate=30000000
```

留空时 Sharkord 会去第三方接口查公网 IP，再把它当作 ICE 候选发给浏览器；局域网访问时浏览器往公网 IP 发包需要 NAT 回环，通常不通，ICE 直接失败。失败表现极具误导性：consumer 创建成功、服务端零报错、日志显示「开始发布直播」，但画面永远是黑的，几秒后卡片退化成耳机图标。

完整的启动命令（注意 1935 和 40000 的映射）：

```bash
docker run -d \
  -p 4991:4991/tcp \
  -p 40000:40000/tcp -p 40000:40000/udp \
  -p 1935:1935/tcp \
  -v ./data:/home/bun/.config/sharkord \
  --restart unless-stopped \
  --name sharkord sharkord/sharkord:latest
```

改完重启服务端。想在日志里确认是否生效：临时把 `[server] debug` 设为 `true`，启动日志会出现 `WebRtcServer created on port 40000 with announcedAddress ...`，验证后改回 `false`。

### 4. 推流

在聊天里发 `/live`，会收到服务器地址、推流码和完整地址。摄像机只有一个地址栏时用完整地址：

```
rtmp://<对外地址>:<对外端口>/live/<streamKey>
```

OBS 分栏填写：

```
服务器：rtmp://<对外地址>:<对外端口>/live
串流密钥：<streamKey>
```

端口默认 1935。若映射成 `-p 19350:1935`，把设置里的「对外推流端口」填 19350，命令给出的地址就会带上正确端口。

> 推流码等同密码——拿到地址的人都能推。泄露后发 `/live-refresh`，旧地址立即失效。

### 大疆 Action 6

Action 6 只能通过 **DJI Mimo App** 直播（相机本体没有直播菜单），自定义 RTMP 只有一个地址栏，地址和推流码必须拼成一条：

1. 手机连相机（DJI Mimo → 连接设备），进到相机图传界面
2. 点底部「直播」→ 平台选 **RTMP**
3. 先连 Wi-Fi：选手机的热点，输入热点名和密码（在填地址之前）
4. 地址栏粘贴 `/live` 给出的完整地址，**中间不能有空格**
5. 分辨率选 **1080P**，码率选 **6 Mbps**（官方只有 3 / 6 Mbps，帧率固定 30fps）
6. 点「开始直播」，界面出现直播窗口即推送成功
7. 结束时**必须在 App 里点「结束直播」**——只关相机不会断开推流

## 配置项

| 设置 | 说明 |
|---|---|
| 直播频道 | 频道选择器。没选（值为 0）时收到推流也不会发布 |
| RTMP 监听端口 | 默认 1935，插件在容器内监听的端口 |
| 对外推流域名 / IP | 推流地址里显示的域名或 IP。容器里看不到公网地址，**Docker 部署必须填**。留空则用语音服务的对外地址 |
| 对外推流端口 | 推流地址里显示的端口，即宿主机映射出去的那个。填 `0` 表示与监听端口相同 |
| 视频处理 | `转码`（默认，兼容性好）或 `直通`（省 CPU，仅当源是 H.264 Baseline） |
| 转码码率 | 默认 2500 kbps。大疆 1080p 源最高 6 Mbps，想更清晰可调到 4000 |
| ffmpeg 路径 | 留空则依次找插件数据目录下的 ffmpeg、系统 PATH |

## 命令与权限

| 命令 | 作用 |
|---|---|
| `/live` | 把当前推流地址（服务器 / 推流码 / 完整地址）+ 当前状态发给执行者 |
| `/live-refresh` | 换一个新的推流码，立即断开正在进行的推流，返回新地址 |

两条命令都是临时消息，不写进频道历史。

**谁能用由权限页决定**（服务器设置 → 插件 → 权限）：勾上的角色即可使用，改配置不用改代码。没动过配置时默认跟随 `MANAGE_PLUGINS`，等于只有管理员。

注意宿主还有一道前置权限：**任何插件命令都要求「使用插件」（`USE_PLUGINS`）**。角色缺这个权限时，`/` 菜单里根本不会出现这两条命令。

## 排查

按这个顺序，每一步都能把问题范围砍一半：

| 现象 | 说明 | 查什么 |
|---|---|---|
| 日志没有「收到推流」 | 包根本没到插件 | 推流端地址、1935 映射、`docker logs \| grep "rtmp connect"` |
| 有「收到推流」但「还没选择直播频道」 | 设置里频道没选 | 插件设置 → 直播频道 |
| 出现「找不到可执行文件 "ffmpeg"」 | 容器里没有 ffmpeg，与反代、端口、推流端都无关 | 见上方「准备 ffmpeg」 |
| 有「开始向频道 N 发布直播」但浏览器黑屏 | 服务端链路已通，问题在浏览器侧 | 下面两行 |
| 卡片变耳机图标 | 视频 track 被移除，通常是 consumer transport 挂了 | 浏览器 F12 搜 `ice failed` |
| `consumer transport: connection state failed` | ICE 连不上，几乎都是 `announcedAddress` | 见上方第 3 步 |
| 有画面但卡顿 / 花屏 | 码率或 CPU | 调低转码码率，确认容器 CPU 没打满 |

0.2.3 起，ffmpeg 缺失会在建流**之前**就报错，日志里直接写出三个解析位置和两种解法，不会再出现「卡片闪一下就消失」。

服务端侧最有用的两条日志：

```
有观众开始观看（视频）      ← 浏览器真的建了 consumer
ffmpeg ... -f rtp ...      ← 实际启动的转码命令
```

「有观众开始观看」一直不出现，说明浏览器没订阅（多半是没进对频道）；出现了但黑屏，就是传输层或解码问题。

## 已知限制

- **只支持一路推流。** 已在推流时第二路会被直接拒绝，不会打断第一路。
- **ffmpeg 要自备。** 插件不会自动下载二进制。
- **直通模式对源有要求。** Producer 声明的 H.264 参数是 Baseline 3.1；源不匹配时画面可能是黑的，先切回转码模式验证。
- **无观众超时断流还没做。** 相机一直推、频道一直没人时，RTMP 会话会一直挂着（`gop_cache` 已关闭，不会累积帧缓存）。
- **插件文案目前只有中文。** 宿主没有按语言查表的接口，`settings.register` / `commands.register` 的文案是注册时写死的单个字符串。
- **只在单个实例上验证过。** 单频道、单路、Docker + Windows 宿主机。

## 开发

构建、部署、发版与插件市场上架的流程见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)，实施计划与联调记录见 [`docs/rtmp-live-plan.md`](docs/rtmp-live-plan.md)。

## 许可

[MIT](LICENSE) © 2026 AndreasByrsting
