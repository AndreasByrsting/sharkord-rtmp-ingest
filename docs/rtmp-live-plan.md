# Sharkord RTMP 直播插件 —— 实施计划

> 状态：已实施，见 5.1–5.4 的施工与联调记录。
> 基础：官方插件脚手架（sdkVersion 2），构建与发布脚本归本仓库所有。
>
> **注意**：2.1 / 4.6 / P5 里描述的管理 Tab 与 4 个 action 已在 5.4 中删除，命令与权限以 **5.4 和 README 为准**，其余章节保留当时的设计过程供回溯。

## 1. 已确定的约束（来自本轮确认）

| 项 | 决定 | 对设计的影响 |
|---|---|---|
| 部署形态 | Docker | 需额外映射 1935/TCP；推流地址必须可配置为公网地址，不能用容器内网 IP |
| 推流端 | 通用 RTMP 优先，主力是大疆 Action | 地址必须是一条完整 URL（大疆只有一个地址栏），串流密钥编进路径 |
| 并发 | 单频道单路 | 状态机可写单例，不需要 `Map<channelId, session>` |
| 环境 | 先计划、后动手 | 当前 `bun` 未安装，`bun run setup` 从未执行 |

## 2. 交付物定义

### 2.1 用户看到的东西

管理员视角：

1. 服务端设置 → 插件页 → 「直播」Tab
2. 选择一个语音频道作为直播目标，点「生成推流地址」
3. 得到一条 URL 和对应二维码文本，可复制、可轮换、可吊销

推流端视角（大疆 Action，自定义 RTMP）：

```
rtmp://<公网地址>:1935/live/<streamKey>
```

直接整条粘进「RTMP 地址」栏，无第二个输入框。

推流端视角（OBS / 通用软件，地址与密钥分栏）：

```
服务器：rtmp://<公网地址>:1935/live
串流密钥：<streamKey>
```

两者落到同一个 RTMP 路径 `/live/<streamKey>`，解析逻辑只有一份。

观众视角：目标语音频道里出现一个由插件发布的外部流（`createStream` 产生的卡片），进入频道即可观看，无需任何操作。

### 2.2 系统行为

- 推流开始但频道无人 → RTMP 会话保持，不起转码（省 CPU）
- 有人进入目标频道 → 自动起 ffmpeg，画面进频道
- 频道最后一人离开 → 停 ffmpeg、移除流卡片，**RTMP 会话不断**
- 推流端断开 → 停 ffmpeg、移除流卡片、回到空闲
- 已有推流在跑时第二路推流到达 → 拒绝并断开（单路约束）
- 插件卸载/禁用 → 关端口、杀所有子进程、移除流

## 3. 架构与文件划分

```
src/
  server/
    index.ts          onLoad/onUnload/onUpgrade，settings/commands/actions/events 注册
    rtmp/keys.ts      推流码生成、持久化（ctx.dataPath/stream-keys.json）、轮换、校验
    rtmp/ingest.ts    node-media-server 启停、publish/unpublish 回调、路径解析
    rtmp/bridge.ts    PlainTransport ×2 + Producer ×2 + createStream 句柄
    rtmp/ffmpeg.ts    ffmpeg 定位/下载、编码探测、命令行组装、子进程生命周期
    rtmp/session.ts   状态机（唯一的"有状态"模块）
  types.ts            TPlugin 契约（actions/commands/push）
  client/
    index.ts          components + tabs 导出
    admin-tab.tsx     推流码管理界面
    status-badge.tsx  可选：VOICE_USER_CARD 上的推流角标
manifest.json         id 改为 sharkord-rtmp-live
package.json          name 同步
```

`manifest.json` 的 `id` 必须与安装后的文件夹名一致（文档要求），所以改名要三处同步：`manifest.json.id`、`package.json.name`、构建产物目录。

## 4. 关键技术决策

### 4.1 RTMP 收流：node-media-server

在其 `rtmp` 配置上开 1935，用 `postPublish` / `donePublish` 两个回调驱动状态机。取 `session.publishStreamPath`（形如 `/live/<key>`），取最后一段作为 streamKey 校验。

选它而不是自己实现 RTMP 握手：握手 + AMF0 + chunk 解析自写至少上千行，而这个包是现成的。

### 4.2 鉴权：路径即凭证

