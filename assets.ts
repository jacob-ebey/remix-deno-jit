import { AssetsManifest } from "https://esm.sh/v94/@remix-run/server-runtime@1.11.1/dist/entry.d.ts";
import { esbuild } from "./esbuild.ts";

interface Asset {
  href: string;
  content: Promise<string>;
}

declare global {
  var __BROWSER_BUILD__: boolean;
  var __remixManifest: AssetsManifest;
}

export const settings: {
  assetsDirectory?: string;
  getChecksum: () => string;
} = {
  getChecksum: () => window.__remixManifest.version,
};

let assetChecksum: string | undefined =
  typeof __BROWSER_BUILD__ !== "undefined"
    ? __remixManifest.version
    : undefined;

export const assets = new Map<string, Asset>();
export function asset(
  assetPath: string,
  transform?: (content: string) => Promise<string>
): Asset {
  const asset = {
    get href() {
      if (!assetChecksum) {
        if (!settings.getChecksum) {
          throw new Error("settings.getChecksum is not defined");
        }
        assetChecksum = settings.getChecksum();
      }

      const href = `/${assetChecksum}${assetPath}`;
      assets.set(href, asset);
      return href;
    },
    get content() {
      if (typeof __BROWSER_BUILD__ !== "undefined") return Promise.resolve("");

      return Deno.readTextFile(settings.assetsDirectory + assetPath).then(
        (raw) => {
          return transform ? transform(raw) : raw;
        }
      );
    },
  };

  return asset;
}

export const css =
  typeof __BROWSER_BUILD__ !== "undefined"
    ? undefined
    : async (content: string) => {
        const result = await esbuild.transform(content, {
          loader: "css",
          minify: true,
        });
        return result.code;
      };
