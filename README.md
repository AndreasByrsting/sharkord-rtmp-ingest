# RTMP Live for Sharkord

**简体中文** | [English](README.en.md)

接受一路 RTMP 推流，把它发布成 Sharkord 语音频道里的直播画面。为「大疆 Action 推流到频道」而做，但任何能推 RTMP 的软件（OBS、Larix 等）都兼容。

> **状态**：已在本机 Docker 版 Sharkord（v0.0.28）+ Windows 宿主机端到端跑通 —— 插件加载、RTMP 收流（H.264 + AAC）、推流码校验、ffmpeg 转码、RTP 进 mediasoup、浏览器出画面。
>
> 实测踩到的两个环境坑（都不是插件问题）写在下面的「部署必须做的三件事」里，其中 `webRtc.announcedAddress` 不配会在浏览器端表现为**画面永远出不来**。

## 它怎么工作

```
OBS / 大疆 Action
      │  RTMP 推流  rtmp://<host>:1935/live/<streamKey>
      ▼
node-media-server ── 校验推流码，始终保持会话
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

插件不是独立服务，也不占额外端口对外 —— 它被 Sharkord 进程 `import()` 进来，复用自己的语音运行时（mediasoup router）。

两个条件独立，决定插件做什么：

| 推流端 | 频道里有听众 | 结果 |
|---|---|---|
| 在推 | 没人 | 只保持 RTMP 会话，不起转码，不占 CPU |
| 在推 | 有人 | 自动起 ffmpeg，画面进频道 |
| 在推 | 人刚走光 | 停 ffmpeg、移除卡片，**RTMP 会话不断**；下一个人进来自动恢复 |
| 断开 | — | 停 ffmpeg，回到空闲 |

ffmpeg 与 mediasoup 跑在同一个进程树里，RTP 走 `127.0.0.1`，因此**不需要为转码链路额外映射 UDP 端口**。

## 项目结构

| 路径 | 作用 |
|---|---|
| `src/server/index.ts` | 插件入口：设置项注册、事件监听、`/live` 与 `/live-refresh` 两条命令 |
| `src/server/session.ts` | 状态机：把「推流会话」和「频道语音运行时」两个生命周期串起来，所有转换串行化 |
| `src/server/rtmp-server.ts` | `node-media-server` 封装：路径解析、推流码校验、单路互斥、踢流 |
| `src/server/bridge.ts` | ffmpeg → RTP → mediasoup PlainTransport ×2 → Producer ×2 → `createStream` |
| `src/server/ffmpeg.ts` | 转码参数组装、ffmpeg 定位、子进程管理 |
| `src/server/keys.ts` | 32 位随机推流码、持久化、轮换、定时安全比较 |
| `src/types.ts` | 服务端与（曾经的）浏览器端之间的契约；现在只剩两条命令的声明 |
| `src/client/index.ts` | 空模块 —— 打包器要求这个入口存在。插件没有前端 |
| `build.ts` / `scripts/deploy.ts` | 构建并把产物复制进服务端插件目录 |
| `icon.svg` / `logo.svg` / `logo.png` | 插件图标。`icon.svg` 是原始标记；`logo.svg`/`logo.png` 是加了白底圆角的版本 —— 原来的黑色描边在 Sharkord 的深色卡片上几乎看不见 |
| `scripts/registry.ts` | 从构建产物生成官方注册表要的两个文件，输出到 `registry/` |
| `docs/rtmp-live-plan.md` | 实施计划、阶段拆解、联调记录（含 5 个已修 bug 的排查过程） |

## 安装

插件不是独立容器，而是被 Sharkord 进程 `import()` 进来的 JS。所以只要把构建产物放进服务端的插件目录，重启服务端即可。

```bash
bun install
bun run build
bun run deploy /path/to/sharkord/plugins   # 或把路径写进 .env 的 SHARKORD_PLUGINS_PATH
```

插件目录在哪：

| 部署方式 | 插件目录 |
|---|---|
| Docker（`-v ./data:/home/bun/.config/sharkord`） | 宿主机的 `./data/plugins` |
| 裸机 / 二进制 | `~/.config/sharkord/plugins` |
| 开发环境 | `<sharkord repo>/apps/server/data/plugins` |

服务端只在启动时扫描插件目录（目录监听只处理「插件被删掉」），**新增插件必须重启服务端**。重启后在「服务器设置 → 插件」里确认它是启用状态。

### 部署必须做的三件事

**1. 配置 `webRtc.announcedAddress`**

这是最容易漏、也最难自查的一步。`config.ini` 里留空时，Sharkord 会去第三方接口查**公网 IP**，然后把它作为 ICE 候选地址发给浏览器。局域网或本机访问时，浏览器往公网 IP 发包需要 NAT 回环，Windows 上不通，于是 ICE 直接失败。

失败时的表现极具误导性：视频 consumer 创建成功、服务端零报错、日志显示"开始发布直播"，但浏览器画面永远是黑的，几秒后卡片退化成耳机图标。

```ini
[webRtc]
port=40000
announcedAddress=192.168.1.86   ; 填浏览器实际能访问到的那个地址
maxBitrate=30000000
```

改完重启服务端。确认是否生效：临时把 `[server] debug` 设成 `true`，启动日志里会出现

```
debug: WebRtcServer created on port 40000 with announcedAddress 192.168.1.86
```

验证完记得改回 `false`。

**2. 映射端口**。插件在容器内监听 1935，不映射外面的设备推不进来；40000 是 Sharkord 的 WebRTC 端口，必须 TCP 和 UDP 都映射：

```bash
docker run -d \
  -p 4991:4991/tcp -p 40000:40000/tcp -p 40000:40000/udp \
  -p 1935:1935/tcp \
  -v ./data:/home/bun/.config/sharkord \
  --name sharkord sharkord/sharkord:latest