单频道单路的前提下不需要账户体系：

- 生成 32 位随机 `streamKey`，存 `ctx.dataPath/stream-keys.json`
- 校验失败 → `session.reject()` 直接断开，日志记来源 IP
- 支持一键轮换（旧码立即失效）

代价必须写清楚：**1935 暴露在公网，知道 URL 的人就能推流**。这是 Twitch/B站 同款模型的固有风险，缓解手段是"码足够随机 + 可轮换"。

### 4.3 转码桥：ffmpeg → PlainTransport → createStream

沿用官方 Voice 文档给的形状（两个 media 类型各自一个 `PlainTransport`，`comedia: true, rtcpMux: true`），差别只在于 RTP 的来源是本机 ffmpeg 而不是外部服务。

关键点：**ffmpeg 与 mediasoup 在同一个容器里，这一跳走 127.0.0.1，不需要任何端口映射**。Docker 只需要额外开 1935/TCP；给观众用的 WebRTC UDP 段是服务端原本就有的。

视频默认直通（`-c:v copy`，payload type 96），因为大疆 Action 输出 H.264；启动前用 ffprobe 探测编码，非 H.264 时才退回 `libx264 -tune zerolatency`。音频必须转码：RTMP 里是 AAC，mediasoup 这条链路要 Opus（`-c:a libopus -ar 48000 -ac 2`，payload type 111）。

命令行形状（两条输出，一个进程）：

```
ffmpeg -rtmp_live live -i rtmp://127.0.0.1:1935/live/<key> \
  -map 0:v:0 -c:v copy -an -f rtp -payload_type 96  -ssrc <v> rtp://127.0.0.1:<vPort>?pkt_size=1200 \
  -map 0:a:0 -vn -c:a libopus -ar 48000 -ac 2 -f rtp -payload_type 111 -ssrc <a> rtp://127.0.0.1:<aPort>?pkt_size=1200
```

### 4.4 ffmpeg 从哪来

已实测：本机 PATH 里没有 ffmpeg。Docker 部署下的三个选项，优先顺序：

1. **设置项 `ffmpegPath`**：管理员显式指定，最可控
2. **自定义镜像**：`FROM <sharkord 镜像>` + 装 ffmpeg，一劳永逸，但要能重建镜像
3. **运行时自动下载**（官方 IPTV 插件的做法）：下到 `ctx.dataPath`，首次使用触发，注意容器重建后 dataPath 是否在卷上

计划里按「先支持 1 和 3，文档推荐 2」实现。

### 4.5 状态机（唯一的复杂点）

SDK 文档明确：语音运行时只在频道里有人时存在，`createStream` 在没有运行时会抛异常；同时又给出了 `voice:runtime_initialized { channelId }` 和 `voice:runtime_closed { channelId }` 两个事件（来源：Sharkord 插件文档 Events 章节）。所以状态由两组互相独立的条件组合而成：

| 推流端 | 频道运行时 | 状态 | 动作 |
|---|---|---|---|
| 无 | 无 | `IDLE` | — |
| 有 | 无 | `INGESTING` | 只保 RTMP 会话，日志提示"等待观众" |
| 无 | 有 | `IDLE` | — |
| 有 | 有 | `LIVE` | 建 transport → 起 ffmpeg → `createStream` |

迁移触发：`postPublish`、`donePublish`、`voice:runtime_initialized`、`voice:runtime_closed`，外加 `onLoad` 时的**补状态**（服务端重启/插件中途启用时，频道里可能已经有人，事件不会补发）。

两处坑：

- 事件处理器 **10 秒超时**（文档明确）。`createStream` 和起 ffmpeg 不能在 handler 里 `await` 到底，必须 fire-and-forget 后立即返回。
- 状态迁移要串行化（一个 promise chain 或简单 mutex），否则"推流进来"和"人进频道"同时到达会起两个 ffmpeg。

### 4.6 UI

- **管理**：`tabs` 导出，一个「直播」Tab（只有能管插件的人看得到）。展示状态、推流地址、轮换/吊销按钮、频道选择器。频道列表从 `useStoreSelector` 拿。
- **观众侧**：不需要额外组件。`createStream` 产生的卡片由宿主渲染。可选加一个 `VOICE_USER_CARD` 角标显示"直播中"，但不是必需。

