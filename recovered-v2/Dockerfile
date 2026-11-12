FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node sql ./sql

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3100

USER node

EXPOSE 3100

CMD ["node", "src/server.js"]