```

**3. 给容器准备 ffmpeg**。官方镜像里没有 ffmpeg，两个办法：

- **不放镜像里**（推荐，插件已经支持）：把 Linux 静态 ffmpeg 放到宿主机
  `./data/plugin-data/sharkord-rtmp-live/ffmpeg`，插件启动时会自动用它。
  `plugin-data` 目录是挂载进容器的，所以这个二进制必须是 **Linux x86_64** 的，
  不能拿 Windows 的 `ffmpeg.exe`。放好后 `chmod +x` 并确认容器内能执行。
- **自建镜像**：`FROM sharkord/sharkord:latest` + `apt-get install -y ffmpeg`，
  然后把 `ffmpegPath` 设成 `/usr/bin/ffmpeg`（或留空，PATH 里能找到）。

## 生产部署

插件不是镜像，也不需要打 `.tar.gz`：`dist/sharkord-rtmp-live/` 就是最终形态。

```
sharkord-rtmp-live/
├── manifest.json
├── server/index.js      ← 单文件，依赖已内联
└── client/index.js      ← 空模块，但三件套必须齐
```

```bash
# 构建机
bun run build
tar -cf rtmp-live.tar -C dist sharkord-rtmp-live

# 生产机（不需要 bun / node）
tar -xf rtmp-live.tar -C /path/to/data/plugins
docker restart sharkord
```

为什么不用打包：宿主 `import()` 的是已经打平的 `server/index.js`，运行时不碰 `node_modules`；插件和容器镜像也没有关系，所以既不需要 `docker build`，也不需要改镜像。

- **必须重启**：宿主对插件目录的监听只处理「插件被删除」，不处理「新增」
- **升级**：覆盖目录 + 重启。`bun run build` 会先删目标目录再拷贝，不会留陈旧文件
- **不会丢数据**：ffmpeg 在 `data/plugin-data/sharkord-rtmp-live/`，推流码在 `data/db.sqlite`，都不在 `plugins/` 下
- **权限配置也不会重置**：权限页的白名单存在数据库里，升级后照旧

### 能不能放进插件市场

能，但没法直接丢进去。市场不是导入通道，而是一份固定榜单 —— `packages/shared/src/plugins/marketplace.ts` 里：

```ts
const MARKETPLACE_REGISTRY_URL =
  'https://raw.githubusercontent.com/Sharkord/plugins/refs/heads/main/plugins.json';