样式遵守脚手架 README 的约束：内联样式 + `var(--*)` 主题变量，不用 Tailwind 类。

## 5. 阶段计划

### P0 环境打通（不动业务代码）

- 装 bun（当前缺失，`build.ts`/`setup.ts` 都是 bun 脚本）
- `bun run setup`：clone `Sharkord/sharkord` 与 `plugin-builder` 到 `.repos/`，`bun link` 三个包
- 建 `.env`，填 `SHARKORD_PLUGINS_PATH`（Docker 下指向挂载到容器的那个宿主目录）
- 重命名插件（manifest / package / 目录）

**验收**：`bun run build` 成功，服务端日志出现插件加载成功的记录，管理界面能看到插件。

**风险**：`.repos` 需联网拉两个仓库；SDK 是 v2 实验版，`sdkVersion` 必须与服务端完全一致，服务端升级后要跟着重建。

### P1 三个可行性验证（先做，不通就不往下写）

这三件事决定整个方案成不成立，各有退路，但退路会改变实现方式，所以必须先验证。

1. **依赖能不能进包**：写最小的 `import NodeMediaServer from "node-media-server"` + 监听 1935，`bun run build` 出包后装进服务端，看进程能否起来、OBS 推 10 秒能否收到 `postPublish`。
   退路：`build.ts` 里把依赖标成 external，构建时把 `node_modules` 一起拷进插件目录（这一步我们会改 `build.ts`，是可控的）。
2. **ffmpeg 在容器里有没有**：`docker exec <容器> which ffmpeg`。没有就先手工拷一个静态包进去，验证 RTP 输出可用。
3. **PlainTransport 能不能收到本机 RTP**：先用 `ffmpeg -re -f lavfi -i testsrc` 推测试图，目标频道里能看到动起来的测试卡。

**验收**：三段独立跑通，各自留下可复现的命令。任一段失败先解决，不写业务代码。

### P2 收流与鉴权

- 推流码生成/持久化/轮换
- `postPublish` 校验路径，单路互斥（已在推则 reject）
- `donePublish` 清理

**验收**：错误 key 被拒；正确 key 建立会话；第二路推流被拒；轮换后旧 key 立即失效。

### P3 转码桥

- ffmpeg 定位与下载、编码探测
- 两个 PlainTransport + Producer（payload type / ssrc 与 ffmpeg 命令严格对齐）
- `createStream` 注册与 `remove`

**验收**：大疆实机推流，频道内画面与声音正常，延迟在可接受范围。

### P4 状态机

- 四个事件 + onLoad 补状态，串行化迁移
- 无人时只保 RTMP；有人自动起；最后一人离开自动停
- 崩溃恢复：ffmpeg 意外退出时重试一次，仍失败则移除流并记日志

**验收**：按 2.2 的六个场景逐条验证，尤其"进出频道多次"和"推流中途进人"。

### P5 UI 与命令

- 管理 Tab（状态、地址、轮换）
- 命令：`/live status`、`/live url`（管理员）、`/live stop`
- 动作：给 UI 用的增删查

**验收**：无 UI 也能靠命令跑完全流程，UI 只是包装。

### P6 Docker 交付

- compose 补 `1935:1935/tcp`
- `publicHost` 设置项（推流地址里对外展示的地址，容器内看不到公网 IP）
- 若选自定义镜像：给 Dockerfile 片段
- 一份给推流端的接入说明（大疆菜单路径 + OBS 填法）

**验收**：从零按文档部署一次，能走通。

## 5.1 施工记录（2026-10-30）

仓库已重置为干净状态（模板仓库带来的 `.git` 已删除，重新 `git init -b main`），插件身份改为 `sharkord-rtmp-live`。

**已完成**

