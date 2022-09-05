import * as React from "react";
import { type MetaFunction } from "@remix-run/deno";
import {
  Links,
  // LiveReload,
  Meta,
  Outlet,
  Scripts,
  // ScrollRestoration,
} from "@remix-run/react";

export const meta: MetaFunction = () => ({
  title: "Remix",
  description: "Welcome to Remix on Deno!",
});

export default function App() {
  return (
    <html lang="en">
      <head>
        <Meta />
        <Links />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
      </head>
      <body>
        <Outlet />
        {/* <ScrollRestoration /> */}
        <Scripts />
        {/* <LiveReload /> */}
      </body>
    </html>
  );
}
