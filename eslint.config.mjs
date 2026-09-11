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
    // sdk/typescript is its own separate TS project (own tsconfig.json,
    // own package.json `build`/`generate` scripts, own target/module
    // settings) — its generated client code isn't written against this
    // app's lint rules and was never meant to be. sdk/typescript/
    // node_modules is already covered by eslint's own default node_
    // modules ignore; this adds the rest of sdk/ (source + config files)
    // on top, matching backend/'s own root tsconfig.json exclude.
    "sdk/**",
  ]),
]);

export default eslintConfig;
