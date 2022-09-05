import { start } from "./runtime.ts";

import * as manifest from "./remix.gen.ts";

start({
  manifest,
  browserImportMapPath: Deno.cwd() + "/import_map.json",
});
