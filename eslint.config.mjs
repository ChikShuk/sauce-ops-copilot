import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Compiled worker + migrate output (tsconfig.worker.json). Emitted
    // CommonJS, so linting it is 100+ no-require-imports errors about code
    // nobody wrote.
    "dist/**",
  ]),
]);

export default eslintConfig;
