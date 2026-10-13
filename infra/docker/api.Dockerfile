# syntax=docker/dockerfile:1.7
# Udofin API image. Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t udofin-api .
# Runs as a non-root user; contains only compiled JavaScript and production dependencies.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Manifests first so dependency installation is cached independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.base.json ./
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/ops-portal/package.json apps/ops-portal/package.json
COPY apps/lender-portal/package.json apps/lender-portal/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY services/api/package.json services/api/package.json
RUN pnpm install --frozen-lockfile --filter "@udofin/api..."
COPY packages ./packages
COPY services/api ./services/api
RUN pnpm --filter "@udofin/api..." build \
 && pnpm --filter @udofin/api deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Owned by root and not writable by the runtime user: a compromised process cannot alter its own code.
COPY --from=build /out ./
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
