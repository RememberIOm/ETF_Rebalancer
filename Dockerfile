FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim

WORKDIR /app

# 의존성 레이어 캐싱: 소스 변경 시에도 의존성은 재설치하지 않음
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# 앱 복사
COPY app/ ./app/

# Fly.io는 8080 포트 사용
EXPOSE 8080

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
