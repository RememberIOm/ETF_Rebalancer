"""ETF 리밸런싱 계산기 API 테스트"""

from fastapi.testclient import TestClient
from pytest_httpx import HTTPXMock

from app.main import app

client = TestClient(app)


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


def test_price_invalid_ticker_too_short():
    """6자리 미만 종목코드 → 400"""
    resp = client.get("/api/price/123")
    assert resp.status_code == 400


def test_price_invalid_ticker_special_chars():
    """특수문자 포함 종목코드 → 400"""
    resp = client.get("/api/price/069-00")
    assert resp.status_code == 400


def test_price_valid_ticker(httpx_mock: HTTPXMock):
    """유효한 종목코드 → Naver API 응답 모킹 후 가격 반환"""
    httpx_mock.add_response(
        url="https://m.stock.naver.com/api/stock/069500/basic",
        json={"closePrice": "30,000"},
    )
    resp = client.get("/api/price/069500")
    assert resp.status_code == 200
    assert resp.json() == {"ticker": "069500", "price": 30000}


def test_price_naver_404(httpx_mock: HTTPXMock):
    """Naver API 404 → 404 반환"""
    httpx_mock.add_response(
        url="https://m.stock.naver.com/api/stock/999999/basic",
        status_code=404,
    )
    resp = client.get("/api/price/999999")
    assert resp.status_code == 404
