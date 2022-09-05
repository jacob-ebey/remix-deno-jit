import { dev } from "./runtime.ts";

dev({
  browserImportMapPath: Deno.cwd() + "/import_map_dev.json",
});
