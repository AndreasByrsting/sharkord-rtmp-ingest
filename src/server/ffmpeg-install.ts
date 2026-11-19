import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

/**
 * ffmpeg is not part of the plugin archive and never can be: the marketplace
 * rejects anything above 20 MB, and a static build is 76 MB. It is also not in
 * the server image (`oven/bun` ships no ffmpeg), so a fresh install has nothing
 * to spawn.
 *
 * This module fetches one, once, into `dataPath` — the folder that survives
 * plugin updates, unlike the plugin's own directory.
 *
 * Source: the ffmpeg-static release assets — one **single gzipped binary** per
 * platform, not an archive. That packaging is the reason this module exists:
 * upstream ships `.tar.xz`, and Bun's zlib inflates gzip but has no xz decoder,
 * so a tarball could not be unpacked at runtime.
 *
 * Each asset is a different upstream build (the versions differ, that is
 * expected): linux and darwin are johnvansickle's static builds, win32 is
 * gyan.dev's `essentials` static build. All are GPL and do carry libx264 +
 * libopus, which the transcode path requires.
 *
 * Pinned by release tag, sha256 and byte length, all verified against the
 * published assets.
 */
export type TFfmpegBuild = {
  url: string;
  sha256: string;
  /** Exact size of the .gz, so a truncated download fails before it is used. */
  bytes: number;
};

const RELEASE =
  "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";

const builds: Record<string, TFfmpegBuild> = {
  "linux-x64": {
    url: `${RELEASE}/ffmpeg-linux-x64.gz`,
    sha256: "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa",
    bytes: 29354986,
  },
  "linux-arm64": {
    url: `${RELEASE}/ffmpeg-linux-arm64.gz`,
    sha256: "754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0",
    bytes: 25568691,
  },
  "win32-x64": {
    url: `${RELEASE}/ffmpeg-win32-x64.gz`,
    sha256: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
    bytes: 29581307,
  },
  "darwin-x64": {
    url: `${RELEASE}/ffmpeg-darwin-x64.gz`,
    sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
    bytes: 25296431,
  },
  "darwin-arm64": {
    url: `${RELEASE}/ffmpeg-darwin-arm64.gz`,
    sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
    bytes: 19246198,
  },
};

/** Where the "it failed, now what" answers live. Printed with every failure. */
export const FAQ_URL =
  "https://github.com/AndreasByrsting/sharkord-rtmp-ingest/blob/develop/docs/FAQ.md";

/**
 * A 28 MB transfer that has not finished in ten minutes is not going to:
 * something is throttling or black-holing the connection. Per attempt, not
 * overall — retries get their own budget. The caller can raise this through
 * the "下载超时" setting, since a genuinely slow link is not a failure.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const ATTEMPTS = 3;
/** Waits before attempt 2 and 3. Long enough for a flaky link to breathe. */
const RETRY_DELAYS_MS = [3000, 8000];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Worth another attempt: dropped socket, 5xx, timeout, truncated body. */
class RetryableError extends Error {}

/** Retrying the same URL cannot help: 404, sha256 mismatch, garbage body. */
class FatalError extends Error {}

/** Platforms without a pinned build have to install ffmpeg by hand. */
export const ffmpegBuildForHost = (): TFfmpegBuild | undefined =>
  builds[`${process.platform}-${process.arch}`];

export const hostKey = (): string => `${process.platform}-${process.arch}`;