- **P0 环境**：bun 1.4.4 安装完成。注意 npm 的 `bun` 包在这台机器上装不了（它的 postinstall 检测不到平台包）；GitHub release 直链也被代理拦（curl 空响应、`Invoke-WebRequest` 拿到截断文件）。最终走 `@oven/bun-windows-x64@1.4.4` 这个 npm 平台包取出 `bun.exe`，放到 `~/.bun/bin/`。
- **SDK 获取**：`git clone` 全程 `CONNECT tunnel failed, response 502`，但 `api.github.com` 可达。改用 `https://api.github.com/repos/<owner>/<repo>/tarball/<branch>` 下载 tarball 解压到 `.repos/`，再手工 `bun install --ignore-scripts` + `bun link`，等价于 `bun run setup`。
- **P1-1（最高风险项）已验证通过**：`node-media-server@2.7.4` 能被 bun 打成单文件 —— 194 个模块 → 1.0 MB，产物里只剩一个 `require("util")`，`node-media-server` 字符串（"Node Media Rtmp Server started"）已内联，运行时成功监听端口。**不需要走 external + 携带 node_modules 的退路。**
- **类型检查通过**：`tsc --noEmit` 对本项目零错误。`mediasoup@3.19.19` 的类型被真实解析（不是 `any` 兜底），因此 `createPlainTransport` / `transport.tuple.localPort` / `produce` / `createStream` 的调用形状都是校验过的。
- **构建通过**：`bun run build` 产出 `dist/sharkord-rtmp-live/`，`server/index.js` 1020 KB、`client/index.js` 8 KB，manifest 的 `sdkVersion` 自动补成 2。

**读源码后修正的三处误判**（文档没写清、只有源码里能看到）

1. `commands.register` / `actions.register` 的 `executes` 必须返回 `Promise`，同步返回类型不通过。
2. `PluginSettings.get` 对 `type: "enum"` 的映射是 `unknown`（`SettingValueType` 只特判 string / number / channel / role / boolean），必须显式断言。
3. action 的 `payload: void` 会让 `createCallAction` 变成零参调用（`payload extends void ? [] : [payload]`），比传空对象更符合设计意图。

另外发现文档与实际签名不一致：文档写 `ctx.voice.setServerMute(channelId, userId, muted)`，源码是 `setServerMute(userId, muted)`。本插件未使用，但后续要注意。

**仍未验证（需要真实环境）**

- 真实 RTMP 推流进 1935 的完整链路（本机无 ffmpeg，也未装 Sharkord 服务端）
- 大疆实机的推流参数与 H.264 profile 是否与 Producer 声明匹配
- 频道运行时的进出切换（`voice:runtime_initialized` / `_closed`）在真实服务端上的时序

**偏离原计划的地方**

- 视频默认改为 **转码**（原计划默认直通）。原因：直通时 SPS/PPS 来自摄像机，Producer 声明的 `profile-level-id` 可能与实际不符，导致黑屏；转码则由我们控制 profile，行为确定。直通保留为可选项。
- **ffmpeg 自动下载未实现**。原计划抄 IPTV 插件的做法，但自动下载需要一个可信的静态构建源，没确认前不写死 URL。当前只在「设置项 → 插件数据目录 → PATH」三处查找，找不到就在日志里报错。

## 5.2 真实部署记录（Docker，2026-10-30）

用户在 Windows + Docker Desktop 上跑 `sharkord/sharkord:latest`（v0.0.28），容器名 `sharkord`，挂载 `C:\Users\yuhao.gao\data → /home/bun/.config/sharkord`。

**插件根本不是容器。** 一条更正：早先讨论里「把插件打包成 docker」是错的。Sharkord 的做法是服务端进程用 `import(pathToFileURL(<plugins>/<id>/server/index.js))` 直接加载插件（`apps/server/src/plugins/index.ts:697`），插件目录是 `DATA_PATH/plugins`（`helpers/paths.ts:52`）。所以交付物就是 `manifest.json + server/index.js + client/index.js` 三个文件。

**加载时机（源码确认的三条）**

1. `init()` 只在启动时扫一次目录；`watch(PLUGINS_PATH)` 只回调 `reconcileRemovedPlugins()` —— 目录监听**只处理删除，不处理新增**。新增插件必须重启服务端。
2. `enablePlugins` 是服务端设置，`db/seed.ts` 里默认 `false`。本机已经是 `1`（用户先开过）。
3. 单个插件的启用状态在 `plugin_data` 表，`isEnabled` 默认 `false`。本次是直接往 db 写了 `('sharkord-rtmp-live', enabled=1, version='0.1.0')` 免去手动点开关（写前先停容器 + 备份 db + `wal_checkpoint(TRUNCATE)`，否则 WAL 里的数据不在备份里）。

**ffmpeg：容器里没有，且不需要重建镜像**

