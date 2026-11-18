FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 5002
# Numeric UID so Kubernetes can verify runAsNonRoot (a name like "node" cannot be verified).
USER 1000
# node directly, not "npm start": npm writes logs under $HOME, which fails on a read-only root filesystem.
CMD ["node", "server.js"]
