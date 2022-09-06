import { hydrate } from "react-dom";
import { RemixBrowser } from "@remix-run/react";

if (process.env.NODE_ENV === "development") {
  import(
    "https://esm.sh/stable/preact@10.10.6/deno/devtools.development.js"
  ).then(start);
} else {
  start();
}

function start() {
  const documentElement = document.documentElement;
  const apply = (n: HTMLElement) => document.replaceChild(n, documentElement);
  // Temp fix
  hydrate(<RemixBrowser />, {
    childNodes: [documentElement],
    firstChild: documentElement,
    insertBefore: apply,
    appendChild: apply,
  });
}