- `docker exec sharkord ffmpeg -version` → not found。官方镜像是 `oven/bun` + 单个编译好的二进制，没装 ffmpeg。
- 走的是插件自己的查找逻辑：`resolveFfmpegBin` 依次找「设置项 → `ctx.dataPath/ffmpeg` → PATH」。把 Linux 静态 ffmpeg 放到宿主 `data/plugin-data/sharkord-rtmp-live/ffmpeg` 即可，容器内路径 `/home/bun/.config/sharkord/plugin-data/sharkord-rtmp-live/ffmpeg`。
- 二进制来源：`@ffmpeg-installer/linux-x64@4.1.0` 的 npm tarball 里直接带 66 MB ELF（实测就是 johnvansickle 的静态构建，`--enable-libx264 --enable-libopus` 都在）。**不要用 `npm i`**，它按 `os` 字段拒绝在 Windows 上安装；直接 `curl registry.npmjs.org/...tgz` 解包取 `package/ffmpeg`。
- Windows bind mount 进容器后是 0644，要 `docker exec chmod +x` 一次。

**端口**

原启动命令只映射了 4991 和 40000，1935 没映射。重建容器时补 `-p 1935:1935/tcp`（`docker rm` 后重跑，data 全在挂载卷里，不丢）。重建后宿主机 `Test-NetConnection 127.0.0.1 -Port 1935` 为 True。

**实测结果**

| 项 | 结果 |
|---|---|
| 插件加载 | ✅ `Plugin loaded: sharkord-rtmp-live@v0.1.0`，`RTMP 服务器已监听 1935/tcp` |
| RTMP 收流 | ✅ 容器内 ffmpeg 推 `testsrc`，日志出现 `[rtmp publish] Handle video ... H264 640x360` + `Handle audio ... AAC` |
| 推流码校验 | ✅ 用 `WRONG_KEY_1234` 推流被拒（`[plugin] 拒绝推流: / WRONG_KEY_1234`），ffmpeg 报 I/O error |
| 画面进频道 | ⏳ 未验证，需要真人进语音频道触发 voice runtime |

**新增的设置项**：`publicPort`（对外推流端口，`0` = 同监听端口）。原来只有 `rtmpPort`，但 Docker 下宿主映射端口和容器监听端口可以不同（`-p 19350:1935`），而地址里必须写宿主那个。

## 5.3 联调踩到的坑（2026-10-30 下午）

### 5.3.1 语音运行时状态只靠事件会漏（无任何报错）

`voice:runtime_initialized` 只在「第一个人进入频道」时触发一次（`apps/server/src/runtimes/voice.ts:331`）。实际使用顺序是「先待在频道里 → 之后再到设置里选频道」，那个事件早就发完了，插件永远等不到 → **收到推流但画面不出现，日志里一条错误都没有**。

修法：`runtimeAlive(channelId)`（`ctx.voice.getState()` 包 try/catch，运行时不存在会 throw，见 `helpers/get-plugin-voice-runtime.ts`），在三处主动查：`onLoad`、`setting:set` 的 channel 变化、**每次 onPublish**。

### 5.3.2 `-ssrc` 超过 int32 导致 ffmpeg 启动即退出（极具欺骗性）

```
Value 4222222222.000000 for parameter 'ssrc' out of range [-2.14748e+09 - 2.14748e+09]
Error initializing output stream 1:0
```

ffmpeg 的 `-ssrc` 按**有符号 32 位**解析，原来的 `4111111111` / `4222222222` 全部越界。坑在于：这个错误**不会**让 `createStream` 失败，日志里照样打印「开始向频道 3 发布直播」，然后 ffmpeg 秒退。

因此判断链路是否真的通，不能只看「开始发布」，要看它后面有没有紧跟 ffmpeg 报错或「直播已停止」。改成 `1111111111` / `1222222222` 后，ffmpeg 稳定跑完 12 秒，日志顺序为：收到推流 → ffmpeg 命令 → 开始发布 → （推流结束）推流已断开 → 直播已停止。

### 5.3.3 一次假故障：OBS 报推流失败，其实是选了 Twitch

OBS 日志里 `Connecting to RTMP URL rtmp://live.twitch.tv/app` —— 「服务」下拉还是 Twitch 时，填的服务器地址会被平台地址覆盖。必须选「自定义」。排查时**先看 OBS 自己的日志**（`%APPDATA%\obs-studio\logs\*.txt`），比猜服务端快得多。

