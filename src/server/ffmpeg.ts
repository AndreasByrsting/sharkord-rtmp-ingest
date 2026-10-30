import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PluginContext } from "@sharkord/plugin-sdk";

export type TVideoMode = "transcode" | "copy";

/**
 * Fixed because the mediasoup producers below declare the same values.
 *
 * ffmpeg's `-ssrc` is parsed as a signed 32-bit int, so anything above
 * 2147483647 aborts with "Value ... out of range" — keep these small.
 */
export const VIDEO_SSRC = 1111111111;
export const AUDIO_SSRC = 1222222222;
export const VIDEO_PAYLOAD_TYPE = 96;
export const AUDIO_PAYLOAD_TYPE = 111;

const STDERR_TAIL = 2000;

export type TFfmpegHandle = {
  stop: () => void;
  /** Last lines ffmpeg wrote to stderr, for the error message. */
  tail: () => string;
  pid: number | undefined;
};

/**
 * Order of preference: the path an admin typed, a binary dropped into the
 * plugin's data folder, then whatever is on PATH.
 */
export const localFfmpegPath = (dataPath: string): string =>
  path.join(dataPath, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

export const resolveFfmpegBin = (
  ctx: PluginContext,
  configured: string,
): string => {
  const trimmed = configured.trim();

  if (trimmed) return trimmed;

  const local = localFfmpegPath(ctx.dataPath);

  if (fs.existsSync(local)) return local;

  return "ffmpeg";
};

const originOf = (bin: string, dataPath: string): string => {
  if (bin === localFfmpegPath(dataPath)) return "插件数据目录";
  if (bin === "ffmpeg" || bin === "ffmpeg.exe") return "系统 PATH";

  return "设置项「ffmpeg 路径」";
};

/**
 * Spawning a missing binary does not throw: the failure arrives later as an
 * async 'error' event, and by then the mediasoup transports and the "直播"
 * stream already exist — the viewer watches an empty card collapse, while the
 * log only says `Executable not found in $PATH`. Probe first instead.
 */
export const probeFfmpeg = (
  bin: string,
  dataPath: string,
): { ok: true } | { ok: false; message: string } => {
  const result = spawnSync(bin, ["-version"], {
    stdio: "ignore",
    timeout: 10_000,
    windowsHide: true,
  });

  if (!result.error && result.status === 0) return { ok: true };

  const local = localFfmpegPath(dataPath);
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const reason = result.error
    ? code === "ENOENT"
      ? `找不到可执行文件 "${bin}"`
      : result.error.message
    : `"${bin}" 退出码 ${result.status ?? "unknown"}`;

  // The container image ships without ffmpeg, so this is the common case and
  // the message has to say what to do, not just what failed.
  return {
    ok: false,
    message: [
      `${reason}，直播无法开始。`,
      `解析到：${bin}（${originOf(bin, dataPath)}）；插件数据目录：${local}${fs.existsSync(local) ? "" : "（不存在）"}`,
      `容器默认不带 ffmpeg：把静态版二进制放成 ${local} 并 chmod +x，或在设置里填容器内绝对路径，然后重启容器。`,
      "静态版需要自带 libx264 与 libopus（ffmpeg -encoders 可查）。",
    ].join("\n"),
  };
};

const videoArgs = (mode: TVideoMode, bitrateKbps: number): string[] =>
  mode === "copy"
    ? // Passthrough keeps the source SPS/PPS, so the profile-level-id the
      // producer announces may not match. See the note in bridge.ts.
      ["-c:v", "copy"]
    : [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "baseline",
        "-level",
        "3.1",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "30",
        "-keyint_min",
        "30",
        "-sc_threshold",
        "0",
        "-b:v",
        `${bitrateKbps}k`,
        "-maxrate",
        `${bitrateKbps}k`,
        "-bufsize",
        `${bitrateKbps * 2}k`,
      ];

export type TFfmpegInput = {
  input: string;
  videoPort: number;
  audioPort: number;
  mode: TVideoMode;
  bitrateKbps: number;
};

export const buildFfmpegArgs = (options: TFfmpegInput): string[] => [
  "-hide_banner",
  "-loglevel",
  "warning",
  "-nostdin",
  "-rtmp_live",
  "live",
  "-i",
  options.input,

  // video out
  "-map",
  "0:v:0",
  ...videoArgs(options.mode, options.bitrateKbps),
  "-an",
  "-f",
  "rtp",
  "-payload_type",
  String(VIDEO_PAYLOAD_TYPE),
  "-ssrc",
  String(VIDEO_SSRC),
  `rtp://127.0.0.1:${options.videoPort}?pkt_size=1200`,

  // audio out; RTMP carries AAC, mediasoup wants Opus
  "-map",
  "0:a:0?",
  "-vn",
  "-c:a",
  "libopus",
  "-b:a",
  "96k",
  "-ar",
  "48000",
  "-ac",
  "2",
  "-application",
  "lowdelay",
  "-frame_duration",
  "20",
  "-f",
  "rtp",
  "-payload_type",
  String(AUDIO_PAYLOAD_TYPE),
  "-ssrc",
  String(AUDIO_SSRC),
  `rtp://127.0.0.1:${options.audioPort}?pkt_size=1200`,
];

export type TSpawnOptions = {
  bin: string;
  args: string[];
  onExit: (code: number) => void;
  onLog: (line: string) => void;
};

export const spawnFfmpeg = (options: TSpawnOptions): TFfmpegHandle => {
  const child = spawn(options.bin, options.args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  let tail = "";
  let finished = false;

  // 'error' and 'exit' both fire for a binary that could not be started, and
  // the caller treats every callback as "the stream is over".
  const finish = (code: number): void => {
    if (finished) return;

    finished = true;

    options.onExit(code);
  };

  child.stderr?.on("data", (chunk: Buffer) => {
    tail = `${tail}${chunk.toString()}`.slice(-STDERR_TAIL);
  });

  child.on("error", (error: Error) => {
    options.onLog(`ffmpeg 无法启动（${options.bin}）: ${error.message}`);

    finish(-1);
  });

  child.on("exit", (code: number | null) => {
    if (tail.trim()) options.onLog(tail.trim().split("\n").slice(-4).join(" | "));

    finish(code ?? -1);
  });

  return {
    pid: child.pid,
    tail: () => tail,
    stop: () => {
      if (child.exitCode !== null || child.killed) return;

      child.kill("SIGKILL");
    },
  };
};
