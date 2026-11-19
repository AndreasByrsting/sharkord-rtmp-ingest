# 常见问题（FAQ）

插件：**RTMP Live**（`sharkord-rtmp-live`）——接收一路 RTMP 推流，发布会话里的语音频道。

这里按「你看到的现象」组织，每条都给出可以直接复制执行的命令。日志默认在 `docker logs sharkord`（或宿主服务端控制台）里。

- [一、ffmpeg 与安装](#一ffmpeg-与安装)
- [二、推流与播放](#二推流与播放)
- [三、升级、卸载与清理](#三升级卸载与清理)
- [四、报问题前请先收集](#四报问题前请先收集)

---

## 一、ffmpeg 与安装

### 1. 只装插件包，ffmpeg 从哪来？

插件自己下。0.2.4 起，加载时会检查一遍，缺了就后台下载一个静态版，写进**插件数据目录**：

| 宿主 | 路径 |
|---|---|
| Linux（官方镜像，`-v ./data:/home/bun/.config/sharkord`） | `data/plugin-data/sharkord-rtmp-live/ffmpeg` |
| Linux（裸机） | `~/.config/sharkord/plugin-data/sharkord-rtmp-live/ffmpeg` |
| Windows | `<数据目录>\plugin-data\sharkord-rtmp-live\ffmpeg.exe` |

不用改镜像、不用挂载额外目录。`plugin-data` 在插件升级时不会被删，所以只下一次。

### 2. 下载多大、日志长什么样？

单个平台的静态包：macOS ARM 约 19 MB，Linux / Windows 约 25–30 MB。日志按 5% 或 3 秒的间隔打点：

```
没有找到 ffmpeg，开始下载静态版（linux-x64，28 MB，单次限时 10 分钟）…
ffmpeg 下载中：12%（3.4 MB / 28 MB，2.8 MB/s）
ffmpeg 下载中：48%（13.5 MB / 28 MB，3.1 MB/s）
下载完成，正在校验并解压…
ffmpeg 已下载并校验通过：/home/bun/.config/sharkord/plugin-data/sharkord-rtmp-live/ffmpeg（79 MB）
ffmpeg 已就绪（启动时自动安装）：/home/bun/.config/sharkord/plugin-data/sharkord-rtmp-live/ffmpeg
```

看到最后两行就可以推流了。想手动触发一次，管理员执行 `/live-ffmpeg`。

### 3. 卡在某个百分比不动，或者超时

单次下载限时默认 **10 分钟**，超时会记一条 `连接超时：10 分钟没有拿到响应` 或 `传输中断`。插件一共尝试 **3 次**，间隔 3 秒、8 秒：

```
下载中断：传输中断（已收到 8.0 MB）：The socket connection was closed unexpectedly。3 秒后重试（1/3）
第 2/3 次尝试…
```

三次都失败后，日志会给出 `安装 ffmpeg 失败：…` 以及手动方案。这基本是出口链路的问题，按第 4、5 条处理。

网速确实很慢（比如 1 MB/s 以下）时，把设置 →「ffmpeg 下载超时（分钟）」调大，范围 1–60，默认 10。改完下次下载或 `/live-ffmpeg` 生效，不用重启。

### 4. 报 `HTTP 502`、`ECONNRESET`、`ENOTFOUND`、`EAI_AGAIN`

都是「容器到 GitHub 的这条路不通」，与插件、推流端、反向代理都无关。按顺序试：

```bash
# 容器里能不能出网（应该有一行 HTTP/2 200）
docker exec -it sharkord sh -c 'command -v curl && curl -sI https://github.com | head -1'
```

- **走公司代理**：给容器加 `HTTPS_PROXY` 环境变量，再重启。
- **DNS 有问题**：`docker exec sharkord cat /etc/resolv.conf`，改 Docker 的 `dns` 配置。
- **就是连不上**：用第 5 条离线装。

注意 `HTTP 404` 不会重试——那是资产确实不存在，通常是平台不在支持列表里（见第 8 条）。

### 5. 服务器完全不能出网，怎么离线装？

在任意一台能上网的机器下载，然后拷进 `plugin-data`。**必须是 Linux 二进制**（`plugin-data` 会挂进容器，Windows 的 `ffmpeg.exe` 跑不起来）：

```bash
# 能上网的机器
curl -LO https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xf ffmpeg-release-amd64-static.tar.xz

# 拷到服务器后（宿主机上执行）
mkdir -p ./data/plugin-data/sharkord-rtmp-live
cp ffmpeg-*-amd64-static/ffmpeg ./data/plugin-data/sharkord-rtmp-live/
chmod +x ./data/plugin-data/sharkord-rtmp-live/ffmpeg
docker restart sharkord
```

插件发现文件已存在且能跑 `-version`，就不会再下载。也可以在设置里把「自动下载 ffmpeg」关掉，或在「ffmpeg 路径」里直接填绝对路径。

### 6. 每次重启都会重新下载吗？

不会。目标文件存在、且 `ffmpeg -version` 能正常退出，就直接复用。只有文件不存在、或者手动放了个坏文件（执行不了）时才会重新下。

### 7. 怎么确认装好了、支持哪些编码？

```bash
# 路径按第 1 条的表替换
docker exec -it sharkord /home/bun/.config/sharkord/plugin-data/sharkord-rtmp-live/ffmpeg -version
docker exec -it sharkord /home/bun/.config/sharkord/plugin-data/sharkord-rtmp-live/ffmpeg \
  -hide_banner -encoders | grep -E "libx264|libopus"
```

要能打印版本横幅，并且 `libx264`、`libopus` 各有一行。缺任何一个，转码都会失败——换成自带这两个编码器的静态构建。

### 8. 支持哪些平台？树莓派（armv7）行不行？

自动下载只覆盖这五个：

| `process.platform`-`arch` | 说明 |
|---|---|
| `linux-x64` | 绝大多数 Docker 部署 |
| `linux-arm64` | ARM 服务器、Apple Silicon 上的 Linux 虚拟机 |
| `win32-x64` | Windows 宿主机裸机 |
| `darwin-x64` / `darwin-arm64` | macOS |

其他平台（包括 32 位 ARM 的树莓派、FreeBSD）日志会写「当前平台 … 没有预置的 ffmpeg 包」，需要自己编译或找对应静态版，按第 5 条放进 `plugin-data`。

### 9. 我填了「ffmpeg 路径」，它还会下载吗？

不会。填了就只用你填的那一个，自动下载会被跳过——这是个明确的选择，插件不去覆盖它。

### 10. 能关掉自动下载吗？

能。设置 → 插件 → RTMP Live →「自动下载 ffmpeg」关掉。之后只有 `/live-ffmpeg` 或手动放二进制两条路。适合内网、镜像里已经装了 ffmpeg、或者不想让容器访问外网的场景。

同一页的「ffmpeg 下载超时（分钟）」控制单次下载最多等多久（默认 10，范围 1–60）；只影响下载，不影响推流。

---

## 二、推流与播放

### 11. OBS 报「无法连接服务器」

先看服务端日志有没有 `收到推流`：

- **没有**：包没到插件。查 `1935/tcp` 有没有映射出去（`docker port sharkord`）、防火墙、以及推流地址里的端口是不是宿主机映射的那个。
- **有「收到推流」，但紧接着断开**：推流码不对。用 `/live` 重新拿一次完整地址，注意路径是 `/live/<推流码>`，`app` 必须是 `live`——写成 `/live2/xxx` 会被直接拒绝。

### 12. 推上去了，但频道里没反应

两种常见原因，日志里会直说：

| 日志 | 原因 | 处理 |
|---|---|---|
| `还没选择直播频道，画面不会发布` | 设置里频道是空的 | 设置 → 直播频道，选一个语音频道 |
| `频道 N 里还没有人，画面暂不发布；有人进来会自动开始` | 频道里没人，插件不建流 | 进频道即可，画面会自动出现 |

### 13. 有「开始向频道发布直播」，但浏览器黑屏 / 一直转圈

服务端链路已经通了，问题在 WebRTC。`config.ini` 里的 `announcedAddress` 必须是**观众能访问到的地址**：

```ini
[voice]
announcedAddress=你的公网IP或域名
```

容器里看不到公网地址，Docker 部署不填这一项，观众侧永远连不上。改完 `docker restart sharkord`。

### 14. 有画面没声音 / 有声音没画面

- 没声音：源里本来就没有音轨（部分相机的 HDMI 采集不带音频），或者源音频不是 AAC。
- 没画面：`视频处理` 设成了「直通」，但源不是 H.264 Baseline。先切回「转码」验证，通了再考虑直通。
- 两者都正常但没有卡片：说明没真正建流，回到第 12 条看状态。

### 15. 画面卡顿、花屏

先降码率（设置 → 转码码率，默认 2500 kbps），再确认容器 CPU 没打满。转码是 CPU 活，核数少的机器 1080p30 会比较吃力；直通模式几乎不耗 CPU，但对源有要求。

### 16. 第二路推流被拒绝

设计如此：**只支持一路**。已有推流在跑时，第二路会被直接拒绝，不会打断正在播的那一路。日志里是 `已有推流在跑，拒绝 <ip> 的第二路`。

### 17. 想换推流码 / 立刻踢掉当前推流

管理员执行 `/live-refresh`：新码先生效，旧地址立刻作废，正在推的那一路会被断开。

---

## 三、升级、卸载与清理

### 18. 升级插件会丢掉 ffmpeg 吗？

不会。插件目录在升级时会被整个替换，`plugin-data` 保留。除非你手动删了 `plugin-data/sharkord-rtmp-live/`。

### 19. 怎么彻底卸载干净？

```bash
# 1. 停服务、删插件目录
rm -rf ./data/plugins/sharkord-rtmp-live

# 2. 想连二进制和推流码一起清掉
rm -rf ./data/plugin-data/sharkord-rtmp-live

# 3. 重启
docker restart sharkord
```

推流码存在宿主的插件存储里，重装会生成新的，`/live` 拿一次即可。

### 20. 下载失败会不会留下垃圾文件？

不会。下载写 `<目标>.download-<pid>`，解压写 `<目标>.unpack-<pid>`，只有 sha256 与字节数都对上之后才原子改名成正式文件；失败会在 `finally` 里删掉这两个临时文件。所以 `plugin-data` 里出现半个 `ffmpeg` 的情况不会发生。

---

## 四、报问题前请先收集

贴 issue 时带上这些，能省掉大半来回：

1. 插件版本（`manifest.json` 里的 `version`）与服务端版本。
2. 部署方式：官方镜像 / 自建镜像 / 裸机，`process.platform`-`arch`（如 `linux-x64`）。
3. `docker logs sharkord` 里从 `RTMP Live 已加载` 开始的那一段，尤其是 `ffmpeg` 相关行。
4. `/live-ffmpeg` 的返回内容（里面有解析到的路径和版本横幅）。
5. 浏览器 F12 Console 里有没有 `ice failed` / `consumer transport` 报错。

问题反馈：<https://github.com/AndreasByrsting/sharkord-rtmp-ingest/issues>
