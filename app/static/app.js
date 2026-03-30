/**
 * ETF 리밸런싱 계산기 — 프론트엔드 로직 (Fully Client-Side)
 *
 * [아키텍처]
 * 모든 계산/데이터 관리가 브라우저에서 수행됩니다.
 * 서버 API 호출 없이 동작하므로, 여러 사용자가 각자의 JSON을
 * 업로드하여 동시에 독립적으로 사용할 수 있습니다.
 *
 * - 0% 비율 허용 (더 이상 매수하지 않을 ETF)
 * - Export/Import JSON 기능 (클라이언트 전용)
 * - 리밸런싱 계산 (클라이언트 전용)
 * - 지원 시장: KR (한국, Naver Finance), US (미국, Yahoo Finance),
 *              CRYPTO (암호화폐, Upbit)
 */

// ========== 상태 관리 ==========

let etfRows = [];
let nextId = 0;

// USD→KRW 환율 캐시 (10분 유효)
let usdKrwRate = null;
let rateFetchedAt = null;

// 시장별 설정
const MARKET_CONFIG = Object.freeze({
  KR: {
    label: '한국',
    currency: 'KRW',
    symbol: '₩',
    tickerPattern: /^[A-Za-z0-9]{6}$/,
    tickerPlaceholder: '069500',
    tickerMaxLength: 6,
  },
  US: {
    label: '미국',
    currency: 'USD',
    symbol: '$',
    tickerPattern: /^[A-Za-z0-9.\-=^]{1,10}$/,
    tickerPlaceholder: 'AAPL',
    tickerMaxLength: 10,
  },
  CRYPTO: {
    label: '코인',
    currency: 'KRW',
    symbol: '₩',
    tickerPattern: /^[A-Z]{2,10}$/,
    tickerPlaceholder: 'BTC',
    tickerMaxLength: 10,
  },
});

// 기본 ETF 프리셋 — JSON 업로드 전 초기 상태
const PRESETS = [
  { name: 'KODEX 200',           ticker: '069500', price: '', qty: '', ratio: '40', market: 'KR' },
  { name: 'TIGER 미국S&P500',    ticker: '143850', price: '', qty: '', ratio: '30', market: 'KR' },
  { name: 'KODEX 미국나스닥100', ticker: '379800', price: '', qty: '', ratio: '20', market: 'KR' },
  { name: 'TIGER 단기채권',      ticker: '157450', price: '', qty: '', ratio: '10', market: 'KR' },
];


// ========== 초기화 ==========

document.addEventListener('DOMContentLoaded', () => {
  PRESETS.forEach(p => addETFRow(p));

  document.getElementById('addBtn').addEventListener('click', () => addETFRow());
  document.getElementById('calcBtn').addEventListener('click', calculate);

  // 예산 입력 — 숫자 포맷팅 (콤마 자동 삽입)
  const budgetInput = document.getElementById('budget');
  budgetInput.addEventListener('input', (e) => {
    const raw = e.target.value.replace(/[^\d]/g, '');
    e.target.value = raw ? Number(raw).toLocaleString() : '';
  });

  // Enter 키로 계산 트리거
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      calculate();
    }
  });

  // Export / Import 이벤트 바인딩
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', importData);

  updateRatioBadge();
});


// ========== ETF 행 관리 ==========

