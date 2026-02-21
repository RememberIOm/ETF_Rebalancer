"""
ETF 리밸런싱 계산기 - 메인 애플리케이션
적립식 ETF 투자 시 목표 비율을 맞추기 위한 매수 수량/금액 계산
"""

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import math
from pathlib import Path

app = FastAPI(title="ETF 리밸런싱 계산기")

# 정적 파일 및 템플릿 설정
BASE_DIR = Path(__file__).resolve().parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


# --- 데이터 모델 ---

class ETFHolding(BaseModel):
    """개별 ETF 보유 정보"""
    name: str               # ETF 이름/티커
    current_price: float     # 현재가 (원 또는 달러)
    held_quantity: int       # 현재 보유 수량
    target_ratio: float      # 목표 비율 (%, 0~100)


class RebalanceRequest(BaseModel):
    """리밸런싱 요청"""
    holdings: list[ETFHolding]
    monthly_budget: float    # 이번 달 투자 예산


class ETFResult(BaseModel):
    """개별 ETF 계산 결과"""
    name: str
    current_price: float
    held_quantity: int
    held_value: float        # 현재 보유 금액
    target_ratio: float
    current_ratio: float     # 현재 비율
    buy_quantity: int        # 매수해야 할 수량
    buy_amount: float        # 매수 금액
    final_quantity: int      # 매수 후 총 수량
    final_value: float       # 매수 후 총 금액
    final_ratio: float       # 매수 후 비율


class RebalanceResponse(BaseModel):
    """리밸런싱 결과"""
    results: list[ETFResult]
    total_held_value: float       # 총 보유 금액
    total_buy_amount: float       # 총 매수 금액
    total_final_value: float      # 매수 후 총 자산
    budget_remaining: float       # 남은 예산


# --- 리밸런싱 계산 로직 ---

def calculate_rebalance(request: RebalanceRequest) -> RebalanceResponse:
    """
    목표 비율에 맞추기 위한 매수 수량을 계산합니다.

    알고리즘:
    1. 현재 보유 금액 + 이번 달 예산 = 목표 총 자산
    2. 각 ETF의 목표 금액 = 목표 총 자산 × 목표 비율
    3. 추가 매수 금액 = 목표 금액 - 현재 보유 금액
    4. 매수 수량 = 추가 매수 금액 ÷ 현재가 (내림)
    5. 음수인 경우(이미 초과 보유) → 매수 0으로 처리
    """
    holdings = request.holdings
    budget = request.monthly_budget

    # 현재 보유 금액 계산
    total_held = sum(h.current_price * h.held_quantity for h in holdings)

    # 목표 총 자산 (현재 보유 + 이번 달 예산)
    target_total = total_held + budget

    results: list[ETFResult] = []
    total_buy = 0.0

    for h in holdings:
        held_value = h.current_price * h.held_quantity
        target_value = target_total * (h.target_ratio / 100.0)
        gap = target_value - held_value

        # 매수 수량 계산 (내림, 최소 0)
        if gap > 0 and h.current_price > 0:
            buy_qty = math.floor(gap / h.current_price)
        else:
            buy_qty = 0

        buy_amount = buy_qty * h.current_price
        total_buy += buy_amount

        final_qty = h.held_quantity + buy_qty
        final_value = final_qty * h.current_price

        results.append(ETFResult(
            name=h.name,
            current_price=h.current_price,
            held_quantity=h.held_quantity,
            held_value=held_value,
            target_ratio=h.target_ratio,
            current_ratio=(held_value / total_held * 100) if total_held > 0 else 0,
            buy_quantity=buy_qty,
            buy_amount=buy_amount,
            final_quantity=final_qty,
            final_value=final_value,
            final_ratio=0,  # 아래에서 계산
        ))

    # 예산 초과 시 비례 축소
    if total_buy > budget and total_buy > 0:
        scale = budget / total_buy
        total_buy = 0.0
        for r in results:
            adjusted_qty = math.floor(r.buy_quantity * scale)
            r.buy_quantity = adjusted_qty
            r.buy_amount = adjusted_qty * r.current_price
            r.final_quantity = r.held_quantity + adjusted_qty
            r.final_value = r.final_quantity * r.current_price
            total_buy += r.buy_amount

    # 최종 비율 계산
    total_final = sum(r.final_value for r in results)
    for r in results:
        r.final_ratio = (r.final_value / total_final * 100) if total_final > 0 else 0

    return RebalanceResponse(
        results=results,
        total_held_value=total_held,
        total_buy_amount=total_buy,
        total_final_value=total_final,
        budget_remaining=budget - total_buy,
    )


# --- API 엔드포인트 ---

@app.get("/")
async def index(request: Request):
    """메인 페이지"""
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/api/rebalance", response_model=RebalanceResponse)
async def rebalance(request: RebalanceRequest):
    """리밸런싱 계산 API"""
    # 유효성 검증
    total_ratio = sum(h.target_ratio for h in request.holdings)
    if abs(total_ratio - 100.0) > 0.01:
        return JSONResponse(
            status_code=400,
            content={"detail": f"목표 비율의 합이 100%가 아닙니다 (현재: {total_ratio:.1f}%)"},
        )

    if request.monthly_budget <= 0:
        return JSONResponse(
            status_code=400,
            content={"detail": "월 투자 예산은 0보다 커야 합니다"},
        )

    return calculate_rebalance(request)


@app.get("/health")
async def health():
    """헬스 체크 (Fly.io용)"""
    return {"status": "ok"}
