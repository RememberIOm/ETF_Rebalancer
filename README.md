# 📈 ETF Rebalancer (ETF 리밸런싱 계산기)

적립식 투자자를 위한 **개인화된 ETF/주식/코인 포트폴리오 리밸런싱 계산기**입니다.
매월 투자할 예산과 현재 보유 종목·목표 비율을 입력하면 **어떤 종목을 얼마나 매수해야 하는지** 자동으로 계산해 줍니다.

**지원 시장:** 한국 ETF/주식 (Naver Finance) · 미국 주식/ETF (Yahoo Finance) · 암호화폐 (Upbit)

![Python](https://img.shields.io/badge/Python-3.13+-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-005571?style=flat-square&logo=fastapi)
![Fly.io](https://img.shields.io/badge/Deployed_on-Fly.io-7b51b6?style=flat-square&logo=fly.io&logoColor=white)

<div align="center">

🚀 **[etf-rebalancer.fly.dev](https://etf-rebalancer.fly.dev)**

</div>

---

## ✨ 핵심 기능 (Features)

- **🌏 다중 시장 지원**
  - **KR (한국):** Naver Finance, 6자리 영숫자 티커 (예: `069500`)
  - **US (미국):** Yahoo Finance, 1~10자 티커 (예: `AAPL`, `ES=F`, `GC=F`)
  - **CRYPTO (코인):** Upbit KRW 마켓, 2~10자 대문자 티커 (예: `BTC`, `ETH`)
  - 티커 입력 시 현재가 자동 조회 (debounce 600ms)
  - US 자산은 Yahoo Finance 실시간 환율(USD→KRW)로 자동 환산, 10분 캐시
  - US 티커의 Yahoo Finance 과거 종가를 조회해 동적 목표비중 계산에 활용

- **🧭 동적 목표비중 패널**
  - VT 같은 Yahoo Finance 지원 티커의 과거 가격으로 위험자산/현금성 자산의 이론적 배분 참고값을 계산합니다.
  - 지원 방식: 변동성 목표화, 평균-분산·머튼, VaR·ES 위험예산, CPPI·손실한도.
  - ETF 행별 자산 유형(`VT`, `S&P500`, `Nasdaq100`, `KOSPI200`, `KRX300`, `현금성 자산`, `기타`)과 하위비중을 조정할 수 있습니다.
  - 계산값은 미리보기로만 표시되며, 사용자가 **목표 비율에 적용**을 누르기 전에는 기존 목표 비율을 덮어쓰지 않습니다.

- **🔀 수량·금액 기준 매수 선택**
  - 자산별로 **수량 기준(주)** 또는 **금액 기준(원)** 매수 방식을 토글로 선택 가능
  - **수량 기준:** 정수 주 단위로 계산 (한국 ETF 기본값)
  - **금액 기준:** 소수점 수량 계산 — 코인·소수점 주식에 적합 (CRYPTO 기본값)

- **🔒 100% 클라이언트 사이드 연산 (Privacy-First)**
  - 모든 계산과 데이터 관리가 브라우저 내부에서 수행됩니다.
  - 서버는 외부 금융 API의 CORS 프록시 역할만 담당하며, 자산 데이터를 저장하지 않습니다.
  - 다수의 사용자가 동시에 접속해도 완전히 독립적으로 동작합니다.

- **💾 JSON 데이터 Import / Export (v3)**
  - 포트폴리오 상태(시장·통화·매수방식·보유량 등)를 `.json` 파일로 저장하고 언제든 불러올 수 있습니다.
  - 동적 목표비중 설정, 자산 유형, 하위비중을 함께 저장합니다.
  - v1/v2 형식 자동 마이그레이션 지원.

- **🎯 스마트 리밸런싱 알고리즘**
  - 목표 총 자산(현재 자산 + 이번 달 예산)을 기준으로 각 종목의 목표 금액을 산출합니다.
  - 예산 초과 시 비례 축소 로직이 자동으로 적용됩니다.
  - 최종 비율은 남은 예산을 현금으로 포함한 총자산 기준으로 표시해 목표 비율과 직접 비교할 수 있습니다.
  - **0% 목표 비율 지원:** 더 이상 추가 매수하지 않고 보유만 유지할 종목도 포트폴리오에 남겨둘 수 있습니다.

- **📊 시각화 및 직관적인 UI/UX**
  - 매수 전/후의 비율을 비교할 수 있는 인터랙티브 바 차트 제공
  - 모바일 기기에서도 완벽하게 작동하는 반응형(Responsive) 웹 디자인 (Light Theme)

---

## 🛠 기술 스택 (Tech Stack)

### Frontend
- **HTML5 / CSS3** (CSS Variables, Flex/Grid 기반 반응형 레이아웃)
- **Vanilla JavaScript (ES2022+)** (프레임워크 없이 가볍고 빠른 동작)
- **Node.js 내장 test runner** (리밸런싱/동적 목표비중 순수 함수 테스트)

### Backend & Deployment
- **Python 3.13** / **FastAPI** / **Jinja2** (정적 파일 및 CORS 프록시)
- **httpx** (비동기 HTTP 클라이언트)
- **uv** (패키지 관리 및 가상환경)
- **ruff** (Lint & Format) / **pyright** (타입 체크)
- **Docker** (멀티 스테이지 컨테이너)
- **Fly.io** (클라우드 배포, Auto-stop/start 적용으로 리소스 최적화)

---

## 🚀 로컬 실행 방법 (Local Setup)

### Docker로 실행 (권장)

```bash
# 저장소 클론
git clone <repository-url>
cd ETF_Rebalancer

# 개발 서버 시작 (hot-reload)
make dev
```

브라우저에서 `http://localhost:8080`으로 접속합니다.

기타 make 명령:
```bash
make test   # Python API 테스트 + JavaScript 알고리즘 테스트 실행
make lint   # ruff check + pyright + app.js 구문 검사
make build  # Docker 이미지 빌드
make clean  # 컨테이너/이미지 정리
```

### uv로 직접 실행 (참고용)

공식 개발·검증 경로는 Docker 기반 `make` 명령입니다. 아래 방식은 빠른 로컬 확인용이며, PR/배포 전에는 반드시 `make test`와 `make lint`를 실행합니다.

```bash
git clone <repository-url>
cd ETF_Rebalancer

# 의존성 설치 (uv가 Python 3.13 + 가상환경을 자동 생성)
uv sync

# FastAPI 서버 실행
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

브라우저에서 `http://localhost:8000`으로 접속합니다.

---

## 🐳 Docker로 실행하기

```bash
# 이미지 빌드
docker build -t etf-rebalancer .

# 컨테이너 실행 (포트 8080 매핑)
docker run -p 8080:8080 etf-rebalancer
```

---

## ☁️ 클라우드 배포 (Fly.io)

이 프로젝트는 [Fly.io](https://fly.io) 배포에 최적화된 `fly.toml`을 포함하고 있습니다. (도쿄 `nrt` 리전 기준)

```bash
fly auth login
fly deploy
```

---

## 📁 프로젝트 구조 (Project Structure)

```text
ETF_Rebalancer/
├── app/
│   ├── main.py              # FastAPI 앱
│   │                        #   GET /api/price/{ticker}?market=KR|US|CRYPTO
│   │                        #   GET /api/history/{ticker}?market=US&range=1y&interval=1d
│   │                        #   GET /api/rate/USDKRW
│   ├── static/
│   │   ├── app.js           # 리밸런싱 계산 + UI 로직 (전부 클라이언트 사이드)
│   │   └── style.css        # UI 스타일링 (Light Theme)
│   └── templates/
│       └── index.html       # SPA 진입점
├── tests/
│   ├── test_main.py         # pytest API 테스트
│   └── js/                  # Node.js 기반 프론트엔드 알고리즘 테스트
├── .github/
│   └── workflows/
│       └── fly-deploy.yml   # GitHub Actions CI/CD
├── Dockerfile               # 멀티 스테이지 빌드 (production, dev)
├── docker-compose.yml       # 개발/테스트 컨테이너 설정
├── Makefile                 # 개발 작업 단축 명령
├── fly.toml                 # Fly.io 배포 설정 파일
├── pyproject.toml           # 프로젝트 설정 및 의존성
└── uv.lock                  # 의존성 잠금 파일
```

---

## 💡 사용 가이드

1. **예산 설정:** 화면 상단에 이번 달 투자 예산(₩)을 입력합니다.
2. **포트폴리오 구성:**
   - [ETF 추가] 버튼을 눌러 종목을 추가합니다.
   - **시장** 선택 → **종목코드** 입력 시 현재가 자동 조회
   - 종목명, 보유 수량, **목표 비율(%)** 입력 (합계 100%)
   - 보유 수량 오른쪽의 **`주`/`원` 버튼**으로 매수 방식 전환:
      - `주` — 수량 기준 (정수 주 단위, 한국 ETF 기본)
      - `원` — 금액 기준 (소수점 수량, 코인·소수점 주식 기본)
3. **동적 목표비중 확인(선택):** [동적 목표비중] 패널에서 계산 방식을 선택하고, ETF 유형별 목표비중 미리보기를 확인합니다.
4. **목표 비율 적용(선택):** 미리보기 값이 적절할 때만 [목표 비율에 적용]을 눌러 ETF 목록의 목표 비율 입력값에 반영합니다.
5. **계산하기:** [리밸런싱 계산하기] 버튼(또는 Enter)을 누릅니다.
6. **결과 확인:** 표와 차트에서 매수 수량·금액 및 남은 예산을 현금으로 포함한 최종 비율을 확인합니다.
7. **저장:** [내보내기]로 현재 상태를 `.json`으로 저장하고, 다음 달에 [불러오기]로 이어서 사용합니다.

---

## ⚠️ 면책 조항 (Disclaimer)

본 애플리케이션의 계산 결과와 동적 목표비중은 사용자가 입력한 데이터와 과거 가격을 바탕으로 한 수학적 산출 결과일 뿐이며, **투자 권유나 재무적 조언을 목적으로 하지 않습니다.** 과거 변동성, VaR, ES, CPPI 입력값은 미래 수익이나 손실을 보장하지 않습니다. 실제 매매 시에는 시장 상황, 호가 단위, 수수료, 세금, 환율, 개인의 재무 상황 등에 의해 결과가 달라질 수 있으므로 반드시 **투자 판단의 참고용**으로만 사용하시기 바랍니다.