function addETFRow(preset = null) {
  const id = nextId++;
  const row = { id };
  etfRows.push(row);

  const list = document.getElementById('etfList');
  const el = document.createElement('div');
  el.className = 'etf-row';
  el.dataset.id = id;

  const isMobile = window.innerWidth <= 768;
  const market = preset?.market || 'KR';
  const cfg = MARKET_CONFIG[market];
  const initBuyMode = preset?.buy_mode || (market === 'CRYPTO' ? 'amount' : 'qty');

  el.innerHTML = `
    <div class="input-group">
      ${isMobile ? '<label>시장</label>' : ''}
      <select class="input select-market" data-field="market">
        <option value="KR" ${market === 'KR' ? 'selected' : ''}>한국</option>
        <option value="US" ${market === 'US' ? 'selected' : ''}>미국</option>
        <option value="CRYPTO" ${market === 'CRYPTO' ? 'selected' : ''}>코인</option>
      </select>
    </div>
    <div class="input-group">
      ${isMobile ? '<label>ETF 이름</label>' : ''}
      <input type="text" class="input" data-field="name"
             placeholder="ETF 이름" value="${preset?.name || ''}" autocomplete="off">
    </div>
    <div class="input-group">
      ${isMobile ? '<label>종목코드</label>' : ''}
      <input type="text" class="input mono" data-field="ticker"
             placeholder="${cfg.tickerPlaceholder}" value="${preset?.ticker || ''}"
             maxlength="${cfg.tickerMaxLength}" inputmode="text" autocomplete="off">
    </div>
    <div class="input-group">
      ${isMobile ? '<label>현재가</label>' : ''}
      <input type="text" class="input mono" data-field="price"
             placeholder="0" value="${preset?.price || ''}" inputmode="${market === 'US' ? 'decimal' : 'numeric'}" autocomplete="off">
    </div>
    <div class="input-group">
      ${isMobile ? '<label>보유 수량</label>' : ''}
      <div class="qty-with-mode">
        <input type="text" class="input mono" data-field="qty"
               placeholder="0" value="${preset?.qty || ''}"
               inputmode="${market === 'KR' && initBuyMode === 'qty' ? 'numeric' : 'decimal'}" autocomplete="off">
        <button class="btn-buy-mode" type="button" data-buy-mode="${initBuyMode}"
                title="매수 방식 전환 (주=수량 기준 / 원=금액 기준)">${initBuyMode === 'amount' ? '원' : '주'}</button>
      </div>
    </div>
    <div class="input-group">
      ${isMobile ? '<label>목표 비율(%)</label>' : ''}
      <input type="text" class="input mono" data-field="ratio"
             placeholder="0" value="${preset?.ratio || ''}" inputmode="decimal" autocomplete="off">
    </div>
    <button class="btn btn-delete" type="button" title="삭제">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  `;

  const priceInput = el.querySelector('[data-field="price"]');
  const tickerInput = el.querySelector('[data-field="ticker"]');
  const marketSelect = el.querySelector('[data-field="market"]');
  const buyModeBtn = el.querySelector('.btn-buy-mode');
  const qtyInput = el.querySelector('[data-field="qty"]');

  // USD 가격은 dataset에 원시값 보관 (소수점 있는 형태)
  if (market === 'US' && preset?.price) {
    priceInput.dataset.usdPrice = preset.price.replace(/[^\d.]/g, '');
  }

  // 매수 방식 토글 (주=수량 기준, 원=금액 기준)
  buyModeBtn.addEventListener('click', () => {
    const next = buyModeBtn.dataset.buyMode === 'qty' ? 'amount' : 'qty';
    buyModeBtn.dataset.buyMode = next;
    buyModeBtn.textContent = next === 'amount' ? '원' : '주';
    qtyInput.inputMode = marketSelect.value === 'KR' && next === 'qty' ? 'numeric' : 'decimal';
  });

  // 수량 입력 포맷팅 (소수점 중복 방지)
  qtyInput.addEventListener('input', (e) => {
    const currentMarket = marketSelect.value;
    const currentBuyMode = buyModeBtn.dataset.buyMode;
    if (currentMarket === 'KR' && currentBuyMode === 'qty') {
      e.target.value = e.target.value.replace(/[^\d]/g, '');
    } else {
      let raw = e.target.value.replace(/[^\d.]/g, '');
      const dotIdx = raw.indexOf('.');
      if (dotIdx !== -1) {
        raw = raw.slice(0, dotIdx + 1) + raw.slice(dotIdx + 1).replace(/\./g, '');
      }
      e.target.value = raw;
    }
  });

  // 삭제 버튼 — 부드러운 페이드아웃 후 DOM에서 제거
  el.querySelector('.btn-delete').addEventListener('click', () => {
    etfRows = etfRows.filter(r => r.id !== id);
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => el.remove(), 150);
    updateRatioBadge();
  });

  // 시장 변경 — placeholder/maxlength 갱신 및 티커 재검증 후 재조회
  marketSelect.addEventListener('change', () => {
    const newMarket = marketSelect.value;
    const newCfg = MARKET_CONFIG[newMarket];
    tickerInput.placeholder = newCfg.tickerPlaceholder;
    tickerInput.maxLength = newCfg.tickerMaxLength;
    priceInput.value = '';
    priceInput.dataset.usdPrice = '';
    priceInput.inputMode = newMarket === 'US' ? 'decimal' : 'numeric';

    // 시장별 기본 매수 방식으로 리셋
    const newBuyMode = newMarket === 'CRYPTO' ? 'amount' : 'qty';
    buyModeBtn.dataset.buyMode = newBuyMode;
    buyModeBtn.textContent = newBuyMode === 'amount' ? '원' : '주';
    qtyInput.inputMode = newMarket === 'KR' && newBuyMode === 'qty' ? 'numeric' : 'decimal';

    const ticker = tickerInput.value.trim();
    if (newCfg.tickerPattern.test(ticker)) {
      fetchPrice(ticker, newMarket, priceInput);
    }
  });

  // 종목코드 입력 시 현재가 자동 조회 (debounce 600ms)
  let debounceTimer;
  tickerInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const currentMarket = marketSelect.value;
    debounceTimer = setTimeout(
      () => fetchPrice(e.target.value.trim(), currentMarket, priceInput),
      600
    );
  });

  // 가격 입력 포맷팅
  priceInput.addEventListener('input', (e) => {
    const currentMarket = marketSelect.value;
    if (currentMarket === 'US') {
      // 숫자와 소수점만 허용, 소수점 중복 제거
      let raw = e.target.value.replace(/[^\d.]/g, '');
      const dotIdx = raw.indexOf('.');
      if (dotIdx !== -1) {
        raw = raw.slice(0, dotIdx + 1) + raw.slice(dotIdx + 1).replace(/\./g, '');
      }
      e.target.value = raw;
      e.target.dataset.usdPrice = raw || '';
    } else {
      const raw = e.target.value.replace(/[^\d]/g, '');
      e.target.value = raw ? Number(raw).toLocaleString() : '';
    }
  });

  // 비율 변경 시 상단 배지 실시간 업데이트
  el.querySelector('[data-field="ratio"]').addEventListener('input', updateRatioBadge);

  list.appendChild(el);
  return el;
}


