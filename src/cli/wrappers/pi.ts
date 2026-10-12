import { executeProvider } from "../../core/runner.js";

async function main() {
  const code = await executeProvider("pi", process.argv.slice(2));
  process.exit(code);
}

main().catch((err) => {
  console.error("[pi error]", err.message);
  process.exit(1);
});
