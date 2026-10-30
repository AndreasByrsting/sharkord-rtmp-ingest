import NodeMediaServer from "node-media-server";

export type TPublishInfo = {
  streamName: string;
  ip: string;
  sessionId: string;
};

export type TIngestHandlers = {
  /** Return false to drop the publisher. */
  onPrePublish: (info: TPublishInfo & { reject: () => void }) => boolean;
  onPublish: (info: TPublishInfo) => void;
  onUnpublish: (info: TPublishInfo) => void;
  onLog: (message: string) => void;
};

export type TIngestHandle = {
  stop: () => void;
  /** Drops a publishing session, used by the admin "stop" button. */
  kick: (sessionId: string) => void;
};

const APP = "live";

/**
 * `/live/<key>` is the only accepted shape, which covers both clients: OBS
 * splits it into address `rtmp://host:port/live` and key `<key>`, while a DJI
 * camera takes the whole thing as one string.
 *
 * The app name is validated too: anything pushed to another app would be
 * accepted by the RTMP server and then pulled from a URL that never existed,
 * which only shows up later as an ffmpeg exit.
 */
const parseStreamPath = (streamPath: string): { app: string; name: string } => {
  const cleaned = streamPath.split("?")[0] ?? "";
  const segments = cleaned.split("/").filter(Boolean);

  return { app: segments[0] ?? "", name: segments[1] ?? "" };
};

export const startIngest = (
  port: number,
  handlers: TIngestHandlers,
): TIngestHandle => {
  const server = new NodeMediaServer({
    rtmp: {
      port,
      chunk_size: 60000,
      // An unattended stream would otherwise grow a frame cache forever.
      gop_cache: false,
      ping: 30,
      ping_timeout: 60,
    },
  });

  // The publish args only carry the connection query string, so the client
  // address has to come off the session itself.
  const ipOf = (id: string): string => server.getSession(id)?.ip ?? "";

  server.on("prePublish", (id, streamPath) => {
    const { app, name } = parseStreamPath(streamPath);
    const info: TPublishInfo = {
      streamName: name,
      ip: ipOf(id),
      sessionId: id,
    };
    const reject = () => server.getSession(id)?.reject();

    if (app !== APP) {
      handlers.onLog(`拒绝推流：路径必须以 /${APP}/ 开头，收到 /${app}/`);

      reject();

      return;
    }

    const accepted = handlers.onPrePublish({ ...info, reject });

    if (!accepted) {
      handlers.onLog(`拒绝推流: ${info.ip || "unknown"} / ${info.streamName}`);
    }
  });

  server.on("postPublish", (id, streamPath) => {
    const { app, name } = parseStreamPath(streamPath);

    if (app !== APP) return;

    handlers.onPublish({ streamName: name, ip: ipOf(id), sessionId: id });
  });

  server.on("donePublish", (id, streamPath) => {
    const { app, name } = parseStreamPath(streamPath);

    if (app !== APP) return;

    handlers.onUnpublish({ streamName: name, ip: ipOf(id), sessionId: id });
  });

  server.run();

  handlers.onLog(`RTMP 服务器已监听 ${port}/tcp，路径 /${APP}/<streamKey>`);

  return {
    stop: () => {
      try {
        server.stop();
      } catch (error) {
        handlers.onLog(`关闭 RTMP 服务器时出错: ${(error as Error).message}`);
      }
    },
    kick: (sessionId) => {
      try {
        server.getSession(sessionId)?.reject();
      } catch (error) {
        handlers.onLog(`断开推流会话失败: ${(error as Error).message}`);
      }
    },
  };
};
