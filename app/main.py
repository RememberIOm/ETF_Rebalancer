"""
ETF 리밸런싱 계산기 — 메인 애플리케이션 (Stateless Server)

모든 계산 로직은 클라이언트(JavaScript)에서 처리합니다.
서버는 정적 파일 제공 및 헬스 체크만 담당하여,
여러 사용자가 동시에 접속해도 서로 간섭 없이 독립적으로 사용할 수 있습니다.

[아키텍처 결정]
- 기존: 서버(FastAPI)에서 리밸런싱 계산 → 공유 상태 발생 가능성
- 변경: 클라이언트에서 전부 처리 → 서버는 단순 파일 서빙만 담당
- 이점: Fly.io 등 다중 사용자 환경에서 세션/파일 충돌 원천 차단
"""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI(title="ETF 리밸런싱 계산기")

# 정적 파일 및 템플릿 경로 설정
BASE_DIR = Path(__file__).resolve().parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    """메인 페이지 — 단일 페이지 애플리케이션(SPA) 진입점"""
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/health")
async def health() -> dict[str, str]:
    """헬스 체크 (Fly.io 머신 자동 시작/중지용)"""
    return {"status": "ok"}
