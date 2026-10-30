import type { PluginContext } from "@sharkord/plugin-sdk";
import {
  AUDIO_PAYLOAD_TYPE,
  AUDIO_SSRC,
  VIDEO_PAYLOAD_TYPE,
  VIDEO_SSRC,
  buildFfmpegArgs,
  spawnFfmpeg,
  type TFfmpegHandle,
  type TVideoMode,
} from "./ffmpeg";

export type TBridgeOptions = {
  ctx: PluginContext;
  channelId: number;
  /** Local RTMP URL the ingest server is already serving. */
  input: string;
  ffmpegBin: string;
  videoMode: TVideoMode;
  bitrateKbps: number;
  onLog: (message: string) => void;
  onFfmpegExit: (code: number) => void;
};

export type TBridgeHandle = {
  stop: () => Promise<void>;
};

type TObserverEmitter = {
  on: (event: string, handler: (...args: any[]) => void) => void;
  off?: (event: string, handler: (...args: any[]) => void) => void;
};

type TObservableTransport = {
  id: string;
  observer: TObserverEmitter;
};

type TObservableConsumer = {
  id: string;
  kind: string;
  producerId: string;
};

/**
 * H264 parameters have to describe what ffmpeg actually sends. In `copy` mode
 * those come from the camera, so this constant only describes the transcode
 * profile; a source outside Baseline 3.1 can show a black picture in copy mode.
 */
const videoCodec = {
  mimeType: "video/H264",
  payloadType: VIDEO_PAYLOAD_TYPE,
  clockRate: 90000,
  parameters: {
    "packetization-mode": 1,
    "profile-level-id": "42e01f",
    "level-asymmetry-allowed": 1,
  },
  rtcpFeedback: [
    { type: "nack" },
    { type: "nack", parameter: "pli" },
  ],
};

const audioCodec = {
  mimeType: "audio/opus",
  payloadType: AUDIO_PAYLOAD_TYPE,
  clockRate: 48000,
  channels: 2,
  parameters: {},
  rtcpFeedback: [],
};

export const startBridge = async (
  options: TBridgeOptions,
): Promise<TBridgeHandle> => {
  const { ctx, channelId } = options;

  const router = ctx.voice.getRouter(channelId);

  /**
   * Watching the router is the only way to tell "nobody is subscribing" apart
   * from "subscribed but the transport never connected". Both look identical
   * from the outside: a blank card and no server error.
   */
  const routerObserver = (router as unknown as { observer?: TObserverEmitter })
    .observer;

  let videoProducerId = "";
  let audioProducerId = "";

  const onNewTransport = (transport: TObservableTransport) => {
    transport.observer?.on("newconsumer", (consumer: TObservableConsumer) => {
      if (
        consumer.producerId !== videoProducerId &&
        consumer.producerId !== audioProducerId
      ) {
        return;
      }

      options.onLog(
        `有观众开始观看（${consumer.producerId === videoProducerId ? "视频" : "音频"}）`,
      );
    });
  };

  routerObserver?.on("newtransport", onNewTransport);

  /**
   * ffmpeg runs in this very process tree, so RTP never leaves the host:
   * 127.0.0.1 needs no port mapping and no announced address.
   */
  const createTransport = () =>
    router.createPlainTransport({
      listenInfo: { ip: "127.0.0.1", protocol: "udp" },
      rtcpMux: true,
      comedia: true,
    });

  const videoTransport = await createTransport();
  const audioTransport = await createTransport();

  const videoPort = videoTransport.tuple.localPort;
  const audioPort = audioTransport.tuple.localPort;

  let ffmpeg: TFfmpegHandle | undefined;
  let stopped = false;

  try {
    const videoProducer = await videoTransport.produce({
      kind: "video",
      rtpParameters: {
        codecs: [videoCodec],
        encodings: [{ ssrc: VIDEO_SSRC }],
      },
    });

    const audioProducer = await audioTransport.produce({
      kind: "audio",
      rtpParameters: {
        codecs: [audioCodec],
        encodings: [{ ssrc: AUDIO_SSRC }],
      },
    });

    videoProducerId = videoProducer.id;
    audioProducerId = audioProducer.id;

    const stream = ctx.voice.createStream({
      channelId,
      title: "直播",
      key: "rtmp-live",
      producers: { video: videoProducer, audio: audioProducer },
    });

    const args = buildFfmpegArgs({
      input: options.input,
      videoPort,
      audioPort,
      mode: options.videoMode,
      bitrateKbps: options.bitrateKbps,
    });

    options.onLog(`ffmpeg ${args.join(" ")}`);

    ffmpeg = spawnFfmpeg({
      bin: options.ffmpegBin,
      args,
      onLog: options.onLog,
      onExit: (code) => {
        if (stopped) return;

        options.onFfmpegExit(code);
      },
    });

    return {
      stop: async () => {
        if (stopped) return;

        stopped = true;

        routerObserver?.off?.("newtransport", onNewTransport);

        ffmpeg?.stop();

        try {
          stream.remove();
        } catch (error) {
          options.onLog(`移除直播流失败: ${(error as Error).message}`);
        }

        videoProducer.close();
        audioProducer.close();
        videoTransport.close();
        audioTransport.close();
      },
    };
  } catch (error) {
    ffmpeg?.stop();

    videoTransport.close();
    audioTransport.close();

    throw error;
  }
};
