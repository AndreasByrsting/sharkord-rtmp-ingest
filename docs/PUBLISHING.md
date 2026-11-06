# 发布到 Sharkord 插件市场

插件市场是**两段式**：先在自己的仓库发一个 GitHub Release（装着二进制），再往官方的注册表仓库提一个 PR（只有两个 JSON）。官方仓库里不放代码。

```
你的仓库                                     Sharkord/plugins（注册表）
─────────                                   ────────────────────────
tag v0.2.3                                  plugins/sharkord-rtmp-live/plugin.json
  ├─ sharkord-rtmp-live-0.2.3.tar.gz  ─────►  plugins/sharkord-rtmp-live/versions/0.2.3.json
  └─ 0.2.3.json                             （downloadUrl 指向上面的 tar.gz）
```

服务器启动时只拉一个地址：`https://raw.githubusercontent.com/Sharkord/plugins/refs/heads/main/plugins.json`。所以注册表合并后，所有服务器下次刷新市场就能看到。

---

## 前置检查（本次已就绪）

| 项 | 状态 | 位置 |
|---|---|---|
| 插件产物 | ✅ 0.2.3 | `dist/sharkord-rtmp-live-0.2.3.tar.gz`（1054720 字节） |
| 版本文件 | ✅ 已填真实下载地址 | `dist/0.2.3.json` |
| PR 用的注册表文件 | ✅ 已生成 | `registry/plugins/sharkord-rtmp-live/` |
| 公网 logo | ✅ jsDelivr 固定提交地址，实测 200 | `plugin.json` 的 `logo` |
| GitHub Release | ❌ **待发** | 第 1 步 |
| Fork `Sharkord/plugins` | ❌ **待 fork** | 第 3 步 |

---

## 第 1 步：发 GitHub Release

tag 必须是 `v<version>`，附件必须是这两个文件名（`plugin.json` 里的 `downloadUrl` 已按这个路径写好，改名就对不上了）。

### 方式 A：网页（不需要 token）

1. 打开 <https://github.com/AndreasByrsting/sharkord-rtmp-ingest/releases/new>
2. **Choose a tag** 输入 `v0.2.3` → 点 `Create new tag: v0.2.3 on publish`
3. **Target** 选 `develop`（当前唯一有内容的分支）
4. **Release title** 填 `v0.2.3`
5. **Describe this release** 填更新说明（见下方模板）
6. 把这两个文件拖进 **Attach binaries** 区域：
   - `dist/sharkord-rtmp-live-0.2.3.tar.gz`
   - `dist/0.2.3.json`
7. 点 **Publish release**

### 方式 B：命令行（需要 token）

```bash
GITHUB_TOKEN=<classic token，勾 public_repo> bun run publish
```

它会：构建 → 建 `v0.2.3` release → 传 `sharkord-rtmp-live-0.2.3.tar.gz` → 把返回的真实地址写回 `dist/0.2.3.json` → 再传这个 json。

> 注意：本机直连 `github.com` 的 HTTPS 被代理拦，但 `api.github.com` 通，所以方式 B 能跑；`git push` 只能走 SSH。

### Release 说明模板

```markdown
RTMP live streaming for Sharkord voice channels.

- Ingest a single RTMP push (OBS, DJI Action 6) and publish it as a live stream
- `/live` prints the publish address and stream key; `/live-refresh` rotates the key
- Admin-only commands, chat-only

Requires ffmpeg with libx264 and libopus on the host (see the README).
```

---

## 第 2 步：自检 Release

`downloadUrl` 必须真的能下载、checksum 必须一致，否则市场里的安装会失败在服务端，前端只显示一个笼统的错误。

```bash
curl -sSL -o /tmp/check.tar.gz -w "%{http_code} %{size_download}\n" \
  https://github.com/AndreasByrsting/sharkord-rtmp-ingest/releases/download/v0.2.3/sharkord-rtmp-live-0.2.3.tar.gz
sha256sum /tmp/check.tar.gz
```

期望：

- `200 1054720`
- sha256 = `a3633ec32ffb951f021946c40ad084f304d73e184a2656565fcb4feb552131a6`
- 与 `dist/0.2.3.json` 的 `checksum`、`size` 完全一致

> 本机证书链检查有时报 `CRYPT_E_REVOCATION_OFFLINE`，加 `--ssl-no-revoke` 即可。

---

## 第 3 步：Fork 注册表仓库

打开 <https://github.com/Sharkord/plugins> → 右上角 **Fork** → Owner 选 `AndreasByrsting` → **Create fork**。

fork 完成后地址是 `git@github.com:AndreasByrsting/plugins.git`。

---

## 第 4 步：放文件、提交、推分支

```bash
cd /tmp
git clone git@github.com:AndreasByrsting/plugins.git
cd plugins
git remote add upstream git@github.com:Sharkord/plugins.git   # 方便以后同步

git checkout -b add-sharkord-rtmp-live
cp -r /c/Users/Admin/Desktop/gitSpace/sharkord-rtmp-ingest/registry/plugins/sharkord-rtmp-live plugins/

git add plugins/sharkord-rtmp-live
git commit -m "feat: add sharkord-rtmp-live"
git push -u origin add-sharkord-rtmp-live
```

