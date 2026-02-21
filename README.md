# ETF 리밸런싱 계산기

적립식 ETF 투자 시 **목표 비율을 유지**하기 위해 이번 달에 매수해야 하는 수량과 금액을 자동으로 계산해주는 웹 애플리케이션입니다.

## 기능

- ETF별 현재가, 보유 수량, 목표 비율 입력
- 월 투자 예산 대비 최적 매수 수량 계산
- 예산 초과 시 비례 축소 처리
- 매수 전/후 비율 비교 차트
- 모바일 반응형 UI

## 기술 스택

- **Backend**: Python 3.12, FastAPI, Jinja2
- **Frontend**: Vanilla JS, CSS (프레임워크 없음)
- **배포**: Docker, Fly.io
- **CI/CD**: GitHub Actions

## 로컬 개발

```bash
# 의존성 설치
pip install -r requirements.txt

# 개발 서버 실행
uvicorn app.main:app --reload --port 8080

# http://localhost:8080 에서 확인
```

## Fly.io 배포

### 최초 배포

```bash
# Fly CLI 설치 (macOS)
brew install flyctl

# 로그인
fly auth login

# 앱 생성 및 배포
fly launch

# 또는 기존 설정으로 배포
fly deploy
```

### CI/CD 설정 (GitHub Actions)

1. Fly.io API 토큰 생성:
   ```bash
   fly tokens create deploy -x 999999h
   ```

2. GitHub 리포지토리 → Settings → Secrets → Actions에 추가:
   - Name: `FLY_API_TOKEN`
   - Value: 위에서 생성한 토큰

3. `main` 브랜치에 push하면 자동 배포됩니다.

## 프로젝트 구조

```
etf-rebalancer/
├── app/
│   ├── main.py              # FastAPI 앱 & 리밸런싱 로직
│   ├── static/
│   │   ├── style.css         # 스타일시트
│   │   └── app.js            # 프론트엔드 로직
│   └── templates/
│       └── index.html        # 메인 페이지
├── .github/
│   └── workflows/
│       └── deploy.yml        # CI/CD 파이프라인
├── Dockerfile
├── fly.toml                  # Fly.io 설정
├── requirements.txt
└── README.md
```

## 계산 알고리즘

1. **목표 총 자산** = 현재 보유 금액 + 이번 달 예산
2. **ETF별 목표 금액** = 목표 총 자산 × 목표 비율
3. **추가 매수 금액** = 목표 금액 − 현재 보유 금액
4. **매수 수량** = 추가 매수 금액 ÷ 현재가 (내림)
5. 예산 초과 시 모든 매수 수량을 비례 축소
