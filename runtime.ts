import * as fs from "https://deno.land/std@0.154.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.154.0/path/mod.ts";
import { contentType } from "https://deno.land/std@0.154.0/media_types/mod.ts";
import { createHash } from "https://deno.land/std@0.154.0/hash/mod.ts";
import { LRU } from "https://deno.land/x/lru@1.0.2/mod.ts";
import { denoPlugin } from "https://deno.land/x/remix_esbuild_deno_loader@0.5.2/mod.ts";

import {
  type ServerBuild,
  createRequestHandler as createRemixRequestHandler,
} from "@remix-run/deno";

// -- esbuild --
// @deno-types="https://deno.land/x/esbuild@v0.14.39/mod.d.ts"
import esbuildWasm from "https://esm.sh/esbuild-wasm@0.15.7/lib/browser.js?pin=v86&target=deno";
import * as esbuildNative from "https://deno.land/x/esbuild@v0.15.7/mod.js";
// @ts-ignore trust me
const esbuild: typeof esbuildWasm =
  Deno.run === undefined ? esbuildWasm : esbuildNative;

let esbuildInitialized: boolean | Promise<void> = false;
async function ensureEsbuildInitialized() {
  if (esbuildInitialized === false) {
    if (Deno.run === undefined) {
      esbuildInitialized = esbuild.initialize({
        wasmURL: "https://esm.sh/esbuild-wasm@0.14.39/esbuild.wasm",
        worker: false,
      });
    } else {
      esbuild.initialize({});
    }
    await esbuildInitialized;
    esbuildInitialized = true;
  } else if (esbuildInitialized instanceof Promise) {
    await esbuildInitialized;
  }
}

interface CreateRequestHandlerArgs<Context> {
  browserImportMapPath: string;
  appDirectory?: string;
  staticDirectory?: string;
  mode?: "production" | "development";
  getLoadContext?: (request: Request) => Promise<Context>;
}

export function createRequestHandler<Context = unknown>({
  appDirectory = path.resolve(Deno.cwd(), "app"),
  browserImportMapPath,
  staticDirectory = path.resolve(Deno.cwd(), "public"),
  mode = "production",
  getLoadContext,
}: CreateRequestHandlerArgs<Context>) {
  appDirectory = path.resolve(appDirectory);
  staticDirectory = path.resolve(staticDirectory);

  const runtime = createRuntime({
    appDirectory,
    browserImportMapPath,
    staticDirectory,
    mode,
  });

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // Serve static files
    const staticPath = path.join(staticDirectory, url.pathname);
    try {
      const stat = await Deno.stat(staticPath);
      if (stat.isFile) {
        const contentTypeHeader = contentType(
          url.pathname.split(".").slice(-1)[0]
        );
        return new Response(await Deno.readFile(staticPath), {
          headers: contentTypeHeader
            ? {
                "Content-Type": contentTypeHeader,
              }
            : undefined,
        });
      }
    } catch {
      // do nothing
    }

    const assetsResponse = await runtime.serveAssets(url);
    if (assetsResponse) {
      return assetsResponse;
    }

    const remixRequestHandler = createRemixRequestHandler<Context>({
      mode,
      getLoadContext,
      build: await runtime.loadBuild(),
    });

    return await remixRequestHandler(request);
  };
}

