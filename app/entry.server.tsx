import * as ReactDOM from "react-dom/server";

import { type EntryContext } from "@remix-run/deno";
import { RemixServer } from "@remix-run/react";

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  const markup = ReactDOM.renderToString(
    <RemixServer context={remixContext} url={request.url} />
  );

  const headers = new Headers(responseHeaders);
  headers.set("Content-Type", "text/html");

  return new Response(`<!DOCTYPE html>${markup}`, {
    status: responseStatusCode,
    headers,
  });
}