```

客户端渲染列表、服务端执行安装都读这一个地址，没有任何环境变量能覆盖。服务端的安装流程是「按 id + version 查榜单 → 下载 `downloadUrl` → 校验 sha256 → 解包覆盖」，所以既没有「从 URL 安装」，也没有「上传压缩包」。

要上榜的完整步骤见下面的[发布到插件市场](#发布到插件市场)。这里只说清楚一件事：市场里**没有**「从 URL 安装」，也**没有**「上传压缩包」—— 服务端只认榜单里的 `id + version`，下载 `downloadUrl`、校验 sha256、解包覆盖，全部由它自己完成。

`verified` 只有官方能改成 true，第三方一律 false，不影响安装和升级。

### 上线检查表

- [ ] 容器加 `--restart unless-stopped`（默认 `restart=no`，宿主机重启后不会自己起来）
- [ ] `[webRtc] announcedAddress` 填浏览器实际能访问到的地址
- [ ] 1935/TCP 已映射；换过端口的话「对外推流端口」要同步
- [ ] ffmpeg 已放在 `data/plugin-data/sharkord-rtmp-live/ffmpeg`（Linux x86_64 + `chmod +x`）
- [ ] 备份 `data/`（`db.sqlite` 里存着推流码）
- [ ] 权限页按需勾选角色，并确认这些角色有「使用插件」权限

## 配置项

| 设置 | 说明 |
|---|---|
| 直播频道 | 频道选择器。没选（值为 0）时收到推流也不会发布 |
| RTMP 监听端口 | 默认 1935，插件在容器内监听的端口 |
| 对外推流域名 / IP | 推流地址里显示的域名或 IP。容器里看不到公网地址，**Docker 部署必须填**。留空则用语音服务的对外地址 |
| 对外推流端口 | 推流地址里显示的端口，即宿主机映射出去的那个。填 `0` 表示与监听端口相同；`-p 19350:1935` 这种映射下要填 19350 |
| 视频处理 | `转码`（默认，兼容性好）或 `直通`（省 CPU，仅当源是 H.264 Baseline） |
| 转码码率 | 默认 2500 kbps。大疆 1080p 源最高 6 Mbps，想更清晰可调到 4000 |
| ffmpeg 路径 | 留空则依次找插件数据目录下的 ffmpeg、系统 PATH |

## 推流地址

摄像机（只有一个地址栏）：

```
rtmp://<对外地址>:<对外端口>/live/<streamKey>
```

OBS（地址与密钥分栏）：

```
服务器：rtmp://<对外地址>:<对外端口>/live
串流密钥：<streamKey>
```

端口默认 1935；`-p 19350:1935` 这种映射下，地址里要写 19350（把「对外推流端口」设成 19350，命令给出的地址就是对的）。

推流码等同密码 —— 拿到地址的人都能推流。泄露后发 `/live-refresh`，旧地址立即失效、正在进行的那一路会被断开。

### 大疆 Action 6 怎么填

Action 6 只能通过 **DJI Mimo App** 直播（相机本体没有直播菜单），自定义 RTMP **只有一个地址栏**，所以地址和推流码必须拼成一条：

1. 手机连相机（DJI Mimo → 连接设备），进到相机图传界面
2. 点底部「直播」→ 平台选 **RTMP**
3. 先连 Wi-Fi：选手机的 4G/5G 热点，输入热点名和密码（这一步在填地址之前）
4. 地址栏粘贴 `/live` 给出的完整地址，形如 `rtmp://live.example.com:1935/live/<streamKey>`，**中间不能有空格**
5. 分辨率选 **1080P**，码率选 **6 Mbps**（官方可选项只有 3 / 6 Mbps，帧率固定 30fps）
6. 点「开始直播」，界面出现直播窗口即推流成功
7. 结束时**必须在 App 里点「结束直播」** —— 只关相机不会断开推流，会话会一直挂着

画面要在有人进入直播频道后才出现（见上面的两条规则）。

## 命令与权限

只有两条命令，回复只发给执行者本人：

| 命令 | 作用 |
|---|---|
| `/live` | 把当前推流地址（服务器 / 推流码 / 完整地址）+ 当前状态发给你 |
| `/live-refresh` | 换一个新的推流码，立即断开正在进行的推流，把新地址发给你 |

