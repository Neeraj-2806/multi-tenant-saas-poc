FROM node:18 AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Unprivileged nginx: runs as uid 101 and listens on 8080, so the pod can run as non-root
# with a read-only root filesystem (it writes only under /tmp, which the chart mounts as emptyDir).
FROM nginxinc/nginx-unprivileged:alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
# Numeric UID so Kubernetes can verify runAsNonRoot.
USER 101