function createRuntime({
  appDirectory,
  browserImportMapPath,
  staticDirectory,
  mode,
}: {
  appDirectory: string;
  browserImportMapPath: string;
  staticDirectory: string;
  mode: "production" | "development";
}) {
  const assetsLRU = new LRU<string>(500);

  let lastBuildChecksum: string | undefined;
  let lastBuild: ServerBuild | undefined;
  let lastBuildTime = 0;
  let lastModifiedTime = 0;
  let lastRoutes: Set<string> | undefined;

  if (mode === "development") {
    (async () => {
      const watcher = Deno.watchFs(appDirectory, {
        recursive: true,
      });
      for await (const event of watcher) {
        if (["create", "modify", "remove"].includes(event.kind)) {
          lastModifiedTime = Date.now();
        }
      }
    })();
  }

  return {
    async loadBuild(): Promise<ServerBuild> {
      const timestamp = Date.now();
      if (
        (mode === "production" || lastModifiedTime <= lastBuildTime) &&
        lastBuild
      ) {
        return lastBuild;
      }

      console.log("Loading build...");

      const [routes, checksum] = await Promise.all([
        loadRoutes(appDirectory),
        buildChecksum(appDirectory),
      ]);
      console.log("Build checksum:", checksum);
      const initializationTasks: Promise<unknown>[] = [];

      const routeModules = new Map<string, any>();
      const newBuild: ServerBuild = {
        entry: {
          module: await import(
            path.resolve(appDirectory, "entry.server.tsx") + "?ts=" + timestamp
          ),
        },
        routes: Object.values(routes).reduce((acc, route) => {
          let routeModule: any = undefined;
          let ensurePromise: Promise<unknown>;
          const ensureRouteModule = async () => {
            if (ensurePromise) return ensurePromise;
            if (typeof routeModule !== "undefined") return;
            routeModule = await import(route.file + "?ts=" + timestamp);
            routeModules.set(route.id, routeModule);
          };
          initializationTasks.push((ensurePromise = ensureRouteModule()));

          return {
            ...acc,
            [route.id]: {
              id: route.id,
              path: route.path,
              index: route.index,
              parentId: route.parentId,
              module: {
                action: async (...args) => {
                  await ensureRouteModule();
                  return routeModule.action?.(...args) || null;
                },
                loader: async (...args) => {
                  await ensureRouteModule();
                  return routeModule.loader?.(...args) || null;
                },
                get CatchBoundary() {
                  return routeModule.CatchBoundary;
                },
                get default() {
                  return routeModule.default;
                },
                get ErrorBoundary() {
                  return routeModule.ErrorBoundary;
                },
                get handle() {
                  return routeModule.handle;
                },
                get headers() {
                  return routeModule.headers;
                },
                get links() {
                  return routeModule.links;
                },
                get meta() {
                  return routeModule.meta;
                },
              },
            },
          } as ServerBuild["routes"];
        }, {} as ServerBuild["routes"]),
        publicPath: `/${checksum}/`,
        assetsBuildDirectory: "",
        assets: {
          entry: { imports: [], module: `/${checksum}/entry.client.js` },
          routes: Object.values(routes).reduce((acc, route) => {
            return {
              ...acc,
              [route.id]: {
                id: route.id,
                path: route.path,
                index: route.index,
                parentId: route.parentId,
                imports: [],
                module: `/${checksum}/${route.id}.js`,
                get hasAction() {
                  return !!routeModules.get(route.id).action;
                },
                get hasLoader() {
                  return !!routeModules.get(route.id).loader;
                },
                get hasCatchBoundary() {
                  return !!routeModules.get(route.id).CatchBoundary;
                },
                get hasErrorBoundary() {
                  return !!routeModules.get(route.id).ErrorBoundary;
                },
              },
            };
          }, {}),
          url: `/${checksum}/manifest.js`,
          version: checksum,
        },
      };

      await Promise.all(initializationTasks);

      if (timestamp > lastBuildTime) {
        lastBuildTime = timestamp;
        lastBuild = newBuild;
        lastBuildChecksum = checksum;
        lastRoutes = new Set(Object.values(routes).map((r) => r.file));
      }

      return newBuild;
    },
    async serveAssets(url: URL): Promise<Response | undefined> {
      if (!url.pathname.startsWith(`/${lastBuildChecksum}/`)) {
        return undefined;
      }
      const checksum = lastBuildChecksum!;

      const contentTypeHeader = contentType(
        url.pathname.split(".").slice(-1)[0]
      );
      if (assetsLRU.has(url.pathname)) {
        return new Response(assetsLRU.get(url.pathname), {
          headers: contentTypeHeader
            ? {
                "Content-Type": contentTypeHeader,
              }
            : undefined,
        });
      }

      const requestedFile = url.pathname.split("/").slice(2).join("/");

      if (url.pathname.endsWith(`/${checksum}/manifest.js`)) {
        return new Response(
          `window.__remixManifest=${JSON.stringify(lastBuild!.assets)};`,
          {
            headers: contentTypeHeader
              ? {
                  "Content-Type": contentTypeHeader,
                }
              : undefined,
          }
        );
      }

      console.log({ requestedFile });

      if (requestedFile.endsWith(".js")) {
        const requestedFileWithoutExt = requestedFile
          .split(".")
          .slice(0, -1)
          .join(".");
        const fileToBuild = await findFileWithExt(
          path.join(appDirectory, requestedFileWithoutExt),
          [".tsx", ".ts"]
        );

        console.log({ fileToBuild });

        if (fileToBuild) {
          const importMap = JSON.parse(
            await Deno.readTextFile(browserImportMapPath)
          );

          await ensureEsbuildInitialized();
          const buildResult = await esbuild.build({
            minify: mode === "production",
            treeShaking: true,
            logLevel: "silent",
            absWorkingDir: Deno.cwd(),
            entryPoints: {
              ...Object.entries(importMap.imports).reduce((acc, [id, src]) => {
                return {
                  ...acc,
                  [`dep_${id}`]: src,
                };
              }, {}),
              [requestedFileWithoutExt]: fileToBuild + "?route",
            },
            outdir: `/${checksum}`,
            write: false,
            bundle: true,
            splitting: true,
            format: "esm",
            publicPath: `/${checksum}/`,
            plugins: [
              {
                name: "exclude-deno",
                setup(build) {
                  build.onResolve({ filter: /.*/ }, (args) => {
                    if (
                      args.path === "@remix-run/deno" ||
                      args.resolveDir.match(/@remix-run\/deno/)
                    ) {
                      return {
                        path: args.path,
                        external: true,
                        sideEffects: false,
                      };
                    }
                  });
                },
              },
              {
                name: "browser-route-modules",
                setup(build) {
                  build.onResolve({ filter: /\?route$/ }, (args) => {
                    const file = args.path.replace(/\?route$/, "");
                    if (lastRoutes!.has(file)) {
                      return {
                        path: path.toFileUrl(args.path).href,
                        namespace: "browser-route-modules",
                        sideEffects: false,
                        pluginData: { file },
                      };
                    }
                    return undefined;
                  });
                  build.onLoad(
                    { filter: /.*/, namespace: "browser-route-modules" },
                    async (args) => {
                      const file = args.pluginData.file;
                      if (file) {
                        const result = await esbuild.build({
                          minify: mode === "production",
                          treeShaking: true,
                          logLevel: "silent",
                          entryPoints: {
                            route: file,
                          },
                          absWorkingDir: Deno.cwd(),
                          write: false,
                          outdir: `/${checksum}`,
                          bundle: true,
                          splitting: true,
                          format: "esm",
                          publicPath: `/${checksum}/`,
                          metafile: true,
                          plugins: [
                            {
                              name: "externals",
                              setup(build) {
                                build.onResolve({ filter: /.*/ }, (args) => {
                                  if (args.path !== file) {
                                    return {
                                      path: args.path,
                                      external: true,
                                    };
                                  }
                                  return undefined;
                                });
                              },
                            },
                          ],
                        });

                        const meta = Object.values(
                          result.metafile?.outputs || {}
                        )[0];

                        if (meta) {
                          const theExports = meta.exports.filter(
                            (ex) => !!browserSafeRouteExports[ex]
                          );

                          let contents = "module.exports = {};";
                          if (theExports.length !== 0) {
                            const spec = `{ ${theExports.join(", ")} }`;
                            contents = `export ${spec} from ${JSON.stringify(
                              file
                            )};`;
                          }

                          return {
                            contents,
                            resolveDir: appDirectory,
                            loader: "ts",
                          };
                        }
                      }
                      return undefined;
                    }
                  );
                },
              },
              denoPlugin({
                importMapURL: path.toFileUrl(browserImportMapPath),
              }) as any,
            ],
          });

          console.log("errors:", buildResult.errors);
          for (const output of buildResult.outputFiles) {
            assetsLRU.set(output.path, output.text);
          }
        }
      }

      const file = assetsLRU.get(url.pathname);
      if (file) {
        return new Response(file, {
          headers: contentTypeHeader
            ? {
                "Content-Type": contentTypeHeader,
              }
            : undefined,
        });
      }

      return undefined;
    },
  };
}

