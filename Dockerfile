# Multi-stage build
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend

RUN apk add --no-cache python3 make g++

# Copy backend package files
COPY backend/package*.json ./
RUN npm ci

# Copy backend source
COPY backend/ ./

# Build backend
RUN npm run build

# Frontend builder stage
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# Copy frontend package files
COPY frontend/package*.json ./
RUN npm ci

# Copy frontend source
COPY frontend/ ./

# Build frontend
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg libass intel-media-driver font-noto font-noto-cjk

# Install production dependencies for backend
COPY backend/package*.json ./
RUN apk add --no-cache --virtual .backend-build-deps python3 make g++ \
  && npm ci --omit=dev \
  && apk del .backend-build-deps

# Copy built backend
COPY --from=backend-builder /app/backend/dist ./dist

# Copy built frontend
COPY --from=frontend-builder /app/frontend/dist ./public

# Create writable application directories. Media is mounted separately read-only.
RUN mkdir -p /app/data /app/logs /app/cache

# Set environment variables
ENV NODE_ENV=production
ENV PORT=5069
ENV DATABASE_PATH=/app/data/librarydownloadarr.db
ENV BURN_CACHE_DIR=/app/cache
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV LIBVA_DRIVER_NAME=iHD

# Expose port
EXPOSE 5069

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5069/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "dist/index.js"]