### 5.3.4 黑屏的真正原因：`webRtc.announcedAddress` 未配置（这轮耗时最长）

现象：浏览器控制台里视频 consumer **创建成功**，紧接着 transport 就 `failed`，卡片退化成耳机图标。服务端全程零报错，日志显示「开始向频道 3 发布直播」，mediasoup 的 Producer 也在稳定收包（packets 从 192 涨到 5670）。

排查过程里被两个假线索带偏过，记下来免得重犯：

- **`pli=0` 不能证明「没人订阅」**。当时据此判断"没有客户端拉流"，是错的：x264 每秒一个 IDR，浏览器拿到关键帧就不发 PLI。真正可靠的信号是 router observer 上的 `newconsumer`。
- **Producer stats 的 `type` 是 `inbound-rtp` 而非 `outbound-rtp`**。按 `outbound-rtp` 找会得到「无统计」，看起来像 RTP 没进 mediasoup，实际一直是好的。

真正的断点在 ICE。`apps/server/src/utils/mediasoup.ts:50`：

```ts
const announcedAddress = config.webRtc.announcedAddress || SERVER_PUBLIC_IP;
```

`config.ts:310` 里，`announcedAddress` 为空时会去第三方接口查**公网 IP**（`helpers/network.ts` 的 `getPublicIp`），再作为 ICE 候选发下去。浏览器在同一台机器/同一局域网时，往公网 IP 发包要 NAT 回环，Windows 上不通 → ICE failed。

所以正确做法是在 `config.ini` 的 `[webRtc] announcedAddress` 填**浏览器实际能访问到的地址**（本机联调填局域网 IP）。验证方式：临时开 `[server] debug`，启动日志出现 `WebRtcServer created on port 40000 with announcedAddress 192.168.1.86` 即为生效。

经验：这条链路上「插件日志正常 + mediasoup 在收包 + 浏览器黑屏」这个组合，基本可以直接指向 WebRTC 传输层，而不是码率、转码或 H.264 参数。

## 5.4 权限收缩：只留两条命令（2026-10-30 晚）

原设计有 1 条命令 + 4 个 action + 1 个管理 Tab，权限页上是 5 个开关（`live` / `status` / `keyInfo` / `rotateKey` / `stop`）。开关一多，实际用起来分不清、也容易配错（`keyInfo` 曾被误设成 `public`，等于把推流码开放给所有登录成员）。

改成只有两条命令，能力面收缩到最小：

| 命令 | 等价于原来的 | `requires` | 回复 |
|---|---|---|---|
| `/live` | `keyInfo` | `MANAGE_PLUGINS` | 服务器 / 推流码 / 完整地址 + 当前状态 |
| `/live-refresh` | `rotateKey` | `MANAGE_PLUGINS` | 换新码 + 断开当前推流 + 新地址 |

同时删掉：

- 4 个 action（`status` / `keyInfo` / `rotateKey` / `stop`）
- 「直播」管理 Tab 与整个前端 bundle（`src/client/index.ts` 现在是个空模块，只为满足打包器要求）
- `TPlugin.push` 契约与 `LiveSession` 的 `onStatus` 回调 —— 没有前端，状态推送没有消费者，状态改为只出现在 `/live` 的回复文本里

设计取舍：

- **为什么用命令而不是 action**：action 只能在插件自带的 UI 里点，还得先有 UI；命令在频道里直接发，零 UI，且权限页天然按命令粒度列出来。
- **为什么 `requires: MANAGE_PLUGINS`**：宿主在 `execute-command` 路由和 `send-message` 的命令分支上都会先校验 `USE_PLUGINS`，所以任何插件命令都绕不开「使用插件」这个全局权限。`requires` 本身只是**未被覆盖时的默认值**，真正决定谁能用的是权限页里那份角色白名单 —— 页面上存过覆盖后，`requires` 直接被忽略（`canUseResolvedCapability`）。因此把 `requires` 设成 `MANAGE_PLUGINS` 的含义是「默认只有管理员」，而不是「只可能管理员」。
- **曾加过又移除的第二道锁**：一度在 `executes` 里再用 `ctx.permissions.userCan(userId, MANAGE_PLUGINS)` 复核一次，目的是让权限页误配也漏不出去（`keyInfo` 被设成 public 那次就是这么漏的）。按需求「勾到的角色都能使用」移除，改回完全信任权限页。代价：把命令设成「所有人」就真的是所有 `USE_PLUGINS` 成员可用，配置时留意。
- **为什么 `ephemeral: true`**：回复不落库、只推给执行者。风险是宿主版本差异——本机跑的镜像（revision `0d9b296`）前端 bundle 里搜不到任何 `ephemeral` 相关代码，而 `v0.0.28` 标签的源码里已有 `showPluginEphemeralResponse`，说明这一版客户端**不会渲染**临时回复。兜底路径：用「服务器设置 → 插件 → 命令」标签页执行同名命令，返回内容直接显示在设置页。


