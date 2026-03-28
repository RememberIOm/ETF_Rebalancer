# ─── Production ───────────────────────────────────────────────────────
FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim AS production

WORKDIR /app

# 의존성 레이어 캐싱: 소스 변경 시에도 의존성은 재설치하지 않음
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# 앱 복사
COPY app/ ./app/

# Fly.io는 8080 포트 사용
EXPOSE 8080

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]

# ─── Dev / Test ───────────────────────────────────────────────────────
FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim AS dev

WORKDIR /app

# pyright(Node.js)가 필요로 하는 libatomic 설치
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*

# dev 의존성 포함 설치 (pytest, ruff, pyright 등)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

# 앱 복사
COPY app/ ./app/

EXPOSE 8080

# 기본 CMD는 hot-reload 모드; docker compose run --rm test 으로 pytest 실행 가능
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--reload"]
