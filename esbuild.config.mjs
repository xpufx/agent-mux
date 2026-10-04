import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: {
    cli: "src/cli/index.ts",
    "wrappers/agy": "src/cli/wrappers/agy.ts",
    "wrappers/opencode": "src/cli/wrappers/opencode.ts",
    index: "src/index.ts"
  },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'module'; const require = createRequire(import.meta.url);"
  },
  sourcemap: true
});

console.log("Build complete.");
