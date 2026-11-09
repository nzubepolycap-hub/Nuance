import { defineConfig, devices } from "@playwright/test";
import path from "path";
import os from "os";
import { BACKEND_PORT, FRONTEND_PORT } from "./e2e/ports";

// ROADMAP.md Part 3 5.3's E2E row: "Full escrow lifecycle: connect a
// mocked injected wallet -> create escrow -> submit deliverable -> watch
// consensus resolve -> release funds." Both servers below are the real
// app, not mocks — only the wallet (e2e/mock-wallet.ts) and the LLM
// providers (unset keys -> services/consensus.py's deterministic offline
// heuristic, see e2e/escrow-lifecycle.spec.ts's own docstring) are stood
// in for. A fresh SQLite file per run (E2E_DB_DIR below) keeps this
// completely isolated from both the real dev db and any other e2e run —
// no cleanup step needed, no shared state between runs.
const E2E_DB_DIR = path.join(os.tmpdir(), `nuance-e2e-${Date.now()}`);
// Neither is the project's usual dev port (backend 8010, frontend 3000) —
// this run must never collide with (or need to kill) a dev server you
// already have up, confirmed a real concern: this repo's own backend
// dev server was found live on :8010 while writing this config.
// BACKEND_PORT/FRONTEND_PORT themselves now live in ./e2e/ports.ts —
// shared with any spec that needs to reach the backend directly (see
// that file's own comment for why).

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // "chrome" (the system-installed Google Chrome binary), not
      // Playwright's own bundled Chromium — this sandbox's egress
      // allowlist blocks cdn.playwright.dev (confirmed: `playwright
      // install chromium` times out), but a real Chrome is already
      // present at /usr/bin/google-chrome. Same devices["Desktop
      // Chrome"] viewport/UA profile either way.
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: [
    {
      command: `mkdir -p ${E2E_DB_DIR} && .venv/bin/uvicorn app.main:app --port ${BACKEND_PORT}`,
      cwd: path.join(__dirname, "backend"),
      port: BACKEND_PORT,
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        // A dedicated file, not backend/nuance.db — this run's data never
        // touches real dev/test state and needs no teardown.
        DATABASE_URL: `sqlite+aiosqlite:///${E2E_DB_DIR}/e2e.db`,
        JWT_SECRET: "e2e-test-secret-not-for-production-use-only-32b+",
        // app/config.py's default is localhost:3000 — this run's frontend
        // is deliberately on FRONTEND_PORT instead (see that const's own
        // comment), which a real browser's CORS check rejects otherwise
        // (confirmed live: the wallet-connect POST /auth/nonce failed
        // with a bare "Failed to fetch" — no CORS preflight response —
        // before this was added).
        CORS_ORIGINS: `http://localhost:${FRONTEND_PORT}`,
        // Explicitly BLANKED, not just omitted — app/config.py's
        // Settings loads `env_file=".env"` relative to cwd (backend/),
        // so simply not mentioning these here still let backend/.env's
        // own real keys through (confirmed live: this run's first pass,
        // before these three lines existed, made a real billed Anthropic
        // call that failed on a low credit balance — see this repo's own
        // git history for that finding). A real OS env var takes
        // precedence over the .env file in pydantic-settings, which is
        // what actually blocks it here. With these unset, services/
        // consensus.py's deterministic offline heuristic fallback judges
        // every submission instead — real, fast (~1.5s, see MIN_
        // DELIBERATION_SECONDS), no network call, no billed usage, and
        // reproducible from the submission text alone. See
        // e2e/escrow-lifecycle.spec.ts for the exact wording this relies
        // on to guarantee an APPROVE verdict.
        GEMINI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        ENABLE_CHAIN_INDEXER: "false",
        AUTO_DEPLOY_ESCROW_CONTRACTS: "false",
        AUTO_DEPLOY_PREDICTION_CONTRACTS: "false",
      },
    },
    {
      // `next build` + `next start`, not `next dev` — this Next.js
      // version (see node_modules/next/dist/docs/01-app/03-api-reference/
      // 06-cli/next.md's own "Good to know") only allows ONE `next dev`
      // per project directory at a time (a real dev server was already
      // running here while writing this config, and a second `next dev`
      // on a different port still refused to start, citing that lock).
      // `next build`/`next start` write to `.next` while `next dev`
      // writes to the separate `.next/dev` — the docs note those two are
      // deliberately kept apart specifically so dev and build can run
      // concurrently, which is exactly what this needs. NEXT_PUBLIC_API_URL
      // has to be set at build time (Next.js inlines NEXT_PUBLIC_* at
      // build, not runtime), so it's part of this same command.
      command:
        `NEXT_PUBLIC_API_URL=http://localhost:${BACKEND_PORT} npx next build && ` +
        `npx next start --port ${FRONTEND_PORT}`,
      cwd: __dirname,
      port: FRONTEND_PORT,
      timeout: 180_000,
      reuseExistingServer: false,
    },
  ],
});
