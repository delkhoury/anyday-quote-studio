# Anyday Quote Studio: Node server + headless Chromium for PDF export.
FROM mcr.microsoft.com/playwright:v1.56.0-jammy
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY client ./client
COPY shared ./shared
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 4310
CMD ["node", "server/index.js"]
