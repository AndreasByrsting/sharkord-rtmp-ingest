# 开发与发布操作手册

面向要改这个插件、或要自己发一版的人。使用方式见 [README](../README.md)。

- [环境准备](#环境准备)
- [目录结构](#目录结构)
- [常用命令](#常用命令)
- [写代码前必须知道的几件事](#写代码前必须知道的几件事)
- [改完怎么验证](#改完怎么验证)
- [发版清单](#发版清单)
- [打「含 ffmpeg」的整包](#打含-ffmpeg-的整包)
- [发布到插件市场](#发布到插件市场)
- [构建产物长什么样](#构建产物长什么样)

## 环境准备

```bash
bun --version      # 需要 bun 1.3+；没有就去 https://bun.sh 装
bun run setup      # 首次：把 SDK / builder / ui 拉进 .repos 并 link
```

`setup` 会把三个本地包链进 `node_modules/@sharkord/`：

| 包 | 来源 |
|---|---|
| `@sharkord/plugin-sdk` | `.repos/sharkord/packages/plugin-sdk` |
| `@sharkord/plugin-builder` | `.repos/plugin-builder` |
| `@sharkord/ui` | `.repos/sharkord/packages/ui` |

`.repos/` 与 `node_modules/` 都不入库。换机器或换用户后软链会失效，重跑一次 `bun run setup`。

`.env`（可选，参考 `.env.example`）：

```ini
SHARKORD_PLUGINS_PATH=D:/sharkord/data/plugins   # 构建后自动部署
```

路径不存在时 `build.ts` 只告警、**不会建目录**——宁可报错，也不要凭空造出一棵空树让人以为部署成功了。

## 目录结构

| 路径 | 作用 |
|---|---|
| `src/server/index.ts` | 插件入口：设置项注册、事件监听、`/live` 与 `/live-refresh` |
| `src/server/session.ts` | 状态机：把「推流会话」与「频道语音运行时」两个生命周期串起来，所有转换串行化 |
| `src/server/rtmp-server.ts` | `node-media-server` 封装：路径解析、推流码校验、单路互斥、踢流 |
| `src/server/bridge.ts` | ffmpeg → RTP → mediasoup PlainTransport ×2 → Producer ×2 → `createStream` |
| `src/server/ffmpeg.ts` | 参数组装、二进制定位与探测、子进程管理 |
| `src/server/keys.ts` | 32 位随机推流码、持久化、轮换、定时安全比较 |
| `src/types.ts` | 服务端契约；现在只剩两条命令的声明 |
| `src/client/index.ts` | 空模块——打包器要求这个入口存在。插件没有前端 |
| `build.ts` | 构建入口，写入 `sdkVersion`、推导 `downloadUrl`、可选部署 |
| `publish.ts` | 发 GitHub Release（调 plugin-builder 的 `publish`） |
| `scripts/setup.ts` | 拉取并链接本地 SDK |
| `scripts/deploy.ts` | 把 `dist/<id>` 复制到插件目录 |
| `scripts/registry.ts` | 生成官方注册表要的 `plugin.json` + `versions/<version>.json` |
| `icon.svg` | 原始图标（透明底，黑色描边） |
| `logo.svg` / `logo.png` | 白底圆角版本。**市场与 manifest 用的是这个**——原图的黑色描边在 Sharkord 深色卡片上几乎看不见 |
| `docs/rtmp-live-plan.md` | 实施计划、阶段拆解、联调记录（含已修 bug 的排查过程） |

## 常用命令

```bash
bun run build                 # 构建到 dist/，.env 里配了路径则顺带部署
bun run deploy <plugins dir>  # 只部署
bun run registry              # 生成 registry/ 下的上架文件（需先 build）
bun run publish               # 建 GitHub Release 并上传两个附件（需 GITHUB_TOKEN）
bunx tsc --noEmit             # 类型检查
```

## 写代码前必须知道的几件事

- **`ctx.path` 每次更新都会被删除。** 要留下的东西写 `ctx.dataPath`；推流码存在 `ctx.storage`。
- **`sdkVersion` 必须与服务端完全一致**，`build` 会自动写入，不用手改 `manifest.json`。
- **`version` 取自 `package.json`**，不是 `manifest.json`（构建时会 patch 进去）。
- **`settings.register` 的定义要保留 `as const`**，否则 `settings.get` 丢类型。
- **`tsc --noEmit` 会报链接进来的 SDK 自身的错误**（`@sharkord/shared` 反向 import 了 `apps/server` 的类型）。只看 `src`/`scripts`/`build.ts`/`publish.ts` 下的；`tsconfig.json` 已把范围限定好，`src` 下应为 0 错。
- **`node-media-server` 的 `on()` 挂在模块级单例 emitter 上**，`stop()` 不摘监听。所以每次插件重载都会多一层处理器——`rtmp-server.ts` 用进程级 generation 把旧处理器静音，加新监听时别绕过它。
- **不要用 `spawn()` 判断二进制是否存在。** 找不到时错误是异步的，此时 mediasoup 的 transport 已经建好，观众会看到一张空卡片塌掉。用 `ffmpeg -version` 先探测（`probeFfmpeg`）。
- **推流码用定时安全比较**，别直接 `===`。

## 改完怎么验证

### 1. 类型检查

```bash
bunx tsc --noEmit 2>&1 | grep -E "^(src|scripts)/"   # 应无输出
```

### 2. 产物冒烟测试（不装进服务器也能跑）

`dist/<id>/server/index.js` 是个可以 `import()` 的模块，用一个假 ctx 就能验证生命周期与命令：

```ts
// 要点：settings/storage/voice/channels/commands/events/logger/dataPath 都得给
const mod = await import("file:///.../dist/sharkord-rtmp-live/server/index.js");
await mod.onLoad(ctx);

// 断言：onLoad/onUnload/onUpgrade 存在；commands 里注册了两条；
// /live 的返回值里带着 announcedAddress；/live-refresh 真的换了码；
// 端口真的 listen 起来；onUnload 之后端口释放、监听摘除
```

实测覆盖过的点：两条命令的 ephemeral 标记、`/live` 文案里的服务器地址取自「对外推流域名」、`/live-refresh` 前后码不同、1935 真监听、卸载干净。

### 3. 装进真实服务器

```bash
bun run build && bun run deploy /path/to/data/plugins
docker restart sharkord
```

必须先重启——宿主只在启动时扫描插件目录。

## 发版清单

1. 改 `package.json` 的 `version`（如 `0.2.3` → `0.2.4`）。
2. `bun run build`：会清空 `dist/`、打包、写 `dist/<version>.json`。
   `downloadUrl` 由 `build.ts` 从 `package.json` 的 `repository` 推导，不再需要手工改。
3. 冒烟测试 + 装一台真机验一遍。
4. `bun run registry` 重新生成 `registry/` 下的上架文件（里面有 checksum）。
5. 提交并推送。
6. `GITHUB_TOKEN=... bun run publish` 发 Release（或用网页手工建，附件用 `dist/<id>-<version>.tar.gz` 与 `dist/<version>.json`）。
7. 若市场上已有条目，按下一节提 PR 加新版本文件。

## 打含 ffmpeg 的整包

给没有 ffmpeg 的服务器用，解压即跑。产物不入库（`dist/` 已忽略）。

```bash
# 1. 拿一个静态 ffmpeg（含 libx264 + libopus）
curl -LO https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xf ffmpeg-release-amd64-static.tar.xz

# 2. 组目录
mkdir -p dist/bundle/rtmp-live-<ver>/plugins
mkdir -p dist/bundle/rtmp-live-<ver>/plugin-data/sharkord-rtmp-live
cp -r dist/sharkord-rtmp-live dist/bundle/rtmp-live-<ver>/plugins/
cp ffmpeg-*-amd64-static/ffmpeg dist/bundle/rtmp-live-<ver>/plugin-data/sharkord-rtmp-live/

# 3. 打包（权限必须显式写，Windows 上打出来的会是 666/777，丢可执行位）
python - <<'EOF'
import tarfile
def fix(ti):
    ti.uid = ti.gid = 0; ti.uname = ti.gname = 'root'
    ti.mode = 0o755 if (ti.isdir() or ti.name.endswith('/ffmpeg')) else 0o644
    return ti
with tarfile.open('dist/rtmp-live-bundle.tar.gz', 'w:gz', compresslevel=6) as t:
    t.add('dist/bundle/rtmp-live-<ver>', arcname='rtmp-live-<ver>', filter=fix)
EOF
```

服务器上解压到 `data` 同级即可：

```bash
cp -r rtmp-live-<ver>/plugins/sharkord-rtmp-live ./data/plugins/
mkdir -p ./data/plugin-data/sharkord-rtmp-live
cp rtmp-live-<ver>/plugin-data/sharkord-rtmp-live/ffmpeg ./data/plugin-data/sharkord-rtmp-live/
chmod +x ./data/plugin-data/sharkord-rtmp-live/ffmpeg
docker restart sharkord
```

挑二进制的经验：

- **johnvansickle 的 amd64 static**：约 40 MB 压缩包、单个 `ffmpeg` 76 MB，已 strip，够用。
- **别用 BtbN 的 `latest-gpl`**：未 strip，单个 `ffmpeg` 169 MB。
- 校验方式：ELF magic + `e_machine == 0x3e`（x86-64）、`grep libx264` / `libopus`、无 `ld-linux`（确认静态）。
- Windows 上没有 `xz`，`tar -xf *.tar.xz` 会失败，用 `python -c "tarfile.open(p,'r:xz')"` 解。

## 发布到插件市场

官方市场就是 [`Sharkord/plugins`](https://github.com/Sharkord/plugins) 仓库里的一份注册表，服务器启动时拉它的 `plugins.json`：

```ts
// packages/shared/src/plugins/marketplace.ts
const MARKETPLACE_REGISTRY_URL =
  'https://raw.githubusercontent.com/Sharkord/plugins/refs/heads/main/plugins.json';
```

客户端渲染列表、服务端执行安装都读这一个地址，没有环境变量能覆盖。安装流程是「按 `id + version` 查榜单 → 下载 `downloadUrl` → 校验 sha256 → 解包覆盖」，所以既没有「从 URL 安装」，也没有「上传压缩包」。

### 步骤

1. **发 GitHub Release**：tag 用 `v<version>`，附件放 `<id>-<version>.tar.gz` 和 `<version>.json`。
2. **生成 PR 要的文件**：`bun run registry`，输出到 `registry/plugins/sharkord-rtmp-live/`：
   - `plugin.json`：`id`/`name`/`description`/`author`/**`logo`（必填，公网图片 URL）**/`homepage`/`tags`/`categories`/`screenshots`
   - `versions/<version>.json`：`version`、`downloadUrl`、`checksum`（sha256）、`sdkVersion`、`size`、`timestamp`
3. **提 PR**：fork `Sharkord/plugins`，把整个 `sharkord-rtmp-live/` 目录拷进 `plugins/`。
4. CI 跑 `bun run validate`：缺字段、`id` 与目录名不一致、版本号与文件名不一致都会失败。合并后维护者重新生成 `plugins.json`，所有服务器立刻可见。
5. `verified` 不归你填——它在注册表仓库的 `scripts/statics.ts` 里是白名单，只有维护者认可的作者会被加进去。它代表「认得这个发布者」，不代表代码被审计。
6. `tags` / `categories` 目前允许的取值都是空数组，只能留空。

### 提 PR 前先在本地跑一遍官方校验

这是最硬的验证方式，能把 CI 的失败提前暴露：

```bash
git clone --depth 1 git@github.com:Sharkord/plugins.git /tmp/sharkord-plugins
cp -r registry/plugins/sharkord-rtmp-live /tmp/sharkord-plugins/plugins/
cd /tmp/sharkord-plugins
bun install --ignore-scripts
DRY_RUN=1 bun scripts/build-index.ts
# 期望：Processed plugin: sharkord-rtmp-live with N versions.
#       Validation passed for M plugins (dry-run, no files written).
```

### 两个硬约束

- `sdkVersion` 必须等于服务器当前的 SDK 版本（现在是 2）。不匹配的版本不会出现在那台服务器的市场里，**每次 SDK 升版都要重发**。
- Release 附件会被维护者拿去 VirusTotal 扫描。

### logo 托管

用的是 jsDelivr 的固定提交地址：`https://cdn.jsdelivr.net/gh/<owner>/<repo>@<commit>/logo.png`。一次写死、永不失效，代价是换图标时要连地址一起换（`manifest.json` 与 `plugin.json` 两处都要改）。GitHub raw 是另一个受支持的写法。

## 构建产物长什么样

```
dist/
├── sharkord-rtmp-live/
│   ├── manifest.json
│   ├── server/index.js      ← 单文件，依赖已内联（约 1 MB，node-media-server 在里面）
│   └── client/index.js      ← 0 字节，但三件套必须齐
├── sharkord-rtmp-live-<version>.tar.gz
└── <version>.json           ← downloadUrl / checksum / sdkVersion / size / timestamp
```

几个容易被误判的点：

- **归档其实是未压缩 tar，只是扩展名写成 `.tar.gz`。** 官方的 `iptv-0.0.3.tar.gz` 也一样（magic 是目录名而不是 gzip），宿主用 `Bun.Archive` 读，行为等价。不要因此以为构建坏了。
- **产物里的中文是 `\uXXXX` 大写转义**，不是字面中文。校验文案是否进包时要按转义形式比较，否则 `count` 恒为 0。
- **函数名会被压缩改名**（`probeFfmpeg` → `ev` 之类），定位代码只能靠 `spawnSync`、`-version`、`libx264` 这类不变量。
- **`client/index.js` 可以是 0 字节**，宿主只查文件是否存在。
- **宿主校验 `manifest.json`**（`zPluginManifest`）要求 `id`、`name`、`author`、`description`、`sdkVersion`、`version` 必填，`homepage` 与 `logo` 可选，`id` 要与目录名一致。但**注册表的 `plugin.json` 里 `logo` 是必填**（`z.url()`），没有公网图片地址过不了 PR。
