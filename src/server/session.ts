import type { PluginContext } from "@sharkord/plugin-sdk";
import type { TLiveState, TLiveStatus } from "../types";
import { startBridge, type TBridgeHandle } from "./bridge";
import type { TVideoMode } from "./ffmpeg";

export type TLiveConfig = {
  channelId: number;
  channelName: string | null;
  rtmpPort: number;
  ffmpegBin: string;
  videoMode: TVideoMode;
  bitrateKbps: number;
  /** Local URL ffmpeg pulls from: rtmp://127.0.0.1:<port>/live/<key> */
  localInput: string;
};

export type TPublisher = {
  streamName: string;
  ip: string;
  sessionId: string;
};

/**
 * Two independent conditions decide what the plugin does:
 *
 *   publisher  = someone is pushing RTMP (the RTMP session survives alone)
 *   runtime    = a voice runtime exists (only while someone is in the channel)
 *
 * Both true  -> ffmpeg + mediasoup + a visible stream.
 * Only publisher -> hold the RTMP session, spend no CPU.
 */
export class LiveSession {
  private publisher: (TPublisher & { since: number }) | null = null;
  private bridge: TBridgeHandle | null = null;
  private runtime = false;
  private liveSince: number | null = null;
  private lastError: string | null = null;

  /** Every transition runs through here, one at a time. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: PluginContext,
    private config: TLiveConfig,
    private readonly kickPublisher: (sessionId: string) => void,
  ) {}

  getConfig = (): TLiveConfig => this.config;

  hasPublisher = (): boolean => this.publisher !== null;

  updateConfig = (next: Partial<TLiveConfig>): void => {
    this.config = { ...this.config, ...next };

    void this.enqueue(() => this.reconcile());
  };

  handlePublish = (info: TPublisher): void => {
    this.publisher = { ...info, since: Date.now() };
    this.lastError = null;

    void this.enqueue(() => this.reconcile());
  };

  handleUnpublish = (info: { streamName: string }): void => {
    if (!this.publisher || this.publisher.streamName !== info.streamName) return;

    this.publisher = null;

    void this.enqueue(() => this.reconcile());
  };

  setRuntime = (present: boolean): void => {
    if (this.runtime === present) return;

    this.runtime = present;

    void this.enqueue(() => this.reconcile());
  };

  /** Admin pressed stop: drop the publisher too, not just the stream. */
  stop = (): void => {
    const current = this.publisher;

    this.publisher = null;

    if (current) {
      try {
        this.kickPublisher(current.sessionId);
      } catch (error) {
        this.ctx.logger.error(`断开推流失败: ${(error as Error).message}`);
      }
    }

    void this.enqueue(() => this.reconcile());
  };

  dispose = async (): Promise<void> => {
    this.publisher = null;

    await this.enqueue(async () => {
      await this.stopBridge();
    });
  };

  status = (): TLiveStatus => ({
    state: this.state(),
    channelId: this.config.channelId,
    channelName: this.config.channelName,
    publisherSince: this.publisher?.since ?? null,
    liveSince: this.liveSince,
    rtmpPort: this.config.rtmpPort,
    lastError: this.lastError,
  });

  private state = (): TLiveState => {
    if (this.bridge) return "live";
    if (this.lastError) return "error";
    if (this.publisher) return "ingesting";

    return "idle";
  };

  private enqueue = (work: () => Promise<void>): Promise<void> => {
    const next = this.queue.then(work, work);

    // A failed transition must not poison the ones behind it.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  };

  private reconcile = async (): Promise<void> => {
    const wanted =
      this.publisher !== null &&
      this.runtime &&
      this.config.channelId > 0 &&
      this.config.localInput !== "";

    if (wanted && !this.bridge) {
      await this.beginBridge();
    } else if (!wanted && this.bridge) {
      await this.stopBridge();
    }
  };

  private beginBridge = async (): Promise<void> => {
    if (this.config.channelId <= 0) {
      this.lastError = "还没有选择直播频道";

      return;
    }

    try {
      this.bridge = await startBridge({
        ctx: this.ctx,
        channelId: this.config.channelId,
        input: this.config.localInput,
        ffmpegBin: this.config.ffmpegBin,
        videoMode: this.config.videoMode,
        bitrateKbps: this.config.bitrateKbps,
        onLog: (message) => this.ctx.logger.log(message),
        onFfmpegExit: (code) => {
          // The bridge already stopped itself; drop it and surface the reason
          // instead of restarting in a loop over a broken stream.
          void this.enqueue(async () => {
            await this.stopBridge();

            this.lastError = `ffmpeg 退出（code ${code}），推流可能已中断`;

            this.ctx.logger.error(this.lastError);
          });
        },
      });

      this.liveSince = Date.now();
      this.lastError = null;

      this.ctx.logger.log(`开始向频道 ${this.config.channelId} 发布直播`);
    } catch (error) {
      this.lastError = (error as Error).message;

      this.ctx.logger.error(`发布直播失败: ${this.lastError}`);
    }
  };

  private stopBridge = async (): Promise<void> => {
    const current = this.bridge;

    this.bridge = null;
    this.liveSince = null;

    if (!current) return;

    await current.stop();

    this.ctx.logger.log("直播已停止");
  };
}
