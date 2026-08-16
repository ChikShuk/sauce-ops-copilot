# One image, three commands. The app, the worker and the one-shot migration
# step are the same build with different CMDs — separate images would triple
# the build for no isolation this project needs.
#
# Node 24 rather than 22, and the reason is the lockfile rather than a language
# feature. `tsx` wants esbuild ~0.28 and `drizzle-kit` wants ^0.25, and npm 10
# (bundled with node:22) resolves that conflict into a different tree than the
# npm 11 that wrote package-lock.json — so `npm ci` failed with "Missing:
# esbuild@0.28.2 from lock file" against a lockfile that was perfectly valid.
# Matching the image's Node major to the one used for development means the
# lockfile is read the same way in both places.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Full install, dev dependencies included: `next build` and `tsc` are both
# build-time tools and neither survives into the runtime stage.
RUN npm ci


FROM deps AS build
WORKDIR /app
COPY . .
# A placeholder, and nothing ever dials it. src/lib/env.ts parses process.env at
# module load, and `next build` imports every route module to collect page data
# — so the build fails on "Invalid environment: DATABASE_URL is not set" without
# a value here, even though no page is prerendered. Confirmed by building
# without it: "Failed to collect page data for /api/settings/provider".
# postgres.js connects lazily, so this string is never resolved or contacted.
# The real value arrives from compose at runtime.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
# `next build` and `tsc -p tsconfig.worker.json` (see package.json), plus the
# migration .sql files copied beside the compiled migrate.js.
RUN npm run build


FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./next.config.ts
# Carries dist/lib/db/migrations with it — migrate.js resolves that folder
# relative to its own location, so the two must stay adjacent.
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000

# Overridden per service in docker-compose.yml. Exec form throughout, and
# deliberately not `npm run start`: npm spawns a child shell and forwards
# signals unreliably, which would put a wrapper in PID 1. The worker's SIGTERM
# handler only fires if the signal reaches the node process holding it.
CMD ["node", "node_modules/next/dist/bin/next", "start"]
