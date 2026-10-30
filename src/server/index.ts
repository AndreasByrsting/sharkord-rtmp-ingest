import {
  Permission,
  type PluginContext,
  type TUpgradeInfo,
  type UnloadPluginContext,
  type UpgradePluginContext,
} from "@sharkord/plugin-sdk";
import type { TLiveStatus, TPlugin } from "../types";
import {
  buildKeyInfo,
  ensureKey,
  matchesKey,
  rotateKey,
  type TStoredKey,
} from "./keys";
import { resolveFfmpegBin, type TVideoMode } from "./ffmpeg";
import { startIngest, type TIngestHandle } from "./rtmp-server";
import { LiveSession } from "./session";

let session: LiveSession | undefined;
let ingest: TIngestHandle | undefined;

const stateLabel = (status: TLiveStatus): string => {
  switch (status.state) {
    case "ingesting":
      return "已收到推流，但频道里没人，画面暂不发布";
    case "live":
      return `直播中 → 「${status.channelName ?? status.channelId}」`;
    case "error":
      return `异常：${status.lastError ?? "未知错误"}`;
    default:
      return "没有推流";
  }
};

const onLoad = async (ctx: PluginContext<TPlugin>) => {
  const settings = await ctx.settings.register([
    {
      key: "channel",
      name: "直播频道",
      description: "推流进入后，把画面发布到这个语音频道。",
      type: "channel",
      defaultValue: 0,
    },
    {
      key: "rtmpPort",
      name: "RTMP 监听端口",
      description:
        "插件在本机/容器内监听的端口。Docker 部署时，这个端口要能被容器映射出去。",
      type: "number",
      defaultValue: 1935,
    },
    {
      key: "publicHost",
      name: "对外推流域名 / IP",
      description:
        "推流地址里显示的域名或 IP，例如 live.example.com。留空则自动使用语音服务的对外地址。",
      type: "string",
      defaultValue: "",
    },
    {
      key: "publicPort",
      name: "对外推流端口",
      description:
        "推流地址里显示的端口，即宿主机映射出去的那个端口。填 0 表示与监听端口相同。",
      type: "number",
      defaultValue: 0,
    },
    {
      key: "videoMode",
      name: "视频处理",
      description: "转码兼容性最好；直通只在源是 H.264 Baseline 时可用。",
      type: "enum",
      defaultValue: "transcode",
      options: [
        { value: "transcode", label: "转码（推荐）" },
        { value: "copy", label: "直通（省 CPU）" },
      ],
    },
    {
      key: "videoBitrate",
      name: "转码码率（kbps）",
      description: "仅转码模式生效。1080p30 建议 2500–4000。",
      type: "number",
      defaultValue: 2500,
    },
    {
      key: "ffmpegPath",
      name: "ffmpeg 路径",
      description:
        "留空则依次尝试插件数据目录下的 ffmpeg、系统 PATH 中的 ffmpeg。",
      type: "string",
      defaultValue: "",
    },
  ] as const);

  let key: TStoredKey = await ensureKey(ctx);

  const clampPort = (value: number): number => {
    if (!Number.isFinite(value) || value < 1 || value > 65535) return 0;

    return Math.floor(value);
  };

  const rtmpPort = (): number => clampPort(settings.get("rtmpPort")) || 1935;

  const callbackPort = (): number => {
    const value = settings.get("publicPort");
    const configured = Number.isFinite(value) ? Math.floor(value) : 0;

    // 0 means "same as the listen port", which is the bare-metal case.
    return configured > 0 ? configured : rtmpPort();
  };

  const host = (): string => {
    const configured = settings.get("publicHost").trim();

    if (configured) return configured;

    const { ip, announcedAddress } = ctx.voice.getListenInfo();

    return announcedAddress || ip || "localhost";
  };

  const keyInfo = () => buildKeyInfo(key, host(), callbackPort(), rtmpPort());

  const buildConfig = async () => {
    const channelId = settings.get("channel");
    const channel = channelId > 0 ? await ctx.channels.get(channelId) : undefined;

    return {
      channelId,
      channelName: channel?.name ?? null,
      rtmpPort: rtmpPort(),
      ffmpegBin: resolveFfmpegBin(ctx, settings.get("ffmpegPath")),
      videoMode: settings.get("videoMode") as TVideoMode,
      bitrateKbps: Math.max(200, Math.min(20000, settings.get("videoBitrate"))),
      localInput: `rtmp://127.0.0.1:${rtmpPort()}/live/${key.streamKey}`,
    };
  };

  const current = new LiveSession(
    ctx,
    await buildConfig(),
    (sessionId) => ingest?.kick(sessionId),
  );

  session = current;

  const refreshConfig = async (): Promise<void> => {
    current.updateConfig(await buildConfig());
  };

  /**
   * The events below only fire on a transition, so they are not enough on their
   * own: an admin can set the channel after people are already sitting in it,
   * and a plugin (re)load can land mid-session. Ask the server instead.
   */
  const runtimeAlive = (channelId: number): boolean => {
    if (channelId <= 0) return false;

    try {
      ctx.voice.getState(channelId);

      return true;
    } catch {
      return false;
    }
  };

  const bootIngest = (port: number): void => {
    ingest?.stop();

    ingest = startIngest(port, {
      onPrePublish: ({ streamName, ip, reject }) => {
        if (!matchesKey(streamName, key.streamKey)) {
          reject();

          return false;
        }

        // Single publisher by design: the newcomer is dropped, the running
        // stream is never interrupted mid-air.
        if (current.hasPublisher()) {
          ctx.logger.log(`已有推流在跑，拒绝 ${ip} 的第二路`);

          reject();

          return false;
        }

        return true;
      },
      onPublish: (info) => {
        const { channelId } = current.getConfig();

        ctx.logger.log(`收到推流：${info.ip} → ${info.streamName}`);

        // Re-check on every publish: the runtime may predate this plugin load.
        current.setRuntime(runtimeAlive(channelId));

        if (channelId <= 0) {
          ctx.logger.log("还没选择直播频道，画面不会发布（设置 → 直播频道）");
        } else if (!runtimeAlive(channelId)) {
          ctx.logger.log(`频道 ${channelId} 里还没有人，画面暂不发布；有人进来会自动开始`);
        }

        current.handlePublish(info);
      },
      onUnpublish: (info) => {
        ctx.logger.log(`推流已断开：${info.streamName}`);

        current.handleUnpublish(info);
      },
      onLog: (message) => ctx.logger.log(message),
    });
  };

  bootIngest(rtmpPort());

  ctx.events.on("voice:runtime_initialized", ({ channelId }) => {
    if (channelId !== current.getConfig().channelId) return;

    ctx.logger.log(`频道 ${channelId} 的语音运行时已就绪`);

    current.setRuntime(true);
  });

  ctx.events.on("voice:runtime_closed", ({ channelId }) => {
    if (channelId !== current.getConfig().channelId) return;

    ctx.logger.log(`频道 ${channelId} 的语音运行时已关闭`);

    current.setRuntime(false);
  });

  // The events only fire on a transition. Someone may already be sitting in
  // the channel when the server restarts or the plugin is enabled.
  current.setRuntime(runtimeAlive(current.getConfig().channelId));

  ctx.events.on("setting:set", ({ key: changed }) => {
    if (changed === "rtmpPort") bootIngest(rtmpPort());

    void (async () => {
      await refreshConfig();

      // Picking a channel while people are already inside is the normal case,
      // and that transition already happened — so re-read the runtime here.
      if (changed === "channel") {
        current.setRuntime(runtimeAlive(settings.get("channel")));
      }
    })();
  });

  const addressReply = (title: string, note?: string): string => {
    const info = keyInfo();

    const lines = [title, ""];

    if (note) lines.push(note, "");

    lines.push(
      `服务器：${info.streamUrl}`,
      `推流码：${info.streamKey}`,
      `完整地址：${info.publishUrl}`,
    );

    return lines.join("\n");
  };

  /**
   * Who may run these is decided in the plugin's permission page: the role
   * list there is the allow list. `requires` is only the fallback used when
   * nothing was configured, so an admin can hand either command to any role
   * without touching the code.
   *
   * On top of that the host itself insists on `USE_PLUGINS` before any plugin
   * command runs, so a granted role also needs that permission — otherwise the
   * command never even shows up in its `/` menu.
   */
  ctx.commands.register({
    name: "live",
    description: "把当前 RTMP 推流地址发给你自己。",
    args: [],
    requires: Permission.MANAGE_PLUGINS,
    ephemeral: true,
    executes: async () =>
      `${addressReply("推流地址（仅你可见）")}\n\n状态：${stateLabel(current.status())}`,
  });

  ctx.commands.register({
    name: "live-refresh",
    description: "换一个新的推流码，并立即断开正在进行的推流。",
    args: [],
    requires: Permission.MANAGE_PLUGINS,
    ephemeral: true,
    executes: async () => {
      // Rotate first: the old URL has to be dead before the new one is handed
      // out, otherwise both work for as long as the reply takes to arrive.
      key = await rotateKey(ctx);

      await refreshConfig();

      // The publisher is still holding a session on the old path, and ffmpeg
      // is still feeding the channel off it. Drop both.
      current.stop();

      ctx.logger.log("推流码已刷新，旧地址失效，当前推流已断开");

      return addressReply(
        "新的推流地址（仅你可见）",
        "旧推流码已作废，正在进行的推流已断开。",
      );
    },
  });

  ctx.logger.log("RTMP Live 已加载");
};

const onUnload = async (ctx: UnloadPluginContext) => {
  ingest?.stop();
  ingest = undefined;

  await session?.dispose();
  session = undefined;

  ctx.logger.log("RTMP Live 已卸载");
};

const onUpgrade = (ctx: UpgradePluginContext, info: TUpgradeInfo) => {
  ctx.logger.log(`升级：${info.previousVersion} → ${info.version}`);
};

export { onLoad, onUnload, onUpgrade };
