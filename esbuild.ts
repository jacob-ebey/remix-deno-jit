// -- esbuild --
// @deno-types="https://deno.land/x/esbuild@v0.15.7/mod.d.ts"
import esbuildWasm from "https://esm.sh/esbuild-wasm@0.15.7/lib/browser.js?pin=v86&target=deno";
import * as esbuildNative from "https://deno.land/x/esbuild@v0.15.7/mod.js";

export type { esbuildWasm };

// @ts-ignore trust me
export const esbuild: typeof esbuildWasm =
  Deno.run === undefined ? esbuildWasm : esbuildNative;

let esbuildInitialized: boolean | Promise<void> = false;
export async function ensureEsbuildInitialized() {
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
