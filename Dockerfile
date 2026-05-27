FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY public/ ./public/
RUN mkdir -p data
EXPOSE 3099
CMD ["node", "server.js"]
