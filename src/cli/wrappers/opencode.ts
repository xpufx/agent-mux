import { executeProvider } from "../../core/runner.js";

async function main() {
  const code = await executeProvider("opencode", process.argv.slice(2));
  process.exit(code);
}

main().catch((err) => {
  console.error("[opencode error]", err.message);
  process.exit(1);
});
