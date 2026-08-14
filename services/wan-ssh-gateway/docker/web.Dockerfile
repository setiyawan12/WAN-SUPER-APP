FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json vite.config.ssh-web.ts ./
COPY modules/ssh/ui ./modules/ssh/ui
RUN npm ci --ignore-scripts
RUN npm run build:ssh-web

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY services/wan-ssh-gateway/docker/nginx.local.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/firebase/hosting/ssh /usr/share/nginx/html
EXPOSE 8080