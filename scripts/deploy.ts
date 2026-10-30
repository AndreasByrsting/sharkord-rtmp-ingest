/**
 * Copies the built plugin into a Sharkord plugins directory.
 *
 * Sharkord imports `<plugins>/<pluginId>/server/index.js` at load time and only
 * watches that directory for removals, so a freshly copied plugin needs a
 * container restart before the server sees it.
 *
 *   bun run deploy            # uses SHARKORD_PLUGINS_PATH from .env
 *   bun run deploy /path/to/plugins
 */
import fs from "node:fs/promises";
import path from "node:path";

const pluginsPath = (process.argv[2] ?? process.env.SHARKORD_PLUGINS_PATH ?? "").trim();

if (!pluginsPath) {
  console.error(
    [
      "缺少插件目录。两种写法任选：",
      "  bun run deploy /path/to/sharkord/plugins",
      "  在 .env 里设置 SHARKORD_PLUGINS_PATH=/path/to/sharkord/plugins",
      "",
      "Docker 部署时，这个目录是宿主机上被挂载进容器的那个 data 目录下的 plugins/。",
    ].join("\n"),
  );
  process.exit(1);
}

const root = path.resolve(import.meta.dir, "..");
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "manifest.json"), "utf8"),
) as { id: string };

const source = path.join(root, "dist", manifest.id);
const target = path.resolve(pluginsPath, manifest.id);

await fs.access(path.join(source, "manifest.json")).catch(() => {
  console.error(`没有构建产物：${source}\n先执行 bun run build。`);
  process.exit(1);
});

await fs.mkdir(pluginsPath, { recursive: true });
await fs.rm(target, { recursive: true, force: true });
await fs.cp(source, target, { recursive: true });

console.log(`已部署到 ${target}`);
console.log("重启服务端后才能加载新插件：");
console.log("  docker restart sharkord");
console.log("原生部署：在服务器设置里关掉再打开插件开关，或重启进程。");