**谁能用，完全由权限页决定**（服务器设置 → 插件 → 权限）：那里勾上的角色就是白名单，勾了谁谁能用，改配置不用改代码。

- 没动过配置时，默认跟 `requires: MANAGE_PLUGINS` 走 —— 等于只有管理员。
- 想让某个角色也能用：在那个页面选中角色、把两条命令打开即可。
- 注意宿主还有一道前置权限：**任何插件命令都要求「使用插件」（`USE_PLUGINS`）**。勾上的角色如果没有这个权限，`/` 菜单里根本不会出现这两条命令，得先去角色设置里给它加上。

没有 Tab、没有按钮、没有别的开关：权限页里只会出现这两条命令，别的都删掉了。

两条命令是 ephemeral（临时消息），不写进频道历史。如果执行后频道里没看到回复，用「服务器设置 → 插件 → 命令」标签页执行同名命令，返回内容会直接显示在设置页里。

### 多语言

**目前插件自身只提供中文文案**（设置项名称与描述、命令说明）。

这不是偷懒，是宿主没有对应的接口：`settings.register` 与 `commands.register` 的 `name` / `description` 都是**注册时写死的单个字符串**，插件加载时注册一次、对全服生效，宿主渲染时直接原样输出（`settings.tsx` 的 `<Group label={definition.name}>`、`commands.tsx` 的 `{command.description}`），没有任何按语言查表的入口，manifest 里也没有 `locales` 字段。

能做的是「回复跟随执行者语言」—— `executes(invoker)` 里能拿到 `invoker.locale`（`en` / `zh` / `cs` / `es` / `fr` / `it` / `ru` / `pt-BR`）。这一项规划在后续 PR 里做，届时会处理为「静态文案中英并排 + 命令回复按 locale 切换」。

## 画面出不来怎么查

按这个顺序，每一步都能把问题范围砍一半：

| 现象 | 说明 | 查什么 |
|---|---|---|
| 日志没有「收到推流」 | 包根本没到插件 | 推流端地址、1935 映射、`docker logs \| grep "rtmp connect"` |
| 日志有「收到推流」但「还没选择直播频道」 | 设置里频道没选 | 插件设置 → 直播频道 |
| 有「开始向频道 N 发布直播」但浏览器黑屏 | 服务端链路已通，问题在浏览器侧 | 见下面两行 |
| 卡片变耳机图标 | 视频 track 被移除，通常是 consumer transport 挂了 | 浏览器 F12 搜 `ice failed` |
| 浏览器 `consumer transport: connection state failed` | ICE 连不上，几乎都是 `announcedAddress` | 见「部署必须做的三件事」第 1 条 |
| 有画面但卡顿/花屏 | 码率或 CPU | 调低「转码码率」，或确认容器 CPU 没打满 |

服务端侧最有用的两条日志：

```
[观察] 有观众开始观看（视频）      ← 浏览器真的建了 consumer
ffmpeg ... -f rtp ...             ← 实际启动的转码命令
```

`有观众开始观看` 一直不出现，说明浏览器没订阅（多半是没进对频道）；出现了但黑屏，就是传输层或解码问题。

## 已知限制

- **只支持一路推流。** 已在推流时第二路会被直接拒绝，不会打断第一路。
- **ffmpeg 要自备。** 插件不会自动下载二进制。放 `plugin-data/sharkord-rtmp-live/ffmpeg`（Linux 静态构建），或在 `ffmpegPath` 里指路径。本机实测用的是 johnvansickle 静态构建（66 MB，含 libx264 + libopus）。
- **直通模式对源有要求。** Producer 声明的 H.264 参数是 Baseline 3.1；源不匹配时画面可能是黑的，先切回转码模式验证。
- **无观众超时断流还没做。** 相机一直推着、频道一直没人时，RTMP 会话会一直挂着（`gop_cache` 已关闭，不会累积帧缓存）。
- **只在单个实例上验证过。** 单频道、单路、Docker + Windows 宿主机。

## 开发

