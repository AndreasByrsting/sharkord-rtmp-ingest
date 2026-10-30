import { spawn } from "node:child_process";
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
export const resolveFfmpegBin = (
  ctx: PluginContext,
  configured: string,
): string => {
  const trimmed = configured.trim();

  if (trimmed) return trimmed;

  const local = path.join(
    ctx.dataPath,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );

  if (fs.existsSync(local)) return local;

  return "ffmpeg";
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

  child.stderr?.on("data", (chunk: Buffer) => {
    tail = `${tail}${chunk.toString()}`.slice(-STDERR_TAIL);
  });

  child.on("error", (error: Error) => {
    options.onLog(`ffmpeg 无法启动: ${error.message}`);

    options.onExit(-1);
  });

  child.on("exit", (code: number | null) => {
    if (tail.trim()) options.onLog(tail.trim().split("\n").slice(-4).join(" | "));

    options.onExit(code ?? -1);
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
