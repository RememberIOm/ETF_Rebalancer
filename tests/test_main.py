"""ETF 리밸런싱 계산기 API 테스트"""

from fastapi.testclient import TestClient
from pytest_httpx import HTTPXMock

from app.main import app

client = TestClient(app)

YAHOO_AAPL_RESPONSE = {
    "chart": {"result": [{"meta": {"regularMarketPrice": 195.5}}], "error": None}
}
YAHOO_RATE_RESPONSE = {
    "chart": {"result": [{"meta": {"regularMarketPrice": 1380.5}}], "error": None}
}
YAHOO_BAD_RESPONSE = {"chart": {"result": None, "error": "Not found"}}


def test_health():
    """헬스 체크 엔드포인트"""
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_index():
    """메인 페이지 HTML 반환"""
    resp = client.get("/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]


# ── KR 시장 ────────────────────────────────────────────────────────────────────


def test_price_invalid_ticker_too_short():
    """6자리 미만 종목코드 → 400"""
    resp = client.get("/api/price/123")
    assert resp.status_code == 400


def test_price_invalid_ticker_special_chars():
    """특수문자 포함 종목코드 → 400"""
    resp = client.get("/api/price/069-00")
    assert resp.status_code == 400


def test_price_valid_ticker(httpx_mock: HTTPXMock):
    """유효한 KR 종목코드 → Naver API 응답 모킹 후 가격 반환"""
    httpx_mock.add_response(
        url="https://m.stock.naver.com/api/stock/069500/basic",
        json={"closePrice": "30,000"},
    )
    resp = client.get("/api/price/069500")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ticker"] == "069500"
    assert data["price"] == 30000
    assert data["currency"] == "KRW"
    assert data["market"] == "KR"


def test_price_valid_ticker_explicit_market(httpx_mock: HTTPXMock):
    """market=KR 명시 → 동일하게 동작"""
    httpx_mock.add_response(
        url="https://m.stock.naver.com/api/stock/069500/basic",
        json={"closePrice": "30,000"},
    )
    resp = client.get("/api/price/069500?market=KR")
    assert resp.status_code == 200
    assert resp.json()["currency"] == "KRW"


def test_price_naver_404(httpx_mock: HTTPXMock):
    """Naver API 404 → 404 반환"""
    httpx_mock.add_response(
        url="https://m.stock.naver.com/api/stock/999999/basic",
        status_code=404,
    )
    resp = client.get("/api/price/999999")
    assert resp.status_code == 404


# ── US 시장 ────────────────────────────────────────────────────────────────────


def test_price_us_valid(httpx_mock: HTTPXMock):
    """US 유효 티커 (AAPL) → Yahoo Finance 응답 모킹 후 USD 가격 반환"""
    httpx_mock.add_response(
        url="https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d",
        json=YAHOO_AAPL_RESPONSE,
    )
    resp = client.get("/api/price/AAPL?market=US")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ticker"] == "AAPL"
    assert data["price"] == 195.5
    assert data["currency"] == "USD"
    assert data["market"] == "US"


def test_price_us_futures(httpx_mock: HTTPXMock):
    """US 선물 티커 (ES=F) → = 포함 티커 허용"""
    httpx_mock.add_response(
        url="https://query1.finance.yahoo.com/v8/finance/chart/ES=F?interval=1d&range=1d",
        json={
            "chart": {
                "result": [{"meta": {"regularMarketPrice": 5500.25}}],
                "error": None,
            }
        },
    )
    resp = client.get("/api/price/ES=F?market=US")
    assert resp.status_code == 200
    assert resp.json()["price"] == 5500.25


def test_price_us_invalid_ticker():
    """US 티커 11자 초과 → 400"""
    resp = client.get("/api/price/TOOLONGTICKER?market=US")
    assert resp.status_code == 400


def test_price_us_yahoo_not_found(httpx_mock: HTTPXMock):
    """Yahoo Finance 404 → 404 반환"""
    httpx_mock.add_response(
        url="https://query1.finance.yahoo.com/v8/finance/chart/INVALID?interval=1d&range=1d",
        status_code=404,
    )
    resp = client.get("/api/price/INVALID?market=US")
    assert resp.status_code == 404


def test_price_us_yahoo_parse_error(httpx_mock: HTTPXMock):
    """Yahoo Finance 응답 파싱 실패 → 502"""
    httpx_mock.add_response(
        url="https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d",
        json=YAHOO_BAD_RESPONSE,
    )
    resp = client.get("/api/price/AAPL?market=US")
    assert resp.status_code == 502


# ── CRYPTO 시장 ────────────────────────────────────────────────────────────────


def test_price_crypto_valid(httpx_mock: HTTPXMock):
    """CRYPTO 유효 티커 (BTC) → Upbit 응답 모킹 후 KRW 가격 반환"""
    httpx_mock.add_response(
        url="https://api.upbit.com/v1/ticker?markets=KRW-BTC",
        json=[{"trade_price": 95000000}],
    )
    resp = client.get("/api/price/BTC?market=CRYPTO")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ticker"] == "BTC"
    assert data["price"] == 95000000
    assert data["currency"] == "KRW"
    assert data["market"] == "CRYPTO"


def test_price_crypto_lowercase_rejected():
    """소문자 암호화폐 티커 → 400"""
    resp = client.get("/api/price/btc?market=CRYPTO")
    assert resp.status_code == 400


def test_price_crypto_too_short():
    """1자리 암호화폐 티커 → 400"""
    resp = client.get("/api/price/B?market=CRYPTO")
    assert resp.status_code == 400


def test_price_crypto_unknown_coin(httpx_mock: HTTPXMock):
    """Upbit 빈 배열 응답 (미지원 코인) → 404"""
    httpx_mock.add_response(
        url="https://api.upbit.com/v1/ticker?markets=KRW-UNKNOWN",
        json=[],
    )
    resp = client.get("/api/price/UNKNOWN?market=CRYPTO")
    assert resp.status_code == 404


# ── 환율 엔드포인트 ────────────────────────────────────────────────────────────


def test_rate_usdkrw(httpx_mock: HTTPXMock):
    """USDKRW 환율 조회 → Yahoo Finance USDKRW=X 티커 사용"""
    httpx_mock.add_response(
        url="https://query1.finance.yahoo.com/v8/finance/chart/USDKRW=X?interval=1d&range=1d",
        json=YAHOO_RATE_RESPONSE,
    )
    resp = client.get("/api/rate/USDKRW")
    assert resp.status_code == 200
    assert resp.json() == {"pair": "USDKRW", "rate": 1380.5}


def test_rate_invalid_pair():
    """잘못된 환율 쌍 형식 → 400"""
    resp = client.get("/api/rate/invalid!pair")
    assert resp.status_code == 400


# ── market 파라미터 검증 ────────────────────────────────────────────────────────


def test_price_invalid_market():
    """지원하지 않는 market 값 → 422 (FastAPI enum 검증)"""
    resp = client.get("/api/price/069500?market=UNKNOWN")
    assert resp.status_code == 422
