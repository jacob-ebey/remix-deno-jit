import { createRequestHandler } from "./runtime.ts";

const mode =
  Deno.env.get("DENO_DEPLOYMENT_ID") || Deno.env.get("RAILWAY_ENVIRONMENT")
    ? "production"
    : "development";
// const mode = "production";

const sockets = new Set<WebSocket>();

const handler = createRequestHandler({
  mode,
  generatedFile: Deno.cwd() + "/remix.gen.ts",
  appDirectory: Deno.cwd() + "/app",
  staticDirectory: Deno.cwd() + "/public",
  browserImportMapPath:
    mode === "development"
      ? Deno.cwd() + "/import_map_dev.json"
      : Deno.cwd() + "/import_map.json",
  emitDevEvent:
    mode !== "development"
      ? undefined
      : (event) => {
          for (const socket of sockets) {
            socket.send(JSON.stringify(event));
          }
        },
});

let port = Number(Deno.env.get("PORT"));
port = Number.isSafeInteger(port) ? port : 8080;
window.location = { port: port.toString() } as any;

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
        socket.onerror = (e) => {
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
