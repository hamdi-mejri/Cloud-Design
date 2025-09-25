# -------- Builder --------
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
# Use npm ci when a lockfile exists; fallback to npm install otherwise
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY . .

# -------- Runner (non-root) --------
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S nodegrp && adduser -S nodeusr -G nodegrp
COPY --from=builder /app /app
EXPOSE 8080
USER nodeusr
CMD ["npm","start"]