// ========== 환율 조회 ==========

async function fetchExchangeRate() {
  if (usdKrwRate && rateFetchedAt && (Date.now() - rateFetchedAt) < 600_000) {
    return usdKrwRate;
  }
  const res = await fetch('/api/rate/USDKRW');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || '환율 조회 실패');
  }
  const data = await res.json();
  usdKrwRate = data.rate;
  rateFetchedAt = Date.now();
  return usdKrwRate;
}


// ========== 현재가 자동 조회 ==========

async function fetchPrice(ticker, market, priceInput) {
  const cfg = MARKET_CONFIG[market];
  if (!cfg?.tickerPattern.test(ticker)) return;

  priceInput.classList.add('loading');
  const prevPlaceholder = priceInput.placeholder;
  priceInput.placeholder = '조회 중...';
  try {
    const res = await fetch(`/api/price/${encodeURIComponent(ticker)}?market=${market}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || '조회 실패');
    }
    const data = await res.json();

    if (market === 'US') {
      const usdPrice = data.price;
      priceInput.dataset.usdPrice = String(usdPrice);
      priceInput.value = usdPrice.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } else {
      priceInput.dataset.usdPrice = '';
      priceInput.value = Math.round(data.price).toLocaleString();
    }
  } catch (err) {
    showToast(`현재가 조회 실패: ${err.message}`);
  } finally {
    priceInput.classList.remove('loading');
    priceInput.placeholder = prevPlaceholder;
  }
}


function updateRatioBadge() {
  const ratioInputs = document.querySelectorAll('[data-field="ratio"]');
  let total = 0;
  ratioInputs.forEach(input => {
    total += parseFloat(input.value) || 0;
  });

  const badge = document.getElementById('ratioTotal');
  const valueEl = document.getElementById('ratioValue');
  valueEl.textContent = total % 1 === 0 ? total : total.toFixed(1);

  badge.classList.remove('warn', 'error');
  if (Math.abs(total - 100) < 0.01) {
    // OK — 정확히 100%
  } else if (total < 100) {
    badge.classList.add('warn');
  } else {
    badge.classList.add('error');
  }
}


// ========== Export / Import (클라이언트 전용) ==========

/**
 * 현재 입력 상태를 JSON 파일로 내보내기 (v2 형식)
 * 서버를 거치지 않으므로 다른 사용자에게 영향 없음
 */
function exportData() {
  const budget = document.getElementById('budget').value.replace(/[^\d]/g, '');
  const rows = document.querySelectorAll('.etf-row');
  const holdings = [];

  for (const row of rows) {
    const market = row.querySelector('[data-field="market"]').value;
    const priceInput = row.querySelector('[data-field="price"]');

    let price, currency;
    if (market === 'US') {
      price = priceInput.dataset.usdPrice || priceInput.value.replace(/[^\d.]/g, '');
      currency = 'USD';
    } else {
      price = priceInput.value.replace(/[^\d]/g, '');
      currency = 'KRW';
    }

    const exportBuyMode = row.querySelector('.btn-buy-mode')?.dataset.buyMode ?? 'qty';
    const exportQtyInput = row.querySelector('[data-field="qty"]');
    const exportQty = market === 'KR' && exportBuyMode === 'qty'
      ? exportQtyInput.value.replace(/[^\d]/g, '')
      : exportQtyInput.value.replace(/[^\d.]/g, '');

    holdings.push({
      name:     row.querySelector('[data-field="name"]').value.trim(),
      ticker:   row.querySelector('[data-field="ticker"]').value.trim(),
      market,
      currency,
      price,
      qty:      exportQty,
      ratio:    row.querySelector('[data-field="ratio"]').value.trim(),
      buy_mode: exportBuyMode,
    });
  }

  const data = {
    version: 2,
    exported_at: new Date().toISOString(),
    budget,
    holdings,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const date = new Date().toISOString().slice(0, 10);
  a.download = `etf-portfolio-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('데이터를 내보냈습니다');
}


/**
 * JSON 파일에서 데이터 불러오기 — v1/v2 형식 모두 지원
 * 브라우저 메모리에만 로드되므로 다른 사용자에게 전혀 영향 없음
 */
function importData(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const data = JSON.parse(evt.target.result);

      if (!data.holdings || !Array.isArray(data.holdings)) {
        showError('올바르지 않은 파일 형식입니다.');
        return;
      }

      const isV1 = !data.version || data.version === 1;

      // 예산 복원
      if (data.budget) {
        const budgetInput = document.getElementById('budget');
        budgetInput.value = Number(data.budget) ? Number(data.budget).toLocaleString() : '';
      }

      // 기존 ETF 행 제거 후 새로 로드
      document.getElementById('etfList').innerHTML = '';
      etfRows = [];
      nextId = 0;

      for (const h of data.holdings) {
        const market = isV1 ? 'KR' : (h.market || 'KR');

        let formattedPrice;
        if (market === 'US') {
          formattedPrice = h.price || '';
        } else {
          formattedPrice = h.price ? Number(h.price).toLocaleString() : '';
        }

        addETFRow({
          name:     h.name     || '',
          ticker:   h.ticker   || '',
          market,
          price:    formattedPrice,
          qty:      h.qty      || '',
          ratio:    h.ratio    || '0',
          buy_mode: h.buy_mode || (market === 'CRYPTO' ? 'amount' : 'qty'),
        });
      }

      updateRatioBadge();

      const msg = isV1
        ? `${data.holdings.length}개 데이터를 불러왔습니다 (v1 → KR 시장 자동 적용)`
        : `${data.holdings.length}개 데이터를 불러왔습니다`;
      showToast(msg);

    } catch (err) {
      showError('파일을 읽는 중 오류가 발생했습니다.');
      console.error(err);
    }
  };
  reader.readAsText(file);

  // 같은 파일을 다시 선택할 수 있도록 값 초기화
  e.target.value = '';
}