export const localFfmpegPath = (dataPath: string): string =>
  path.join(dataPath, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

const mb = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`;

/** Progress needs a decimal; "1 MB" for 1.4 MB looks like a stall. */
const mb1 = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

export type TInstallResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; message: string };

export type TInstallOptions = {
  dataPath: string;
  onLog: (message: string) => void;
  /** Per-attempt cap in ms. Comes from the settings, defaults to 10 minutes. */
  timeoutMs?: number;
};

let pending: Promise<TInstallResult> | undefined;
let stage: string | null = null;

/**
 * Whether a download is in progress, so the "ffmpeg missing" message can say
 * "wait" instead of repeating the manual instructions.
 */
export const ffmpegInstallStatus = (): {
  running: boolean;
  stage: string | null;
} => ({ running: pending !== undefined, stage });

/**
 * An existing binary that answers `-version` is the finished product: the file
 * only appears in place through an atomic rename *after* sha256 matched, so a
 * second download would spend 30 MB to overwrite something identical. The probe
 * is there for binaries an admin dropped in by hand.
 */
const usableBytes = (file: string): number | null => {
  if (!existsSync(file)) return null;

  const probe = spawnSync(file, ["-version"], {
    stdio: "ignore",
    timeout: 10_000,
    windowsHide: true,
  });

  if (probe.error || probe.status !== 0) return null;

  try {
    return statSync(file).size;
  } catch {
    return null;
  }
};

/**
 * Single-flight: plugin load and `/live-ffmpeg` can both ask for this at the
 * same time, and a second 29 MB write over the first one would corrupt both.
 */
export const installFfmpeg = (options: TInstallOptions): Promise<TInstallResult> => {
  if (pending) return pending;

  const existing = localFfmpegPath(options.dataPath);
  const bytes = usableBytes(existing);

  if (bytes !== null) {
    return Promise.resolve({ ok: true, path: existing, bytes });
  }

  pending = run(options).finally(() => {
    pending = undefined;
    stage = null;
  });

  return pending;
};

const run = async ({ dataPath, onLog, timeoutMs }: TInstallOptions): Promise<TInstallResult> => {
  const target = localFfmpegPath(dataPath);
  const build = ffmpegBuildForHost();
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMin = Math.max(1, Math.round(timeout / 60000));

  if (!build) {
    return {
      ok: false,
      message: [
        `当前平台 ${hostKey()} 没有预置的 ffmpeg 包，需要手动放一个静态版到 ${target}。`,
        `做法见 ${FAQ_URL}`,
      ].join("\n"),
    };
  }

  const tempGz = `${target}.download-${process.pid}`;
  const tempBin = `${target}.unpack-${process.pid}`;

  let attempts = 0;

  try {
    await mkdir(dataPath, { recursive: true });

    stage = "连接中";
    onLog(
      `没有找到 ffmpeg，开始下载静态版（${hostKey()}，${mb(build.bytes)}，单次限时 ${timeoutMin} 分钟）…`,
    );

    attempts = await downloadWithRetry(build, tempGz, onLog, timeout);

    stage = "解压中";
    onLog("下载完成，正在校验并解压…");

    await pipeline(
      createReadStream(tempGz),
      createGunzip(),
      createWriteStream(tempBin, { mode: 0o755 }),
    );

    await chmod(tempBin, 0o755);

    const size = (await stat(tempBin)).size;

    if (size < 1048576) {
      throw new Error(`解压出来的文件只有 ${size} 字节，不像是 ffmpeg`);
    }

    await rename(tempBin, target);

    stage = null;
    onLog(`ffmpeg 已下载并校验通过：${target}（${mb(size)}）`);

    return { ok: true, path: target, bytes: size };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    // The raw reason is kept: "HTTP 502" from a corporate proxy and "EACCES"
    // mean different things to whoever reads the log. The link is what turns
    // that into an action.
    return {
      ok: false,
      message: [
        `安装 ffmpeg 失败：${reason}`,
        attempts > 0 ? `已尝试 ${attempts} 次。` : "",
        `排查与手动安装见：${FAQ_URL}`,
        `也可以在别处下载后放到 ${target}：`,
        `curl -L ${build.url} | gunzip > "${target}" && chmod +x "${target}"`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  } finally {
    await rm(tempGz, { force: true });
    await rm(tempBin, { force: true });
  }
};

/**
 * Three attempts, and the reason is worth logging: on a throttled or flaky
 * uplink the first stream usually dies mid-body, while the same URL works on
 * the retry. Only network-level failures are retried — a sha256 mismatch means
 * the bytes are wrong, and asking again will not change them.
 */
const downloadWithRetry = async (
  build: TFfmpegBuild,
  outputPath: string,
  onLog: (message: string) => void,
  timeoutMs: number,
): Promise<number> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (attempt > 1) onLog(`第 ${attempt}/${ATTEMPTS} 次尝试…`);

      await download(build, outputPath, onLog, timeoutMs);

      return attempt;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      if (error instanceof FatalError || attempt >= ATTEMPTS) {
        throw error instanceof FatalError ? error : new Error(`${reason}（共尝试 ${attempt} 次）`);
      }

      const wait = RETRY_DELAYS_MS[attempt - 1] ?? 8000;

      onLog(`下载中断：${reason}。${Math.round(wait / 1000)} 秒后重试（${attempt}/${ATTEMPTS}）`);

      stage = `重试中（${attempt}/${ATTEMPTS}）`;

      await rm(outputPath, { force: true });
      await sleep(wait);
    }
  }
};

const download = async (
  build: TFfmpegBuild,
  outputPath: string,
  onLog: (message: string) => void,
  timeoutMs: number,
): Promise<void> => {
  let res: Response;

  try {
    res = await fetch(build.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;

    if (name === "TimeoutError" || name === "AbortError") {
      throw new RetryableError(
        `连接超时：${Math.max(1, Math.round(timeoutMs / 60000))} 分钟没有拿到响应`,
      );
    }

    throw new RetryableError((error as Error).message);
  }

  if (!res.ok || !res.body) {
    // 4xx means the asset is not there — retrying wastes ten minutes.
    const message = `HTTP ${res.status} ${res.statusText}`;

    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new FatalError(message);
    }

    throw new RetryableError(message);
  }

  // Only a sha256 match is trusted, but the size check catches a truncated
  // transfer early and produces a message that means something to a human.
  const limit = Math.round(build.bytes * 1.02);

  const hash = createHash("sha256");
  const handle = await open(outputPath, "w");

  let received = 0;
  let lastPercent = -1;
  let lastReportAt = Date.now();
  const startedAt = lastReportAt;

  try {
    const reader = res.body.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      received += value.byteLength;

      if (received > limit) {
        throw new FatalError(
          `下载体积异常（已收到 ${mb(received)}，预期 ${mb(build.bytes)}），已中止`,
        );
      }

      hash.update(value);
      await handle.write(value);

      const percent = Math.min(100, Math.floor((received / build.bytes) * 100));
      const now = Date.now();

      // Every 5% or every 3 seconds, whichever comes first: a 5% step is a
      // 1.4 MB jump, which never shows up on a slow link without the timer.
      const due = percent >= lastPercent + 5 || now - lastReportAt >= 3000;

      if (!due) continue;

      const seconds = Math.max(0.001, (now - startedAt) / 1000);
      const speed = `${mb1(received / seconds)}/s`;

      stage = `已下载 ${percent}%`;
      onLog(`ffmpeg 下载中：${percent}%（${mb1(received)} / ${mb(build.bytes)}，${speed}）`);

      lastPercent = percent;
      lastReportAt = now;
    }
  } catch (error) {
    if (error instanceof FatalError) throw error;

    // A body that dies mid-stream: worth exactly one more attempt.
    throw new RetryableError(
      `传输中断（已收到 ${mb1(received)}）：${(error as Error).message}`,
    );
  } finally {
    await handle.close();
  }

  if (received !== build.bytes) {
    throw new RetryableError(
      `下载不完整：收到 ${received} 字节，预期 ${build.bytes}`,
    );
  }

  const digest = hash.digest("hex");

  if (digest !== build.sha256) {
    throw new FatalError(
      `校验失败：sha256 ${digest} 与预期 ${build.sha256} 不一致，已丢弃`,
    );
  }
};
