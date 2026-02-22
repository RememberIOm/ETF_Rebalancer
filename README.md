# 📈 ETF Rebalancer (ETF 리밸런싱 계산기)

적립식 투자자를 위한 **개인화된 ETF 포트폴리오 리밸런싱 계산기**입니다. 
매월 투자할 예산과 현재 보유 중인 ETF, 그리고 목표 비율을 입력하면 **어떤 종목을 몇 주 매수해야 하는지** 자동으로 계산해 줍니다.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.12+-blue.svg)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115.6-009688.svg)
![Fly.io](https://img.shields.io/badge/Deployed_on-Fly.io-7b51b6.svg)

---

## ✨ 핵심 기능 (Features)

- **🔒 100% 클라이언트 사이드 연산 (Privacy-First)**
  - 모든 계산과 데이터 관리가 브라우저 내부에서 수행됩니다.
  - 서버로 개인의 자산 데이터를 전송하지 않아 보안과 프라이버시가 완벽히 보장됩니다.
  - 세션 관리가 필요 없으므로 다수의 사용자가 동시에 접속해도 독립적으로 동작합니다.
- **💾 JSON 데이터 Import / Export**
  - 현재 입력된 포트폴리오(ETF 목록, 가격, 보유량, 예산 등) 상태를 `.json` 파일로 로컬에 저장하고 언제든 불러올 수 있습니다.
- **🎯 스마트 리밸런싱 알고리즘**
  - 목표 총 자산(현재 자산 + 이번 달 예산)을 기준으로 각 ETF의 목표 금액을 산출합니다.
  - 현재가 대비 부족한 금액만큼 매수 수량을 계산하며(내림 처리), 예산 초과 시 비례 축소 로직이 적용됩니다.
  - **0% 목표 비율 지원:** 더 이상 추가 매수하지 않고 보유만 유지할 ETF도 포트폴리오에 남겨둘 수 있습니다.
- **📊 시각화 및 직관적인 UI/UX**
  - 매수 전/후의 비율을 비교할 수 있는 인터랙티브 바 차트 제공
  - 예산 및 가격 입력 시 자동 콤마(,) 포맷팅 적용
  - 모바일 기기에서도 완벽하게 작동하는 반응형(Responsive) 웹 디자인 (Light Theme)

---

## 🛠 기술 스택 (Tech Stack)

### Frontend
- **HTML5 / CSS3** (CSS Variables, Flex/Grid 기반 반응형 레이아웃)
- **Vanilla JavaScript (ES6+)** (프레임워크 없이 가볍고 빠른 동작)

### Backend & Deployment
- **Python 3.12** / **FastAPI** / **Jinja2** (정적 파일 및 템플릿 서빙)
- **Docker** (컨테이너화)
- **Fly.io** (클라우드 배포, Auto-stop/start 적용으로 리소스 최적화)

---

## 🚀 로컬 실행 방법 (Local Setup)

### 1. 요구 사항
- Python 3.12 이상 설치

### 2. 설치 및 실행
```bash
# 1. 저장소 클론 (또는 다운로드)
git clone <repository-url>
cd ETF_Rebalancer

# 2. 가상환경 생성 및 활성화 (선택 사항이지만 권장)
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# 3. 의존성 패키지 설치
pip install -r requirements.txt

# 4. FastAPI 서버 실행
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 3. 접속
브라우저를 열고 `http://localhost:8000`으로 접속합니다.

---

## 🐳 Docker로 실행하기

```bash
# 이미지 빌드
docker build -t etf-rebalancer .

# 컨테이너 실행 (포트 8080 매핑)
docker run -p 8080:8080 etf-rebalancer
```
브라우저에서 `http://localhost:8080`으로 접속합니다.

---

## ☁️ 클라우드 배포 (Fly.io)

이 프로젝트는 [Fly.io](https://fly.io) 배포에 최적화된 `fly.toml`을 포함하고 있습니다. (도쿄 `nrt` 리전 기준)

```bash
# Fly CLI가 설치되어 있어야 합니다.
fly auth login

# 배포 실행
fly deploy
```

---

## 📁 프로젝트 구조 (Project Structure)

```text
ETF_Rebalancer/
├── app/
│   ├── main.py              # FastAPI 진입점 (라우팅 및 정적 파일 설정)
│   ├── static/
│   │   ├── app.js           # 프론트엔드 비즈니스/계산 로직 전체
│   │   └── style.css        # UI 스타일링 (Light Theme)
│   └── templates/
│       └── index.html       # 메인 뷰 템플릿
├── Dockerfile               # 도커 빌드 설정 파일
├── fly.toml                 # Fly.io 배포 설정 파일
└── requirements.txt         # 파이썬 패키지 의존성 명세
```

---

## 💡 사용 가이드

1. **예산 설정:** 화면 상단에 '이번 달 투자 예산(₩)'을 입력합니다.
2. **포트폴리오 구성:** 
   - [ETF 추가] 버튼을 눌러 투자할 종목들을 입력합니다.
   - 종목명, 현재가, 보유 수량, **목표 비율(%)**을 입력합니다.
   - 목표 비율의 총합은 반드시 **100%**가 되어야 합니다. (실시간 배지로 확인 가능)
3. **계산하기:** [리밸런싱 계산하기] 버튼(또는 Enter 키)을 누릅니다.
4. **결과 확인:** 하단에 생성되는 표와 차트를 통해 어떤 종목을 몇 주 매수해야 하는지 확인합니다.
5. **저장:** [내보내기] 버튼을 눌러 현재 상태를 `.json` 파일로 PC에 저장해 두고, 다음 달에 [불러오기]를 통해 쉽게 이어서 작업하세요.

---

## ⚠️ 면책 조항 (Disclaimer)
본 애플리케이션의 계산 결과는 사용자가 입력한 데이터를 바탕으로 한 수학적 산출 결과일 뿐이며, **투자 권유나 재무적 조언을 목적으로 하지 않습니다.** 실제 매매 시에는 주식 시장의 호가 단위, 수수료, 세금 등에 의해 오차가 발생할 수 있으므로 반드시 **투자 판단의 참고용**으로만 사용하시기 바랍니다.