最终仓库里应该只有这两个新文件：

```
plugins/sharkord-rtmp-live/plugin.json
plugins/sharkord-rtmp-live/versions/0.2.3.json
```

**不要手改 `plugins.json`** —— 它由 `scripts/build-index.ts` 生成，合并后 CI 会自动重算。

---

## 第 5 步：开 PR

推送后终端会打印一个 `Create a pull request` 链接，或者直接打开：

<https://github.com/Sharkord/plugins/compare/main...AndreasByrsting:plugins:add-sharkord-rtmp-live>

标题：`feat: add sharkord-rtmp-live`

正文模板：

```markdown
Adds **RTMP Live** — accept a single RTMP push (OBS, DJI Action cameras) and
publish it into a voice channel as a live stream.

- Repo: https://github.com/AndreasByrsting/sharkord-rtmp-ingest
- Release: https://github.com/AndreasByrsting/sharkord-rtmp-ingest/releases/tag/v0.2.3
- SDK: 2
- License: MIT
```

---

## 第 6 步：等 CI

PR 上会出现两个检查：

| 检查 | 做什么 | 失败通常因为 |
|---|---|---|
| `validate` | `bun run validate`，即 `build-index.ts` 的 DRY_RUN | 缺字段、`id` 与目录名不一致、版本号与文件名不一致、`logo` 不是合法 URL |
| `analyze` | 只对**新增**的 `versions/*.json` 跑 VirusTotal | 附件下载失败、维护者没配 `VIRUSTOTAL_API_KEY`（这一条属于仓库配置问题，不是你文件的问题） |

提 PR 前可以本地先跑一遍 validate，把问题提前暴露：

```bash
git clone --depth 1 git@github.com:Sharkord/plugins.git /tmp/sharkord-plugins
cp -r registry/plugins/sharkord-rtmp-live /tmp/sharkord-plugins/plugins/
cd /tmp/sharkord-plugins && bun install --ignore-scripts
DRY_RUN=1 bun scripts/build-index.ts
# 期望：Processed plugin: sharkord-rtmp-live with 1 versions.
#       Validation passed for N plugins (dry-run, no files written).
```

---

## 第 7 步：合并之后

注册表仓库的 `build.yml` 在 push 到 `main` 时自动跑 `bun run build` 并提交 `plugins.json`，不需要维护者手工生成。合并后一两分钟确认一下：

```bash
curl -sS https://cdn.jsdelivr.net/gh/Sharkord/plugins@main/plugins.json | \
  python -c "import json,sys; d=json.load(sys.stdin); print([p['plugin']['id'] for p in d])"
```

看到 `sharkord-rtmp-live` 就在榜上了。`raw.githubusercontent.com` 若被挡，用上面这个 jsDelivr 地址等价。

---

## 第 8 步：在服务器上验证

服务器 → 设置 → 插件 → 市场，应该能看到卡片（图标是白底圆角那个）。点安装即可，不用再手工拷目录。装了之后 `plugin-data/sharkord-rtmp-live/` 里没有 ffmpeg，仍需按 README 第 2 步自己放一个——**市场只分发插件本体，不分发二进制依赖**。

---

## 以后发新版本

```bash
# 1. 改代码，然后升版本（build 读的是 package.json）
#    手动改 package.json 的 version，同时改 manifest.json 的 version
bun run build          # 产物 + dist/<ver>.json（downloadUrl 自动推导）
bun run registry       # 生成 registry/.../versions/<ver>.json

# 2. 发 Release（第 1 步），tag v<ver>，附件是两个新文件
# 3. 往注册表提 PR，这次只加一个文件：
#    plugins/sharkord-rtmp-live/versions/<ver>.json
```

`plugin.json` 只在改名、换 logo、改描述时才动。旧版本文件保留，客户端会自己挑最新的兼容版本。

---

## 常见失败原因

| 现象 | 原因 |
|---|---|
| CI `Plugin ID mismatch` | `plugin.json` 的 `id` 和目录名不一致 |
| CI `Version mismatch in file name and content` | 文件名 `0.2.3.json` 与里面的 `"version": "0.2.3"` 不一致 |
| CI 报 `logo` 不是 URL | 用了相对路径；必须是 `https://` 开头且公网可访问 |
| 市场里看不到插件 | `sdkVersion` 与服务器 SDK 不匹配（当前是 2）。客户端只展示 `sdkVersion === PLUGIN_SDK_VERSION` 的版本 |
| 市场能看到、点安装报 checksum 不符 | Release 附件被重新上传过（GitHub 会改文件），要重算 `checksum` |
| 安装成功但一推流就报 ffmpeg 找不到 | 插件里不含 ffmpeg，见 README「准备 ffmpeg」 |
| PR 一直没人合 | 市场是人工审核的，`verified` 徽章也在维护者白名单里；等或去 Discord 问一声 |
