FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install tsx typescript && npx tsc

ENV PORT=8787
ENV DATA_DIR=/data
EXPOSE 8787
CMD ["node", "dist/index.js"]
