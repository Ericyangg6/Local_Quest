import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";

// All local settings live in the project's single .env (local-quest/.env, template
// ../.env.example), shared with the Snowflake scripts. Variables already set to a value in the
// real environment win, so hosts like Vercel (which have no such file) are unaffected. Empty
// values (e.g. `AUTH_SECRET=` in a leftover web/.env.local) are filled from this file.
const projectEnv = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(projectEnv)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(projectEnv, "utf8")))) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const nextConfig: NextConfig = {
  // web/ is its own package; pin the workspace root so lockfiles in parent folders aren't picked up.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  // Native password-hashing module; load it from node_modules at runtime instead of bundling.
  serverExternalPackages: ["@node-rs/argon2"],
  poweredByHeader: false,
  experimental: {
    // Profile pictures are uploaded through a server action (2 MB file limit plus form overhead).
    serverActions: { bodySizeLimit: "3mb" },
  },
  // The Explore page was removed; the quest board is the signed-in home page.
  async redirects() {
    return [{ source: "/explore", destination: "/quests", permanent: false }];
  },
  images: {
    // Google account profile photos.
    remotePatterns: [{ protocol: "https", hostname: "*.googleusercontent.com", pathname: "/**" }],
  },
};

export default nextConfig;
