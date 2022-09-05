import { parse } from "https://deno.land/std@0.154.0/flags/mod.ts";
import * as path from "https://deno.land/std@0.154.0/path/mod.ts";

import { buildChecksum, loadRoutes, writeGeneratedFile } from "./runtime.ts";

const parsedArgs = parse(Deno.args);

if (parsedArgs.help || parsedArgs.h) {
  console.log(`Usage: deno run --allow-read --allow-write https://deno.land/x/remix-deno-jit/cli.ts [options] [command]

Options:
  -h, --help     display help
  --app-dir      path to the app directory (defaults to ./app)
  --output       path to the the generated output file (defaults to ./remix.gen.ts)

Commands:
  prepare        run a deploy script to prepare your app for deployment for environments that don't support dynamic imports`);
  Deno.exit(0);
}

const command = Deno.args.slice(-1)[0];

switch (command) {
  case "prepare": {
    const appDirectory = path.resolve(parsedArgs["app-dir"] || "./app");
    const generatedFile = path.resolve(parsedArgs.output || "./remix.gen.ts");

    const [routes, checksum] = await Promise.all([
      loadRoutes(appDirectory),
      buildChecksum(appDirectory),
    ]);

    await writeGeneratedFile({ appDirectory, generatedFile, routes, checksum });

    break;
  }
  default: {
    if (!command) {
      console.error("No command provided");
    } else {
      console.error(`Unknown command: ${command}`);
    }
    break;
  }
}
