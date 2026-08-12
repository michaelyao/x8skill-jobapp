import { loadEnv } from "./utils/env.js";
import { run } from "./core/runner.js";

loadEnv();

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