// ========== 리밸런싱 계산 (클라이언트 전용) ==========

/**
 * 리밸런싱 핵심 알고리즘
 *
 * 1. 현재 보유 금액 + 이번 달 예산 = 목표 총 자산
 * 2. 각 ETF의 목표 금액 = 목표 총 자산 × 목표 비율
 * 3. 추가 매수 금액 = 목표 금액 - 현재 보유 금액
 * 4. 매수 수량 = 추가 매수 금액 ÷ 현재가 (내림)
 * 5. 음수인 경우(이미 초과 보유) → 매수 0으로 처리
 * 6. 예산 초과 시 비례 축소
 *
 * 모든 금액은 KRW 기준 (USD 자산은 calculate()에서 환산 후 전달)
 *
 * @param {Array} holdings  - [{ name, current_price, held_quantity, target_ratio }]
 * @param {number} budget   - 이번 달 투자 예산 (KRW)
 * @returns {Object}        - 리밸런싱 결과
 */
function calculateRebalance(holdings, budget) {
  // 현재 총 보유 금액
  const totalHeld = holdings.reduce(
    (sum, h) => sum + h.current_price * h.held_quantity, 0
  );

  // 목표 총 자산 (현재 보유 + 이번 달 예산)
  const targetTotal = totalHeld + budget;

  let totalBuy = 0;
  const results = holdings.map(h => {
    const heldValue = h.current_price * h.held_quantity;
    const targetValue = targetTotal * (h.target_ratio / 100);
    const gap = targetValue - heldValue;

    // 매수 수량 계산 (최소 0)
    // - qty 모드: Math.floor (정수 주 단위)
    // - amount 모드: 소수 허용 (코인/소수점 주식)
    let buyQty = 0;
    if (gap > 0 && h.current_price > 0) {
      buyQty = h.buy_mode === 'amount'
        ? gap / h.current_price
        : Math.floor(gap / h.current_price);
    }

    const buyAmount = buyQty * h.current_price;
    totalBuy += buyAmount;

    return {
      name: h.name,
      buy_mode: h.buy_mode,
      current_price: h.current_price,
      held_quantity: h.held_quantity,
      held_value: heldValue,
      target_ratio: h.target_ratio,
      current_ratio: totalHeld > 0 ? (heldValue / totalHeld * 100) : 0,
      buy_quantity: buyQty,
      buy_amount: buyAmount,
      final_quantity: h.held_quantity + buyQty,
      final_value: (h.held_quantity + buyQty) * h.current_price,
      final_ratio: 0, // 아래에서 계산
    };
  });

  // 예산 초과 시 비례 축소
  if (totalBuy > budget && totalBuy > 0) {
    const scale = budget / totalBuy;
    totalBuy = 0;

    for (const r of results) {
      const adjustedQty = r.buy_mode === 'amount'
        ? r.buy_quantity * scale
        : Math.floor(r.buy_quantity * scale);
      r.buy_quantity = adjustedQty;
      r.buy_amount = adjustedQty * r.current_price;
      r.final_quantity = r.held_quantity + adjustedQty;
      r.final_value = r.final_quantity * r.current_price;
      totalBuy += r.buy_amount;
    }
  }

  // 최종 비율 계산
  const totalFinal = results.reduce((sum, r) => sum + r.final_value, 0);
  for (const r of results) {
    r.final_ratio = totalFinal > 0 ? (r.final_value / totalFinal * 100) : 0;
  }

  return {
    results,
    total_held_value: totalHeld,
    total_buy_amount: totalBuy,
    total_final_value: totalFinal,
    budget_remaining: budget - totalBuy,
  };
}


