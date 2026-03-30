"""
ETF 리밸런싱 계산기 — 메인 애플리케이션 (Stateless Server)

모든 계산 로직은 클라이언트(JavaScript)에서 처리합니다.
서버는 정적 파일 제공 및 CORS 프록시(Naver Finance, Yahoo Finance, Upbit)만 담당합니다.

[아키텍처 결정]
- 기존: 서버(FastAPI)에서 리밸런싱 계산 → 공유 상태 발생 가능성
- 변경: 클라이언트에서 전부 처리 → 서버는 단순 파일 서빙만 담당
- 이점: Fly.io 등 다중 사용자 환경에서 세션/파일 충돌 원천 차단

[지원 시장]
- KR: 한국 ETF/주식 (Naver Finance, 6자리 영숫자 티커)
- US: 미국 주식/ETF/선물 (Yahoo Finance, 1-10자 티커)
- CRYPTO: 암호화폐 (Upbit KRW 마켓, 2-10자 대문자 티커)
"""

import re
from pathlib import Path
from typing import Annotated, Literal

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi import Path as FPath
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI(title="ETF 리밸런싱 계산기")

# 정적 파일 및 템플릿 경로 설정
BASE_DIR = Path(__file__).resolve().parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

# 시장별 티커 검증 패턴
_RE_KR = re.compile(r"[A-Za-z0-9]{6}")
_RE_US = re.compile(r"[A-Za-z0-9.\-=^]{1,10}")
_RE_CRYPTO = re.compile(r"[A-Z]{2,10}")
_RE_PAIR = re.compile(r"[A-Z0-9=X]{3,10}")

type Market = Literal["KR", "US", "CRYPTO"]


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    """메인 페이지 — 단일 페이지 애플리케이션(SPA) 진입점"""
    return templates.TemplateResponse(request, "index.html")


async def _fetch_kr(client: httpx.AsyncClient, ticker: str) -> dict[str, object]:
    """Naver Finance에서 한국 ETF/주식 현재가 조회 (KRW)"""
    url = f"https://m.stock.naver.com/api/stock/{ticker}/basic"
    try:
        resp = await client.get(url, timeout=5.0, headers={"User-Agent": "Mozilla/5.0"})
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="조회 시간이 초과되었습니다")

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="존재하지 않는 종목코드입니다")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Naver Finance API 오류")

    data = resp.json()
    try:
        price = int(data["closePrice"].replace(",", ""))
    except (KeyError, ValueError):
        raise HTTPException(status_code=502, detail="가격 정보를 파싱할 수 없습니다")

    return {"ticker": ticker, "price": price, "currency": "KRW", "market": "KR"}


async def _fetch_yahoo(client: httpx.AsyncClient, ticker: str) -> float:
    """Yahoo Finance에서 가격/환율 조회 — US 주식과 환율 엔드포인트 공유"""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1d"
    try:
        resp = await client.get(url, timeout=5.0, headers={"User-Agent": "Mozilla/5.0"})
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="조회 시간이 초과되었습니다")

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="존재하지 않는 티커입니다")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Yahoo Finance API 오류")

    try:
        price: float = resp.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]
    except (KeyError, IndexError, TypeError):
        raise HTTPException(status_code=502, detail="가격 정보를 파싱할 수 없습니다")

    return price


async def _fetch_us(client: httpx.AsyncClient, ticker: str) -> dict[str, object]:
    """Yahoo Finance에서 미국 주식/ETF/선물 현재가 조회 (USD)"""
    price = await _fetch_yahoo(client, ticker)
    return {"ticker": ticker, "price": price, "currency": "USD", "market": "US"}


async def _fetch_crypto(client: httpx.AsyncClient, ticker: str) -> dict[str, object]:
    """Upbit에서 암호화폐 현재가 조회 (KRW)"""
    url = f"https://api.upbit.com/v1/ticker?markets=KRW-{ticker}"
    try:
        resp = await client.get(url, timeout=5.0, headers={"User-Agent": "Mozilla/5.0"})
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="조회 시간이 초과되었습니다")

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Upbit API 오류")

    data = resp.json()
    if not data:
        raise HTTPException(status_code=404, detail="존재하지 않는 암호화폐 티커입니다")

    try:
        price = int(data[0]["trade_price"])
    except (KeyError, IndexError, TypeError, ValueError):
        raise HTTPException(status_code=502, detail="가격 정보를 파싱할 수 없습니다")

    return {"ticker": ticker, "price": price, "currency": "KRW", "market": "CRYPTO"}


@app.get("/api/price/{ticker}")
async def get_price(
    ticker: Annotated[str, FPath(description="종목코드")],
    market: Annotated[Market, Query(description="시장 구분")] = "KR",
) -> dict[str, object]:
    """현재가 조회 — 브라우저 CORS 우회용 프록시

    - market=KR (기본값): Naver Finance, 6자리 영숫자 티커
    - market=US: Yahoo Finance, 1-10자 티커 (AAPL, ES=F 등)
    - market=CRYPTO: Upbit KRW 마켓, 2-10자 대문자 티커 (BTC, ETH 등)
    """
    match market:
        case "KR":
            if not _RE_KR.fullmatch(ticker):
                raise HTTPException(
                    status_code=400, detail="KR 종목코드는 6자리 영숫자여야 합니다"
                )
        case "US":
            if not _RE_US.fullmatch(ticker):
                raise HTTPException(
                    status_code=400,
                    detail="US 티커는 1~10자 영문자/숫자/특수문자(. - = ^)여야 합니다",
                )
        case "CRYPTO":
            if not _RE_CRYPTO.fullmatch(ticker):
                raise HTTPException(
                    status_code=400,
                    detail="암호화폐 티커는 2~10자 대문자 영문자여야 합니다",
                )

    async with httpx.AsyncClient() as client:
        match market:
            case "KR":
                return await _fetch_kr(client, ticker)
            case "US":
                return await _fetch_us(client, ticker)
            case "CRYPTO":
                return await _fetch_crypto(client, ticker)


@app.get("/api/rate/{pair}")
async def get_rate(
    pair: Annotated[str, FPath(description="환율 쌍 (예: USDKRW)")],
) -> dict[str, object]:
    """환율 조회 — Yahoo Finance 프록시

    예: /api/rate/USDKRW → USD/KRW 환율 반환
    """
    if not _RE_PAIR.fullmatch(pair):
        raise HTTPException(
            status_code=400, detail="환율 쌍 형식이 올바르지 않습니다 (예: USDKRW)"
        )

    yahoo_ticker = f"{pair}=X"
    async with httpx.AsyncClient() as client:
        rate = await _fetch_yahoo(client, yahoo_ticker)

    return {"pair": pair, "rate": rate}


@app.get("/health")
async def health() -> dict[str, str]:
    """헬스 체크 (Fly.io 머신 자동 시작/중지용)"""
    return {"status": "ok"}
