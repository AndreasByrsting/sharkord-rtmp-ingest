import { build } from "@sharkord/plugin-builder";
import { PLUGIN_SDK_VERSION } from "@sharkord/plugin-sdk";
import fs from "fs/promises";
import path from "path";

// Set SHARKORD_PLUGINS_PATH in .env and every build lands straight in your
// server, which is most of the edit-build-reload loop. See .env.example.
const pluginsPath = (process.env.SHARKORD_PLUGINS_PATH ?? "").trim();

const readJson = async (file: string) =>
  JSON.parse(await fs.readFile(path.resolve(file), "utf-8"));

const pkg = await readJson("package.json");
const manifest = await readJson("manifest.json");

const repoSlug = (value: unknown): string => {
  const raw =
    typeof value === "string" ? value : ((value as { url?: string })?.url ?? "");

  return raw
    .replace(/^git\+/, "")
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .trim();
};

// The builder defaults downloadUrl to "ADD_DOWNLOAD_URL_HERE", which then has
// to be patched by hand before every release. Derive it from the repository
// and version instead, so dist/<version>.json is uploadable as-is.
const repo = repoSlug(pkg.repository) || repoSlug(pkg.homepage);
const downloadUrl = repo
  ? `https://github.com/${repo}/releases/download/v${pkg.version}/${manifest.id}-${pkg.version}.tar.gz`
  : undefined;

const result = await build({ sdkVersion: PLUGIN_SDK_VERSION, downloadUrl });

console.log(`Build output: ${result.outDir}`);
console.log(`Archive:      ${result.archivePath}`);

const copyTo = async (target: string): Promise<void> => {
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(result.outDir, target, { recursive: true });

  console.log(`Copied the built plugin to ${target}`);
};

if (!pluginsPath) {
  console.log(
    "SHARKORD_PLUGINS_PATH is not set, so the plugin was not copied anywhere.\n" +
      "Point it at your server's plugins directory in .env to deploy on every build.",
  );
} else if (!(await fs.stat(pluginsPath).then(() => true, () => false))) {
  // Never create the directory: a stale path would otherwise leave an empty
  // tree somewhere and look like a successful deploy.
  console.warn(
    `SHARKORD_PLUGINS_PATH does not exist: ${pluginsPath}\n` +
      `Nothing was copied. Fix the path in .env, or run: bun run deploy <plugins dir>`,
  );
} else {
  const targetPath = path.join(pluginsPath, path.basename(result.outDir));

  try {
    await copyTo(targetPath);
  } catch (error) {
    // A bad path must not throw away a perfectly good build.
    console.warn(
      `Could not copy the plugin to "${targetPath}": ${(error as Error).message}\n` +
        `The build itself succeeded: ${result.outDir}`,
    );
  }
}