/**
 * "리밸런싱 계산하기" 버튼 핸들러
 * 입력 검증 → 환율 조회(필요 시) → 계산 → 결과 렌더링
 */
async function calculate() {
  const errorBox = document.getElementById('errorBox');
  const resultSection = document.getElementById('resultSection');
  errorBox.style.display = 'none';
  resultSection.style.display = 'none';

  // 예산 파싱
  const budgetRaw = document.getElementById('budget').value.replace(/[^\d]/g, '');
  const budget = Number(budgetRaw);

  if (!budget || budget <= 0) {
    showError('이번 달 투자 예산을 입력해주세요.');
    return;
  }

  // ETF 데이터 수집 및 검증
  const rows = document.querySelectorAll('.etf-row');
  const holdingsRaw = [];
  let hasUS = false;

  for (const row of rows) {
    const name = row.querySelector('[data-field="name"]').value.trim();
    const market = row.querySelector('[data-field="market"]').value;
    const priceInput = row.querySelector('[data-field="price"]');
    const buyMode = row.querySelector('.btn-buy-mode')?.dataset.buyMode ?? 'qty';
    const qtyInput = row.querySelector('[data-field="qty"]');
    const ratioRaw = row.querySelector('[data-field="ratio"]').value.trim();

    if (!name) {
      showError('모든 ETF의 이름을 입력해주세요.');
      return;
    }

    let usdPrice = null;
    let rawPriceKrw = 0;

    if (market === 'US') {
      usdPrice = parseFloat(priceInput.dataset.usdPrice || priceInput.value.replace(/[^\d.]/g, '') || '0');
      if (!usdPrice || usdPrice <= 0) {
        showError(`"${name}"의 현재가를 입력해주세요.`);
        return;
      }
      hasUS = true;
    } else {
      rawPriceKrw = Number(priceInput.value.replace(/[^\d]/g, ''));
      if (!rawPriceKrw || rawPriceKrw <= 0) {
        showError(`"${name}"의 현재가를 입력해주세요.`);
        return;
      }
    }

    const qty = market === 'KR' && buyMode === 'qty'
      ? Number(qtyInput.value.replace(/[^\d]/g, '')) || 0
      : parseFloat(qtyInput.value.replace(/[^\d.]/g, '')) || 0;
    const ratio = parseFloat(ratioRaw);

    if (isNaN(ratio) || ratio < 0) {
      showError(`"${name}"의 목표 비율은 0% 이상이어야 합니다.`);
      return;
    }

    holdingsRaw.push({ name, market, usdPrice, rawPriceKrw, qty, ratio, buy_mode: buyMode });
  }

  if (holdingsRaw.length === 0) {
    showError('최소 1개 이상의 ETF를 추가해주세요.');
    return;
  }

  // 비율 합계 검증
  const totalRatio = holdingsRaw.reduce((sum, h) => sum + h.ratio, 0);
  if (Math.abs(totalRatio - 100) > 0.01) {
    showError(`목표 비율의 합이 100%가 아닙니다 (현재: ${totalRatio.toFixed(1)}%)`);
    return;
  }

  // US 자산이 있으면 환율 조회
  let rate = null;
  if (hasUS) {
    try {
      rate = await fetchExchangeRate();
    } catch (err) {
      showError(`USD→KRW 환율을 가져오지 못했습니다: ${err.message}`);
      return;
    }
  }

  // KRW 기준으로 통일 (calculateRebalance는 순수 KRW 함수)
  const holdings = holdingsRaw.map(h => ({
    name: h.name,
    current_price: h.market === 'US' ? h.usdPrice * rate : h.rawPriceKrw,
    held_quantity: h.qty,
    target_ratio: h.ratio,
    buy_mode: h.buy_mode,
    // 결과 렌더링용 추가 필드
    _market: h.market,
    _usd_price: h.usdPrice,
  }));

  const data = calculateRebalance(
    holdings.map(h => ({
      name: h.name,
      current_price: h.current_price,
      held_quantity: h.held_quantity,
      target_ratio: h.target_ratio,
      buy_mode: h.buy_mode,
    })),
    budget
  );

  // 결과에 통화/시장 정보 병합 (buy_mode는 calculateRebalance에서 이미 포함)
  data.results.forEach((r, i) => {
    r.market = holdings[i]._market;
    r.usd_price = holdings[i]._usd_price;
  });

  renderResult(data, rate);
}


