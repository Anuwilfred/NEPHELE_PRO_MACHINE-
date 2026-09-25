# Build context for this Dockerfile is the REPO ROOT (see docker-compose.yml:
# "context: ., dockerfile: backend-api/Dockerfile"), not ./backend-api --
# that's on purpose. backend-api/src/index.js serves the web-app static
# folder using a path relative to itself (path.join(__dirname, "..", "..",
# "web-app")), the same way it does when run locally with `node src/index.js`
# from inside backend-api/. Mirroring that exact folder layout inside the
# image (/app/backend-api/src + /app/web-app) means index.js needs no
# path changes to work identically in both places.
FROM node:20-alpine
WORKDIR /app

COPY backend-api/package.json backend-api/package-lock.json* ./backend-api/
RUN npm --prefix backend-api install --omit=dev

COPY backend-api/src ./backend-api/src
COPY web-app ./web-app

WORKDIR /app/backend-api
EXPOSE 3000
CMD ["node", "src/index.js"]
