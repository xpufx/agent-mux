import { executeProvider } from "../../core/runner.js";

async function main() {
  const code = await executeProvider("antigravity", process.argv.slice(2));
  process.exit(code);
}

main().catch((err) => {
  console.error("[agy error]", err.message);
  process.exit(1);
});
