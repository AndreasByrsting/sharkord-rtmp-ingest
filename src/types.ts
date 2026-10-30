/**
 * Contract between the server half and the browser half.
 *
 * The server passes this to `PluginContext<TPlugin>`; the client imports it
 * with `import type`, so names and payloads are checked on both sides and
 * nothing reaches the bundle.
 */

export type TLiveState = "idle" | "ingesting" | "live" | "error";

export type TLiveStatus = {
  state: TLiveState;
  channelId: number;
  channelName: string | null;
  publisherSince: number | null;
  liveSince: number | null;
  rtmpPort: number;
  lastError: string | null;
};

export type TKeyInfo = {
  streamKey: string;
  /** Full URL for clients with a single address field (DJI, Larix). */
  publishUrl: string;
  /** Server field for clients that split address and key (OBS). */
  streamUrl: string;
  /** Host shown in the URLs. */
  host: string;
  /** Port the RTMP server listens on inside the process/container. */
  listenPort: number;
  /** Port shown in the URLs; differs from listenPort behind NAT/docker. */
  publicPort: number;
  createdAt: number;
};

export type TNoArgs = Record<string, never>;

/**
 * Two commands, both answering the invoker alone:
 *
 *   live          the current publish address
 *   live-refresh  a brand new one, and the running stream is cut
 *
 * No actions and no UI: everything an admin needs is in chat, which keeps the
 * permission page down to those two entries.
 */
export type TPlugin = {
  commands: {
    live: { args: TNoArgs; response: string };
    "live-refresh": { args: TNoArgs; response: string };
  };
};
