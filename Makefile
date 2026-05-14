# ETF 리밸런싱 계산기 — 로컬 개발 명령어
# 모든 작업은 Docker 컨테이너 안에서 실행됩니다.

.PHONY: dev test lint build clean

## 로컬 개발 서버 시작 (hot-reload, http://localhost:8080)
dev:
	docker compose up app

## 테스트 실행
test:
	docker compose run --rm test

## 코드 린트 + 타입 체크
lint:
	docker compose run --rm test uv run ruff check .
	docker compose run --rm test uv run pyright
	docker compose run --rm test node --check app/static/app.js

## Docker 이미지 빌드
build:
	docker compose build

## 컨테이너 및 이미지 정리
clean:
	docker compose down --rmi local --volumes
