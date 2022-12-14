import { type LinksFunction, type MetaFunction } from "@remix-run/deno";
import {
  Links,
  LiveReload,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";

import { asset, css } from "../assets.ts";

const globalStyles = asset("/global.css", css);

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: globalStyles.href },
];

export const meta: MetaFunction = () => ({
  title: "Remix",
  description: "Welcome to Remix on Deno!",
  viewport: "width=device-width, initial-scale=1",
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
        <ScrollRestoration />
        <Scripts />
        <LiveReload port={Number(window.location.port)} />
      </body>
    </html>
  );
}
