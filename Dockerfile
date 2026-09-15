FROM node:22-bookworm-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ITLES_DB_PATH=/data/itles.sqlite3 \
    ITLES_DEMO_ENABLED=0 \
    ITLES_COOKIE_SECURE=1 \
    PORT=8080
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 itles \
    && useradd --uid 10001 --gid 10001 --no-create-home itles \
    && mkdir /data && chown itles:itles /data
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY . ./
COPY --from=frontend-build /build/frontend/dist ./frontend/dist
RUN python scripts/build_deliverables.py
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c 'import json, os, urllib.request; r = urllib.request.urlopen("http://127.0.0.1:" + os.environ["PORT"] + "/api/health", timeout=3); assert json.load(r)["status"] == "ok"'
CMD ["sh", "-c", "exec python -m uvicorn server:app --host 0.0.0.0 --port \"$PORT\" --workers 1 --no-access-log"]