// ========== UI 유틸리티 ==========

function showError(msg) {
  const errorBox = document.getElementById('errorBox');
  document.getElementById('errorMsg').textContent = msg;
  errorBox.style.display = 'block';
  errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}


function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}


// ========== 결과 렌더링 ==========

function fmt(n) {
  return Math.round(n).toLocaleString();
}

/**
 * 수량 표시 포맷 — 매수 방식 및 시장에 따라 소수점 처리
 * qty 모드 KR: 정수, 그 외: 소수 허용 (CRYPTO 최대 8자리, US 최대 6자리)
 */
function formatQtyDisplay(qty, buyMode, market) {
  if (buyMode !== 'amount' && market === 'KR') {
    return Math.round(qty).toLocaleString();
  }
  if (qty === 0) return '0';
  const maxDecimals = market === 'CRYPTO' ? 8 : 6;
  // trailing zero 제거
  return parseFloat(qty.toFixed(maxDecimals)).toString();
}

function renderResult(data, usdKrwRate = null) {
  const section = document.getElementById('resultSection');

  // 요약 카드
  document.getElementById('sumHeld').textContent = `₩${fmt(data.total_held_value)}`;
  document.getElementById('sumBuy').textContent = `₩${fmt(data.total_buy_amount)}`;
  document.getElementById('sumFinal').textContent = `₩${fmt(data.total_final_value)}`;
  document.getElementById('sumRemain').textContent = `₩${fmt(data.budget_remaining)}`;

  // 상세 테이블
  const tbody = document.getElementById('resultBody');
  tbody.innerHTML = '';

  const hasUSResult = data.results.some(r => r.market === 'US');

  data.results.forEach(r => {
    const tr = document.createElement('tr');
    const isZero = r.target_ratio === 0;

    // 현재가 표시: US는 USD, 나머지는 KRW
    const priceDisplay = r.market === 'US'
      ? `$${r.usd_price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `₩${fmt(r.current_price)}`;

    const heldQtyStr = formatQtyDisplay(r.held_quantity, r.buy_mode, r.market);
    const buyQtyStr = formatQtyDisplay(r.buy_quantity, r.buy_mode, r.market);
    const finalQtyStr = formatQtyDisplay(r.final_quantity, r.buy_mode, r.market);

    tr.innerHTML = `
      <td>${r.name}${isZero ? ' <small style="color:var(--text-muted)">(매수 중단)</small>' : ''}</td>
      <td>${priceDisplay}</td>
      <td>${heldQtyStr}</td>
      <td>${r.current_ratio.toFixed(1)}%</td>
      <td class="highlight-cell">${r.buy_quantity > 0 ? '+' + buyQtyStr : '0'}</td>
      <td class="highlight-cell">${r.buy_amount > 0 ? '₩' + fmt(r.buy_amount) : '-'}</td>
      <td>${finalQtyStr}</td>
      <td>${r.final_ratio.toFixed(1)}%</td>
      <td class="${isZero ? 'zero-ratio' : ''}">${r.target_ratio.toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  });

  // 환율 각주 (US 자산이 있을 때)
  let rateNote = document.getElementById('rateNote');
  if (!rateNote) {
    rateNote = document.createElement('p');
    rateNote.id = 'rateNote';
    rateNote.className = 'rate-note';
    document.getElementById('resultTable').after(rateNote);
  }
  if (hasUSResult && usdKrwRate) {
    rateNote.textContent = `* 미국 주식 가격은 1 USD = ₩${Math.round(usdKrwRate).toLocaleString()} 기준으로 환산되었습니다.`;
    rateNote.style.display = 'block';
  } else {
    rateNote.style.display = 'none';
  }

  // 비율 비교 차트
  renderChart(data.results);

  section.style.display = 'block';
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


function renderChart(results) {
  const area = document.getElementById('chartArea');
  area.innerHTML = '';

  const maxRatio = Math.max(...results.map(r => Math.max(r.target_ratio, r.final_ratio)), 1);

  results.forEach(r => {
    const row = document.createElement('div');
    row.className = 'chart-row';

    const targetW = (r.target_ratio / maxRatio * 100).toFixed(1);
    const actualW = (r.final_ratio / maxRatio * 100).toFixed(1);

    row.innerHTML = `
      <span class="chart-label">${r.name}</span>
      <div class="chart-bars">
        <div class="chart-bar target" style="width: 0%;" data-width="${targetW}%"></div>
        <div class="chart-bar actual" style="width: 0%;" data-width="${actualW}%"></div>
      </div>
      <span class="chart-pct">${r.final_ratio.toFixed(1)}%</span>
    `;

    area.appendChild(row);
  });

  // 레전드
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  legend.innerHTML = `
    <div class="chart-legend-item"><div class="chart-legend-dot target"></div>목표 비율</div>
    <div class="chart-legend-item"><div class="chart-legend-dot actual"></div>매수 후 비율</div>
  `;
  area.appendChild(legend);

  // 바 애니메이션
  requestAnimationFrame(() => {
    setTimeout(() => {
      area.querySelectorAll('.chart-bar').forEach(bar => {
        bar.style.width = bar.dataset.width;
      });
    }, 50);
  });
}
