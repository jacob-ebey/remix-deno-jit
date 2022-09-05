import * as fs from "https://deno.land/std@0.154.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.154.0/path/mod.ts";
import { iterateReader } from "https://deno.land/std@0.154.0/streams/conversion.ts";
import { contentType } from "https://deno.land/std@0.154.0/media_types/mod.ts";
import { createHash } from "https://deno.land/std@0.154.0/hash/mod.ts";
import { LRU } from "https://deno.land/x/lru@1.0.2/mod.ts";
import { denoPlugin } from "https://deno.land/x/remix_esbuild_deno_loader@0.5.2/mod.ts";

import {
  type ServerBuild,
  createRequestHandler as createRemixRequestHandler,
} from "@remix-run/deno";

// -- esbuild --
// @deno-types="https://deno.land/x/esbuild@v0.15.7/mod.d.ts"
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
        wasmURL: "https://esm.sh/esbuild-wasm@0.15.7/esbuild.wasm",
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

interface CommonOptions<Context> {
  port?: number;
  browserImportMapPath: string;
  appDirectory?: string;
  staticDirectory?: string;
  generatedFile?: string;
  manifest?: any;
  getLoadContext?: (request: Request) => Promise<Context>;
}

interface CreateRequestHandlerArgs<Context> extends CommonOptions<Context> {
  generatedFile?: string;
  mode?: "production" | "development";
  emitDevEvent?: (event: unknown) => void;
}

