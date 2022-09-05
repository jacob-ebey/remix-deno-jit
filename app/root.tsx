import * as React from "react";
import { type MetaFunction } from "@remix-run/deno";
import {
  Links,
  LiveReload,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";

import JSConfetti from "js-confetti";

export const meta: MetaFunction = () => ({
  title: "Remix",
  description: "Welcome to Remix on Deno!",
});

export default function App() {
  React.useEffect(() => {
    const jsConfetti = new JSConfetti();
    jsConfetti.addConfetti();
  }, []);

  return (
    <html lang="en">
      <head>
        <Meta />
        <Links />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
        <LiveReload port={Number(window.location.port)} />
      </body>
    </html>
  );
}