async function loadRoutes(appDirectory: string) {
  const routes: Record<
    string,
    {
      id: string;
      parentId?: string;
      file: string;
      path?: string;
      index?: boolean;
    }
  > = {
    root: {
      id: "root",
      file: path.resolve(appDirectory, "root.tsx"),
    },
  };

  try {
    const routesDir = path.resolve(appDirectory, "routes");
    let entries: {
      id: string;
      index?: boolean;
      path?: string;
      file: string;
    }[] = [];
    for await (const entry of fs.walk(routesDir)) {
      if (
        !entry.isFile ||
        !(entry.path.endsWith(".ts") || entry.path.endsWith(".tsx"))
      ) {
        continue;
      }

      const relativePath = path.relative(routesDir, entry.path);
      const normalizedSystemSlashes = relativePath.replace(/\\/g, "/");
      const withoutExtension = normalizedSystemSlashes.replace(/\.tsx?$/, "");
      const withSlashes = withoutExtension.replace(/\./g, "/");
      const index =
        withoutExtension === "index" || withSlashes.endsWith("/index");
      const withoutIndex = index
        ? withSlashes.replace(/\/?index$/, "")
        : withSlashes;
      const withSlugs = withoutIndex.replace(/\$/g, ":");

      entries.push({
        id: "routes/" + withoutExtension,
        index,
        path: withSlugs,
        file: entry.path,
      });
    }
    entries = entries.sort((a, b) => a.id.localeCompare(b.id));

    const findParentId = (id: string) => {
      if (id === "root") return undefined;

      let foundId: string | undefined = undefined;
      for (const entry of entries) {
        if (entry.id === id) continue;
        if (id.startsWith(entry.id)) {
          foundId = entry.id;
        }
      }
      return foundId || "root";
    };

    for (const entry of entries) {
      routes[entry.id] = {
        ...entry,
        parentId: findParentId(entry.id),
      };
    }
  } catch {
    // do nothing
  }

  return routes;
}

async function buildChecksum(appDirectory: string) {
  const hash = createHash("md5");

  for await (const entry of fs.walk(appDirectory)) {
    if (!entry.isFile) {
      continue;
    }
    const file = await Deno.open(entry.path);
    for await (const chunk of Deno.iter(file)) {
      hash.update(chunk);
    }
  }

  return hash.toString();
}

async function findFileWithExt(baseName: string, exts: string[]) {
  for (const ext of exts) {
    const fileName = baseName + ext;
    try {
      const stat = await Deno.stat(fileName);
      if (stat.isFile) {
        return fileName;
      }
    } catch {}
  }
  return undefined;
}

const browserSafeRouteExports: { [name: string]: boolean } = {
  CatchBoundary: true,
  ErrorBoundary: true,
  default: true,
  handle: true,
  links: true,
  meta: true,
  unstable_shouldReload: true,
};
