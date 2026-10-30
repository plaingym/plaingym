# SPDX-License-Identifier: AGPL-3.0-only
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${NODE_IMAGE} AS build
WORKDIR /build
ENV CI=true
RUN npm install --global pnpm@10.34.7
COPY . .
RUN pnpm install --frozen-lockfile
ARG SOURCE_URL=https://github.com/plaingym/plaingym
RUN test -n "$SOURCE_URL" && SOURCE_URL="$SOURCE_URL" pnpm build

FROM ${NODE_IMAGE} AS runtime
COPY deploy/pgdg.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
# Exact package pins from a fixed snapshot.debian.org timestamp and the PGDG archive (deploy/README.md).
COPY deploy/apt-runtime.sh deploy/apt-runtime-pins.txt /tmp/apt/
RUN sh /tmp/apt/apt-runtime.sh install /tmp/apt/apt-runtime-pins.txt \
 && dpkg-query -W > /usr/local/share/system-packages.tsv \
 && rm -rf /tmp/apt \
 # The app runs on node alone; the base image's package managers only add unused code to scan and patch.
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 NODE_OPTIONS=--max-old-space-size=256
WORKDIR /app
COPY --from=build /build/apps/server/dist/ ./
COPY --from=build /build/apps/web/dist/ ./public/
COPY --from=build /build/packs/ ./packs/
# migrateDatabase resolves ./migrations/ beside server.mjs.
COPY --from=build /build/packages/db/src/migrations/ ./migrations/
# Dependency and font notices are generated and verified by pnpm compliance.
COPY --from=build /build/LICENSE /build/THIRD_PARTY_LICENSES ./licenses/
COPY deploy/container/ ./deploy/
# Add the Node.js runtime and Debian package notices to the application notices.
RUN chmod 0555 /app/deploy/*.sh \
 && ln -s /app/deploy/gym-app.sh /usr/local/bin/gym-app \
 && mkdir -p /var/lib/plaingym/uploads /var/lib/plaingym/staging \
 && chown -R node:node /var/lib/plaingym \
 && { cat /app/licenses/LICENSE; cat /usr/local/LICENSE; \
      find /usr/share/doc -name copyright -type f -exec cat {} \;; \
      cat /app/licenses/THIRD_PARTY_LICENSES; } > /app/THIRD_PARTY_LICENSES
ARG SOURCE_URL=https://github.com/plaingym/plaingym
ENV SOURCE_URL=${SOURCE_URL}
ARG VERSION=0.0.0-dev
ENV APP_VERSION=${VERSION}
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/plaingym/plaingym" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.url="${SOURCE_URL}"
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 CMD ["node", "/app/deploy/healthcheck.mjs"]
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["node", "server.mjs"]