export function createRequestHandler<Context = unknown>({
  appDirectory = path.resolve(Deno.cwd(), "app"),
  generatedFile = path.resolve(Deno.cwd(), "remix.gen.ts"),
  browserImportMapPath,
  staticDirectory = path.resolve(Deno.cwd(), "public"),
  manifest,
  mode = "production",
  getLoadContext,
  emitDevEvent,
}: CreateRequestHandlerArgs<Context>) {
  appDirectory = path.resolve(appDirectory);
  staticDirectory = path.resolve(staticDirectory);
  generatedFile = path.resolve(generatedFile);

  const runtime = createRuntime({
    appDirectory,
    manifest,
    generatedFile,
    browserImportMapPath,
    mode,
    emitDevEvent,
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
                "Cache-Control": "public, max-age=31536000, immutable",
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
  generatedFile,
  browserImportMapPath,
  mode,
  manifest,
  emitDevEvent,
}: {
  appDirectory: string;
  browserImportMapPath: string;
  mode: "production" | "development";
  generatedFile?: string;
  manifest?: any;
  emitDevEvent?: (event: unknown) => void;
}) {
  appDirectory = path.resolve(appDirectory);
  generatedFile = generatedFile ? path.resolve(generatedFile) : undefined;
  const assetsLRU = new LRU<string>(500);

  let lastBuildChecksum: string | undefined;
  let lastBuild: ServerBuild | undefined;
  let lastBuildTime = 0;
  let lastClientBuildTime = 0;
  let lastModifiedTime = 0;
  let lastRoutes: Map<string, string> | undefined;
  let compilationPromise: Promise<
    esbuildWasm.BuildResult & {
      outputFiles: esbuildWasm.OutputFile[];
    }
  >;

  if (mode === "development") {
    (async () => {
      const watcher = Deno.watchFs(appDirectory, {
        recursive: true,
      });
      for await (const event of watcher) {
        if (["create", "modify", "remove"].includes(event.kind)) {
          lastModifiedTime = Date.now();
          if (emitDevEvent) emitDevEvent({ type: "RELOAD" });
        }
      }
    })();
  }

  const loadBuild = async (): Promise<ServerBuild> => {
    const timestamp = Date.now();
    if (
      (mode === "production" || lastModifiedTime <= lastBuildTime) &&
      lastBuild
    ) {
      return lastBuild;
    }

    if (mode === "production") {
      const newBuild = manifest || (await import(generatedFile!));
      lastBuildTime = timestamp;
      lastBuild = newBuild;
      lastBuildChecksum = newBuild.assets.version;
      lastRoutes = new Map(
        Object.values(
          newBuild.routes as Record<string, { file: string; id: string }>
        ).map((r) => [path.resolve(path.dirname(generatedFile!), r.file), r.id])
      );
      return newBuild;
    }

    const [routes, checksum] = await Promise.all([
      loadRoutes(appDirectory),
      buildChecksum(appDirectory),
    ]);

    await writeGeneratedFile({
      appDirectory,
      generatedFile: generatedFile!,
      routes,
      checksum,
    });

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
      lastRoutes = new Map(Object.values(routes).map((r) => [r.file, r.id]));
    }

    return newBuild;
  };

  return {
    loadBuild,
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
                "Cache-Control": "public, max-age=31536000, immutable",
              }
            : undefined,
        });
      }

      if (url.pathname.endsWith(`/${checksum}/manifest.js`)) {
        return new Response(
          `window.__remixManifest=${JSON.stringify(lastBuild!.assets)};`,
          {
            headers: contentTypeHeader
              ? {
                  "Content-Type": contentTypeHeader,
                  "Cache-Control": "public, max-age=31536000, immutable",
                }
              : undefined,
          }
        );
      }

      const getPlugins = () => {
        const browserRouteModulesPlugin = {
          name: "browser-route-modules",
          setup(build: esbuildWasm.PluginBuild) {
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
                  await ensureEsbuildInitialized();
                  const result = await esbuild.build({
                    absWorkingDir: Deno.cwd(),
                    minify: mode === "production",
                    treeShaking: true,
                    logLevel: "silent",
                    entryPoints: {
                      route: file,
                    },
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

                  const meta = Object.values(result.metafile?.outputs || {})[0];

                  if (meta) {
                    const theExports = meta.exports.filter(
                      (ex) => !!browserSafeRouteExports[ex]
                    );

                    let contents = "module.exports = {};";
                    if (theExports.length !== 0) {
                      const spec = `{ ${theExports.join(", ")} }`;
                      contents = `export ${spec} from ${JSON.stringify(file)};`;
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
        };

        return [
          {
            name: "remix-env",
            setup(build: esbuildWasm.PluginBuild) {
              build.onResolve({ filter: /.*/ }, (args) => {
                if (
                  args.path.startsWith("https://deno.land/std") &&
                  args.path.endsWith("/node/process.ts")
                ) {
                  return {
                    path: args.path,
                    sideEffects: false,
                    namespace: "remix-env",
                  };
                }
              });
              build.onLoad({ filter: /.*/, namespace: "remix-env" }, (args) => {
                return {
                  contents: `export default { env: ${JSON.stringify({
                    REMIX_DEV_SERVER_WS_PORT: window.location?.port || null,
                  })} };`,
                };
              });
            },
          },
          {
            name: "exclude-deno",
            setup(build: esbuildWasm.PluginBuild) {
              build.onResolve({ filter: /.*/ }, (args) => {
                if (
                  args.path === "@remix-run/deno" ||
                  args.resolveDir.match(/@remix-run\/deno/) ||
                  args.path.startsWith("https://deno.land/std")
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
          browserRouteModulesPlugin,
          denoPlugin({
            importMapURL: path.toFileUrl(browserImportMapPath),
          }) as any,
        ];
      };

      if (!compilationPromise || lastModifiedTime > lastClientBuildTime) {
        lastClientBuildTime = Date.now();
        const getEntryPoints = async () => {
          const entry = await findFileWithExt(
            path.resolve(appDirectory, "entry.client"),
            [".tsx", ".ts"]
          );
          const entryPoints: Record<string, string> = entry
            ? {
                "entry.client": entry,
              }
            : {};
          return { entry, entryPoints };
        };

        console.time(`${checksum} built in`);
        compilationPromise = Promise.all([
          getEntryPoints(),
          ensureEsbuildInitialized(),
        ]).then(([{ entry, entryPoints }]) =>
          esbuild.build({
            absWorkingDir: Deno.cwd(),
            entryPoints: {
              ...entryPoints,
              ...[...lastRoutes!.entries()].reduce(
                (acc, [file, routeId]) => ({
                  ...acc,
                  [routeId]: file + "?route",
                }),
                {}
              ),
            },
            minify: true,
            treeShaking: true,
            outdir: `/${checksum}`,
            write: false,
            bundle: true,
            splitting: true,
            format: "esm",
            publicPath: `/${checksum}/`,
            logLevel: "silent",
            plugins: getPlugins(),
            metafile: true,
          })
        );

        const buildResult = await compilationPromise;
        console.timeEnd(`${checksum} built in`);
        for (const output of buildResult.outputFiles) {
          assetsLRU.set(output.path, output.text);
        }
      }

      await compilationPromise;

      const file = assetsLRU.get(url.pathname);
      if (file) {
        return new Response(file, {
          headers: contentTypeHeader
            ? {
                "Content-Type": contentTypeHeader,
                "Cache-Control": "public, max-age=31536000, immutable",
              }
            : undefined,
        });
      }

      return undefined;
    },
  };
}

export async function loadRoutes(appDirectory: string) {
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
      const fullPath = withSlugs
        .split("/")
        .map((segment) => segment.replace(/_$/, ""))
        .join("/");

      entries.push({
        id: "routes/" + withoutExtension.replace(/\./g, "/"),
        index,
        path: fullPath,
        file: entry.path,
      });
    }
    entries = entries.sort((a, b) => b.file.length - a.file.length);

    const findParentId = (id: string) => {
      if (id === "root") return undefined;

      let foundId: string | undefined = undefined;
      for (const entry of entries) {
        if (entry.id === id) continue;
        if (id.startsWith(entry.id + "/")) {
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

  function cleanUpPath(route: { parentId?: string; path?: string }) {
    if (route.parentId && route.path && routes[route.parentId].path) {
      route.path = route.path
        .slice(-routes[route.parentId].path!.length)
        .replace(/^\//, "")
        .replace(/\/$/, "");
    }
  }

  for (const route of Object.values(routes)) {
    cleanUpPath(route);
  }

  return routes;
}

export async function buildChecksum(appDirectory: string) {
  const hash = createHash("md5");

  for await (const entry of fs.walk(appDirectory)) {
    if (!entry.isFile) {
      continue;
    }
    const file = await Deno.open(entry.path);
    for await (const chunk of iterateReader(file)) {
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

export async function writeGeneratedFile({
  generatedFile,
  appDirectory,
  routes,
  checksum,
}: {
  generatedFile: string;
  appDirectory: string;
  routes: Record<
    string,
    {
      id: string;
      parentId?: string | undefined;
      file: string;
      path?: string | undefined;
      index?: boolean | undefined;
    }
  >;
  checksum: string;
}) {
  const serverEntry =
    "./" +
    path
      .relative(
        path.dirname(generatedFile),
        path.resolve(appDirectory, "entry.server.tsx")
      )
      .replace(/\\/g, "/");

  const routeImports = Object.values(routes)
    .map(
      (route, index) =>
        `import * as route${index} from ${JSON.stringify(
          "./" +
            path
              .relative(path.dirname(generatedFile), route.file)
              .replace(/\\/g, "/")
        )};`
    )
    .join("\n");

  const routesObject =
    "{\n" +
    Object.values(routes)
      .map(
        (route, index) =>
          `\t${JSON.stringify(route.id)}: {\n` +
          `\t\tid: ${JSON.stringify(route.id)},\n` +
          (route.path ? `\t\tpath: ${JSON.stringify(route.path)},\n` : "") +
          (route.index ? `\t\tindex: ${JSON.stringify(route.index)},\n` : "") +
          (route.parentId
            ? `\t\tparentId: ${JSON.stringify(route.parentId)},\n`
            : "") +
          `\t\tmodule: route${index},\n` +
          `\t\tfile: ${JSON.stringify(
            "./" +
              path
                .relative(path.dirname(generatedFile), route.file)
                .replace(/\\/g, "/")
          )},\n` +
          "\t},"
      )
      .join("\n") +
    "\n}";

  const assetRoutes =
    "{\n" +
    Object.values(routes)
      .map(
        (route, index) =>
          `\t\t${JSON.stringify(route.id)}: {\n` +
          `\t\t\tid: ${JSON.stringify(route.id)},\n` +
          (route.path ? `\t\t\tpath: ${JSON.stringify(route.path)},\n` : "") +
          (route.index
            ? `\t\t\tindex: ${JSON.stringify(route.index)},\n`
            : "") +
          (route.parentId
            ? `\t\t\tparentId: ${JSON.stringify(route.parentId)},\n`
            : "") +
          `\t\t\timports: [],\n` +
          `\t\t\tmodule: ${JSON.stringify(`/${checksum}/${route.id}.js`)},\n` +
          `\t\t\thasAction: "action" in route${index},\n` +
          `\t\t\thasLoader: "loader" in route${index},\n` +
          `\t\t\thasCatchBoundary: "CatchBoundary" in route${index},\n` +
          `\t\t\thasErrorBoundary: "ErrorBoundary" in route${index},\n` +
          "\t\t},"
      )
      .join("\n\t") +
    "\t\t\n}";

  // TODO: Remove checksum from manifest
  await Deno.writeTextFile(
    generatedFile,
    `// DO NOT EDIT. This file is generated by remix-deno-jit.
// This file SHOULD be checked into source version control.
// This file is automatically updated during development when running \`deno task dev\`.

import * as serverEntry from ${JSON.stringify(serverEntry)};
${routeImports}

export const assetsBuildDirectory = "";
export const publicPath = ${JSON.stringify(`/${checksum}/`)};
export const entry = { module: serverEntry };
export const routes = ${routesObject};
export const assets = {
  url: ${JSON.stringify(`/${checksum}/manifest.js`)},
  version: ${JSON.stringify(checksum)},
  entry: { imports: [], module: ${JSON.stringify(
    `/${checksum}/entry.client.js`
  )} },
  routes: ${assetRoutes},
};
`
  );
}

let defaultPort = Number(Deno.env.get("PORT"));
defaultPort = Number.isSafeInteger(defaultPort) ? defaultPort : 8080;

export async function dev<Context>({
  generatedFile = Deno.cwd() + "/remix.gen.ts",
  port = defaultPort,
  ...options
}: CommonOptions<Context>) {
  const mode = "development";
  window.location = { port: port.toString() } as Window["location"];

  const sockets = new Set<WebSocket>();

  const handler = createRequestHandler({
    ...options,
    mode,
    generatedFile,
    emitDevEvent: (event) => {
      for (const socket of sockets) {
        socket.send(JSON.stringify(event));
      }
    },
  });

  const server = Deno.listen({ port });
  console.log(`Listening on http://localhost:${port}`);

  for await (const conn of server) {
    (async () => {
      const httpConn = Deno.serveHttp(conn);
      for await (const requestEvent of httpConn) {
        const url = new URL(requestEvent.request.url);
        if (mode === "development" && url.pathname === "/socket") {
          const { socket, response } = Deno.upgradeWebSocket(
            requestEvent.request
          );
          sockets.add(socket);
          socket.onclose = () => {
            sockets.delete(socket);
          };
          socket.onerror = () => {
            sockets.delete(socket);
          };
          return await requestEvent.respondWith(response).catch(() => {});
        }

        try {
          const response = await handler(requestEvent.request);
          requestEvent.respondWith(response).catch(() => {});
        } catch (error) {
          console.error(error);
          requestEvent
            .respondWith(
              new Response(error.message, {
                status: 500,
              })
            )
            .catch(() => {});
        }
      }
    })();
  }
}

export async function start<Context>({
  generatedFile = Deno.cwd() + "/remix.gen.ts",
  port = defaultPort,
  ...options
}: CommonOptions<Context>) {
  const mode = "production";
  window.location = { port: port.toString() } as Window["location"];

  const handler = createRequestHandler({
    ...options,
    mode,
    generatedFile,
  });

  const server = Deno.listen({ port });
  console.log(`Listening on http://localhost:${port}`);

  for await (const conn of server) {
    (async () => {
      const httpConn = Deno.serveHttp(conn);
      for await (const requestEvent of httpConn) {
        try {
          const response = await handler(requestEvent.request);
          requestEvent.respondWith(response).catch(() => {});
        } catch (error) {
          console.error(error);
          requestEvent
            .respondWith(
              new Response(error.message, {
                status: 500,
              })
            )
            .catch(() => {});
        }
      }
    })();
  }
}
