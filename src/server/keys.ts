import { randomBytes } from "node:crypto";
import type { PluginContext } from "@sharkord/plugin-sdk";
import type { TKeyInfo } from "../types";

const STORAGE_KEY = "stream-key";
const KEY_BYTES = 18;

export type TStoredKey = {
  streamKey: string;
  createdAt: number;
};

const generateStreamKey = () => randomBytes(KEY_BYTES).toString("base64url");

const read = async (ctx: PluginContext): Promise<TStoredKey | undefined> =>
  ctx.storage.get<TStoredKey>(STORAGE_KEY);

export const rotateKey = async (ctx: PluginContext): Promise<TStoredKey> => {
  const stored: TStoredKey = {
    streamKey: generateStreamKey(),
    createdAt: Date.now(),
  };

  await ctx.storage.set(STORAGE_KEY, stored);

  return stored;
};

export const ensureKey = async (ctx: PluginContext): Promise<TStoredKey> =>
  (await read(ctx)) ?? (await rotateKey(ctx));

/**
 * A single flat URL is what DJI cameras and similar devices accept, so the
 * key goes into the path. OBS splits the same URL into address + key.
 */
export const buildKeyInfo = (
  stored: TStoredKey,
  host: string,
  publicPort: number,
  listenPort: number,
): TKeyInfo => {
  // The port the client must dial is the one published on the host, not the one
  // the server binds to; Docker port mapping is where those two diverge.
  const streamUrl = `rtmp://${host}:${publicPort}/live`;

  return {
    streamKey: stored.streamKey,
    publishUrl: `${streamUrl}/${stored.streamKey}`,
    streamUrl,
    host,
    listenPort,
    publicPort,
    createdAt: stored.createdAt,
  };
};

/** Timing safe compare, but length differences are already a mismatch. */
export const matchesKey = (candidate: string, expected: string): boolean => {
  if (candidate.length !== expected.length) return false;

  let diff = 0;

  for (let i = 0; i < candidate.length; i += 1) {
    diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  return diff === 0;
};
