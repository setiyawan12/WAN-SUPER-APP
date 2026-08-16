FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json vite.config.ssh-web.ts ./
COPY modules/ssh/ui ./modules/ssh/ui
RUN npm ci --ignore-scripts

# Konfigurasi Firebase Web SDK bersifat publik dan di-inject saat build.
# Service account, private key, dan OAuth client secret tidak pernah dipakai di sini.
ARG VITE_FIREBASE_API_KEY=""
ARG VITE_FIREBASE_AUTH_DOMAIN=""
ARG VITE_FIREBASE_PROJECT_ID=""
ARG VITE_FIREBASE_DATABASE_URL=""
ARG VITE_FIREBASE_STORAGE_BUCKET=""
ARG VITE_FIREBASE_MESSAGING_SENDER_ID=""
ARG VITE_FIREBASE_APP_ID=""
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_DATABASE_URL=$VITE_FIREBASE_DATABASE_URL \
    VITE_FIREBASE_STORAGE_BUCKET=$VITE_FIREBASE_STORAGE_BUCKET \
    VITE_FIREBASE_MESSAGING_SENDER_ID=$VITE_FIREBASE_MESSAGING_SENDER_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID
RUN npm run build:ssh-web

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY services/wan-ssh-gateway/docker/nginx.local.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/firebase/hosting/ssh /usr/share/nginx/html
EXPOSE 8080