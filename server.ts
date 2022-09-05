import { createRequestHandler } from "./runtime.ts";

// deno-lint-ignore no-constant-condition
const mode = typeof Deno.env.get("DENO_DEPLOYMENT_ID")
  ? "production"
  : "development";

const handler = createRequestHandler({
  mode,
  appDirectory: Deno.cwd() + "/app",
  staticDirectory: Deno.cwd() + "/public",
  browserImportMapPath: Deno.cwd() + "/import_map.json",
});

let port = Number(Deno.env.get("PORT"));
port = Number.isSafeInteger(port) ? port : 8080;

const server = Deno.listen({ port });
console.log(`Listening on http://localhost:${port}`);

for await (const conn of server) {
  (async () => {
    const httpConn = Deno.serveHttp(conn);
    for await (const requestEvent of httpConn) {
      try {
        const response = await handler(requestEvent.request);
        await requestEvent.respondWith(response);
      } catch (error) {
        console.error(error);
        await requestEvent.respondWith(
          new Response(error.message, {
            status: 500,
          })
        );
      }
    }
  })();
}