```bash
bun run setup    # 拉取 SDK / builder 到 .repos 并 link（首次）
bun run build    # 构建，若 .env 有 SHARKORD_PLUGINS_PATH 则顺带部署
bun run deploy   # 只部署
bunx tsc --noEmit
```

注意事项：

- `ctx.path` 每次更新都会被删除，要留下的东西写 `ctx.dataPath`；推流码存在 `ctx.storage` 里。
- 插件没有前端部分（`src/client/index.ts` 是空模块）。打包器要求这个入口存在，但插件不再注册 Tab / 组件，所以普通用户的浏览器根本不会加载它。
- `sdkVersion` 必须和服务端完全一致，`bun run build` 会自动写入。
- `version` 取自 `package.json`，不是 `manifest.json`。
- `settings.register` 的定义必须保留 `as const`，否则 `settings.get` 丢类型。
- `bunx tsc --noEmit` 会报链接进来的 SDK 包自身的错误（`@sharkord/shared` 反向 import 了 `apps/server` 的类型），只看 `src/` 下的；`tsconfig.json` 已把检查范围限定在 `src`/`scripts`/`build.ts`/`publish.ts`。
- `publish.ts` 不再硬编码仓库：读 `GITHUB_REPOSITORY`（GitHub Actions 自带）或 `package.json` 的 `repository`，两者都没有就报错退出。

实施计划与阶段拆解见 [`docs/rtmp-live-plan.md`](docs/rtmp-live-plan.md)。

## 发布到插件市场

官方市场就是 [`Sharkord/plugins`](https://github.com/Sharkord/plugins) 仓库里的一份注册表，服务器启动时拉它的 `plugins.json`。插件代码不必住进那个仓库，只有元数据要进去。

1. **先发 GitHub Release**：tag 用 `v<version>`，附件放 `<id>-<version>.tar.gz` 和 `<version>.json` 两个文件。`bun run publish` 一次做完（要 `GITHUB_TOKEN`；仓库地址从 `GITHUB_REPOSITORY` 或 `package.json` 的 `repository` 读）。
2. **生成 PR 要的两个文件**：`bun run registry`（要先 `bun run build`）。它会读 `manifest.json` 和 `dist/<version>.json`，把结果写到 `registry/plugins/sharkord-rtmp-live/`，目录结构与官方仓库一致，可直接拷进去。
   - `plugin.json`：`id`/`name`/`description`/`author`/**`logo`（必填，公网可访问的图片 URL）**/`homepage`/`tags`/`categories`/`screenshots`
   - `versions/<version>.json`：`version`、`downloadUrl`（Release 附件的 HTTPS 地址）、`checksum`（附件的 sha256）、`sdkVersion`、`size`、`timestamp`
3. **往 `Sharkord/plugins` 提 PR**，把 `registry/plugins/sharkord-rtmp-live/` 整个目录放进去。
4. CI 会跑 `bun run validate`：缺字段、`id` 与目录名不一致、版本号与文件名不一致都会失败。合并后维护者重新生成 `plugins.json`，所有服务器立刻可见。
5. `verified` 不归你填：它在 `Sharkord/plugins` 的 `scripts/statics.ts` 里写死成白名单，只有维护者认可的作者会被加进去。它代表「认得这个发布者」，不代表代码被审计。
6. `tags` / `categories` 目前允许的取值都是空数组，只能留空。

两个硬约束：`sdkVersion` 必须等于服务器当前的 SDK 版本（现在是 2），不匹配的版本不会出现在那台服务器的市场里，每次 SDK 升版都要重发；Release 附件会被维护者拿去 VirusTotal 扫描。

`logo` 用的是 jsDelivr 上的固定提交地址（`cdn.jsdelivr.net/gh/<owner>/<repo>@<commit>/logo.png`）—— 换来的是「一次写死、永不失效」，代价是换图标时要连地址一起换。另一个受支持的写法是 GitHub raw，但这台机器上它被代理挡掉了，jsDelivr 反而通。

只想自己用的话完全不需要这套流程 —— 把 `dist/sharkord-rtmp-live/` 拷进插件目录就行。

## 许可

[MIT](LICENSE) © 2026 AndreasByrsting，与 `package.json` 的 `license` 字段一致。
