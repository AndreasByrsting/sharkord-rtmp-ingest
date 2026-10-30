/**
 * Minimal ambient types for node-media-server 2.x. The package ships no
 * typings of its own and we only use a handful of members.
 */
declare module "node-media-server" {
  /** NodeRtmpSession; `ip` is the remote address NodeMediaServer recorded. */
  type TSession = {
    id: string;
    ip?: string;
    reject: () => void;
  };

  /** Connection query args (`app`, `type`, `flashVer`, `tcUrl`) — no client IP. */
  type TPublishArgs = {
    app?: string;
    type?: string;
    flashVer?: string;
    tcUrl?: string;
  };

  class NodeMediaServer {
    constructor(config: unknown);

    on(
      event: "prePublish",
      listener: (id: string, streamPath: string, args: TPublishArgs) => void,
    ): void;

    on(
      event: "postPublish",
      listener: (id: string, streamPath: string, args: TPublishArgs) => void,
    ): void;

    on(
      event: "donePublish",
      listener: (id: string, streamPath: string, args: TPublishArgs) => void,
    ): void;

    getSession: (id: string) => TSession | undefined;

    run: () => void;

    stop: () => void;
  }

  export = NodeMediaServer;
}
