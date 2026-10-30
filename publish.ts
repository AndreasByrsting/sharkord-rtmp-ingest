/**
 * Publishes a build to GitHub Releases through the plugin builder.
 *
 * The repository is never hardcoded here: it comes from `GITHUB_REPOSITORY`
 * (`owner/repo`, the variable GitHub Actions already exports) or from the
 * `repository` field of package.json. Run it locally with:
 *
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo bun run publish
 */
import { publish } from "@sharkord/plugin-builder";
import { PLUGIN_SDK_VERSION } from "@sharkord/plugin-sdk";
import pkg from "./package.json";

/** package.json is checked as a literal type, so read it structurally. */
const meta = pkg as {
  repository?: string | { url?: string };
};

const declared =
  typeof meta.repository === "string" ? meta.repository : meta.repository?.url;

const repo = (process.env.GITHUB_REPOSITORY ?? declared ?? "").replace(
  /^https?:\/\/github\.com\//,
  "",
).replace(/\.git$/, "");

if (!repo) {
  console.error(
    [
      "缺少 GitHub 仓库地址，无法发布。三种写法任选：",
      "  GITHUB_REPOSITORY=owner/repo bun run publish",
      '  或在 package.json 里加 "repository": "https://github.com/owner/repo"',
      "  CI 里 GitHub Actions 会自动提供 GITHUB_REPOSITORY",
    ].join("\n"),
  );
  process.exit(1);
}

const result = await publish({
  githubToken: process.env.GITHUB_TOKEN,
  repo,
  sdkVersion: PLUGIN_SDK_VERSION,
});

console.log("Plugin published successfully", result.releaseUrl);
