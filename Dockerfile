FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl curl

COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm ci
RUN npx prisma generate

COPY . .

# Vite inlines VITE_ vars at build time — Railway exposes them as env vars
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

RUN npm run build:server && npm run build:client

# Remove source after build to reduce image size
RUN rm -rf src

ENV NODE_ENV=production

CMD ["node", "dist/server/main.js"]