## 6. 风险清单

| # | 风险 | 严重度 | 处置 |
|---|---|---|---|
| 1 | ~~`node-media-server` 能否被 bundle / 被 Sharkord 运行时解析，未知~~ **已验证通过**：打成单文件，194 模块 → 1.0 MB，无运行时外部依赖 | ~~高~~ 已消除 | 见 5.1 |
| 2 | 1935 暴露公网，URL 即凭证 | 中 | 随机 32 位码 + 可轮换；文档写明风险；可选 IP 白名单 |
| 3 | 事件 handler 10 秒超时 | 中 | 长任务 fire-and-forget，handler 立即返回 |
| 4 | SDK v2 仍在变，`sdkVersion` 不匹配即拒载 | 中 | build 自动写入；服务端升级需重建插件 |
| 5 | 单路互斥：两人同时推流会互相踢 | 中 | `postPublish` 时显式 reject 并回日志，不静默 |
| 6 | 容器无 ffmpeg / dataPath 不在卷上，重建后丢失 | 中 | 推荐自定义镜像；下载路径写进日志方便排查 |
| 7 | 无人观看时 RTMP 会话长时间挂着，NMS 的 gop_cache 可能吃内存 | 中 | 关 gop_cache 或设上限；加"无观众超时自动断流"设置项 |
| 8 | 大疆码率偏高（1080p 常见 8–16 Mbps），容器 CPU 与上行带宽 | 低中 | 视频直通不转码可规避 CPU；提供码率上限提示 |
| 9 | 插件以服务端进程权限运行，等于把 1935 端口交给第三方代码 | 低中 | 只用单一维护中的依赖，锁版本 |
| 10 | ~~`webRtc.announcedAddress` 未配置导致 ICE 失败、画面永远黑屏~~ **已确认并记录**：这是跨所有插件/语音功能的共性问题，属于服务端部署配置 | ~~高~~ 已消除 | 见 5.3.4，README「部署必须做的三件事」第 1 条 |

## 7. 需要你补充的信息（动手前）

1. **公网地址**：域名还是 `IP:1935`？有没有反代/防火墙限制 1935。
2. **Sharkord 的 compose 文件与镜像名**：我按它写端口补丁和 ffmpeg 方案；同时确认容器里有没有 ffmpeg。
3. **大疆具体型号**（Action 4 / 5 Pro 等）：确认自定义 RTMP 菜单里是「一个地址栏」，以及输出编码是 H.264。
4. **能否重建镜像**：能 → ffmpeg 直接进镜像最省事；不能 → 走设置项或运行时下载。

## 8. 参考来源

- Sharkord 插件总览（生命周期、`ctx.path` vs `ctx.dataPath`、文件夹与 manifest 关系）：https://sharkord.com/docs/plugins/overview
- Voice 章节（`ctx.voice.getRouter` / `createPlainTransport` / `createStream` 参数与清理要求）：https://sharkord.com/docs/plugins/voice
- Events 章节（`voice:runtime_initialized` / `voice:runtime_closed`、10 秒超时）：https://sharkord.com/docs/plugins/events
- Components 章节（slots 清单、`tabs` 导出、无 Tailwind 的样式约束）：https://sharkord.com/docs/plugins/components
- HTTP 章节（`ctx.http` 公开/鉴权路由，本方案可选用于推流回调）：https://sharkord.com/docs/plugins/http
- 本仓库 `README.md`（脚手架自带约束：`ctx.path` 更新时被删、Tailwind 类无效、`sdkVersion` 必须匹配、`version` 来自 package.json、`as const` 不能丢）
