/**
 * ETF 리밸런싱 계산기 — 프론트엔드 로직 (Fully Client-Side)
 *
 * [아키텍처]
 * 모든 계산/데이터 관리는 브라우저에서 수행됩니다.
 * 현재가/환율/과거 가격 조회만 서버 CORS 프록시 API를 사용하며,
 * 여러 사용자가 각자의 JSON을 업로드해 독립적으로 사용할 수 있습니다.
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

// 동적 목표비중 계산 상태
let dynamicHistoryCache = new Map();
let dynamicUpdateTimer = null;
let dynamicCalculationSeq = 0;
let lastDynamicAllocation = null;

const CACHE_TTL_MS = 600_000;

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
    tickerPattern: /^(?=.*[A-Za-z0-9])[A-Za-z0-9.\-=^]{1,10}$/,
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

const ASSET_TYPES = Object.freeze({
  GLOBAL_EQUITY: 'VT',
  US_SP500: 'S&P500',
  US_NASDAQ100: 'Nasdaq100',
  KR_KOSPI200: 'KOSPI200',
  KR_KRX300: 'KRX300',
  CASH_KRW: '현금성 자산',
  OTHER: '기타',
});

const RISK_ASSET_TYPES = new Set([
  'GLOBAL_EQUITY',
  'US_SP500',
  'US_NASDAQ100',
  'KR_KOSPI200',
  'KR_KRX300',
]);

const METHOD_LABELS = Object.freeze({
  volatility_targeting: '변동성 목표화',
  mean_variance_merton: '평균-분산·머튼',
  var_es_risk_budget: 'VaR·ES 위험예산',
  cppi_floor: 'CPPI·손실한도',
});

// 기본 ETF 프리셋 — JSON 업로드 전 초기 상태
const PRESETS = [
  { name: 'KODEX 200',           ticker: '069500', price: '', qty: '', ratio: '40', market: 'KR' },
  { name: 'TIGER 미국S&P500',    ticker: '143850', price: '', qty: '', ratio: '30', market: 'KR' },
  { name: 'KODEX 미국나스닥100', ticker: '379800', price: '', qty: '', ratio: '20', market: 'KR' },
  { name: 'TIGER 단기채권',      ticker: '157450', price: '', qty: '', ratio: '10', market: 'KR' },
];


// ========== 초기화 ==========

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    PRESETS.forEach(p => addETFRow(p));

    document.getElementById('addBtn').addEventListener('click', () => addETFRow());
    document.getElementById('calcBtn').addEventListener('click', calculate);

    // 예산 입력 — 숫자 포맷팅 (콤마 자동 삽입)
    const budgetInput = document.getElementById('budget');
    budgetInput.addEventListener('input', (e) => {
      const raw = e.target.value.replace(/[^\d]/g, '');
      e.target.value = raw ? Number(raw).toLocaleString() : '';
      scheduleDynamicAllocationUpdate();
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

    initDynamicAllocationPanel();
    updateRatioBadge();
    scheduleDynamicAllocationUpdate();
  });
}


// ========== ETF 행 관리 ==========

function assetTypeOptionsHtml(selectedType) {
  return Object.entries(ASSET_TYPES).map(([value, label]) => (
    `<option value="${value}" ${selectedType === value ? 'selected' : ''}>${label}</option>`
  )).join('');
}


function normalizeMarket(value, fallback = 'KR') {
  return Object.hasOwn(MARKET_CONFIG, value) ? value : fallback;
}


function normalizeAssetType(value, fallback = 'OTHER') {
  return Object.hasOwn(ASSET_TYPES, value) ? value : fallback;
}


function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}


function sanitizeDecimalString(value) {
  let raw = stringValue(value).replace(/[^\d.]/g, '');
  const dotIdx = raw.indexOf('.');
  if (dotIdx !== -1) {
    raw = raw.slice(0, dotIdx + 1) + raw.slice(dotIdx + 1).replace(/\./g, '');
  }
  return raw;
}


function sanitizeIntegerString(value) {
  return stringValue(value).replace(/[^\d]/g, '');
}


function normalizeImportedPrice(value, market) {
  if (market === 'US') return sanitizeDecimalString(value);

  const digits = sanitizeIntegerString(value);
  return digits ? Number(digits).toLocaleString() : '';
}


function includesAny(text, keywords) {
  return keywords.some(keyword => text.includes(keyword));
}


function inferAssetType(name, ticker, market) {
  const text = `${name} ${ticker}`.toUpperCase().replace(/\s+/g, '');

  if (ticker.toUpperCase() === 'VT' || includesAny(text, ['VT', '전세계', '글로벌'])) {
    return 'GLOBAL_EQUITY';
  }
  if (includesAny(text, ['S&P500', 'SP500', 'SNP500', '에스앤피500', '미국S&P'])) {
    return 'US_SP500';
  }
  if (includesAny(text, ['NASDAQ100', '나스닥100', 'QQQ'])) {
    return 'US_NASDAQ100';
  }
  if (includesAny(text, ['KRX300'])) {
    return 'KR_KRX300';
  }
  if (includesAny(text, ['KOSPI200', '코스피200', 'KODEX200', 'TIGER200', '069500'])) {
    return 'KR_KOSPI200';
  }
  if (includesAny(text, ['단기', 'MMF', 'CD', 'KOFR', '통안', '현금', 'CASH', 'MONEY'])) {
    return 'CASH_KRW';
  }
  if (market === 'CRYPTO') {
    return 'OTHER';
  }
  return 'OTHER';
}


function updateInferredAssetType(row) {
  const select = row.querySelector('[data-field="asset_type"]');
  if (!select || select.dataset.manual === 'true') return;

  const name = row.querySelector('[data-field="name"]')?.value.trim() || '';
  const ticker = row.querySelector('[data-field="ticker"]')?.value.trim() || '';
  const market = row.querySelector('[data-field="market"]')?.value || 'KR';
  select.value = inferAssetType(name, ticker, market);
}

function addETFRow(preset = null) {
  const id = nextId++;
  const row = { id };
  etfRows.push(row);

  const list = document.getElementById('etfList');
  const el = document.createElement('div');
  el.className = 'etf-row';
  el.dataset.id = id;

  const isMobile = window.innerWidth <= 768;
  const market = normalizeMarket(preset?.market);
  const cfg = MARKET_CONFIG[market];
  const initBuyMode = preset?.buy_mode === 'amount'
    ? 'amount'
    : (market === 'CRYPTO' ? 'amount' : 'qty');
  const inferredAssetType = inferAssetType(
    stringValue(preset?.name),
    stringValue(preset?.ticker),
    market
  );
  const initialAssetType = normalizeAssetType(preset?.asset_type, inferredAssetType);
  const initialAssetTypeManual = preset?.asset_type_manual ?? Boolean(preset?.asset_type);
  const initialSleeveWeight = sanitizeDecimalString(preset?.sleeve_weight);
  const initialName = escapeHtml(stringValue(preset?.name));
  const initialTicker = escapeHtml(stringValue(preset?.ticker));
  const initialPrice = escapeHtml(stringValue(preset?.price));
  const initialQty = escapeHtml(stringValue(preset?.qty));
  const initialRatio = escapeHtml(stringValue(preset?.ratio));
  const initialSleeveWeightHtml = escapeHtml(initialSleeveWeight);

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
             placeholder="ETF 이름" value="${initialName}" autocomplete="off">
    </div>
    <div class="input-group">
      ${isMobile ? '<label>종목코드</label>' : ''}
      <input type="text" class="input mono" data-field="ticker"
             placeholder="${cfg.tickerPlaceholder}" value="${initialTicker}"
             maxlength="${cfg.tickerMaxLength}" inputmode="text" autocomplete="off">
    </div>
    <div class="input-group">
      ${isMobile ? '<label>현재가</label>' : ''}
      <input type="text" class="input mono" data-field="price"
             placeholder="0" value="${initialPrice}" inputmode="${market === 'US' ? 'decimal' : 'numeric'}" autocomplete="off">
    </div>
    <div class="input-group">
      ${isMobile ? '<label>보유 수량</label>' : ''}
      <div class="qty-with-mode">
        <input type="text" class="input mono" data-field="qty"
               placeholder="0" value="${initialQty}"
               inputmode="${market === 'KR' && initBuyMode === 'qty' ? 'numeric' : 'decimal'}" autocomplete="off">
        <button class="btn-buy-mode" type="button" data-buy-mode="${initBuyMode}"
                title="매수 방식 전환 (주=수량 기준 / 원=금액 기준)">${initBuyMode === 'amount' ? '원' : '주'}</button>
      </div>
    </div>
    <div class="input-group">
      ${isMobile ? '<label>목표 비율(%)</label>' : ''}
      <div class="ratio-with-type">
        <input type="text" class="input mono" data-field="ratio"
                placeholder="0" value="${initialRatio}" inputmode="decimal" autocomplete="off">
        <select class="input asset-type-select" data-field="asset_type" data-manual="${initialAssetTypeManual}">
          ${assetTypeOptionsHtml(initialAssetType)}
        </select>
        <input type="text" class="input mono sleeve-input" data-field="sleeve_weight"
                placeholder="하위%" value="${initialSleeveWeightHtml}" inputmode="decimal" autocomplete="off">
      </div>
    </div>
    <button class="btn btn-delete" type="button" title="삭제">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  `;

  const priceInput = el.querySelector('[data-field="price"]');
  const nameInput = el.querySelector('[data-field="name"]');
  const tickerInput = el.querySelector('[data-field="ticker"]');
  const marketSelect = el.querySelector('[data-field="market"]');
  const buyModeBtn = el.querySelector('.btn-buy-mode');
  const qtyInput = el.querySelector('[data-field="qty"]');
  const ratioInput = el.querySelector('[data-field="ratio"]');
  const assetTypeSelect = el.querySelector('[data-field="asset_type"]');
  const sleeveInput = el.querySelector('[data-field="sleeve_weight"]');

  // USD 가격은 dataset에 원시값 보관 (소수점 있는 형태)
  if (market === 'US' && preset?.price) {
    priceInput.dataset.usdPrice = sanitizeDecimalString(preset.price);
  }

  const requestPriceForCurrentRow = (ticker, requestedMarket) => fetchPrice(
    ticker,
    requestedMarket,
    priceInput,
    () => marketSelect.value === requestedMarket && tickerInput.value.trim() === ticker
  );

  // 매수 방식 토글 (주=수량 기준, 원=금액 기준)
  buyModeBtn.addEventListener('click', () => {
    const next = buyModeBtn.dataset.buyMode === 'qty' ? 'amount' : 'qty';
    buyModeBtn.dataset.buyMode = next;
    buyModeBtn.textContent = next === 'amount' ? '원' : '주';
    qtyInput.inputMode = marketSelect.value === 'KR' && next === 'qty' ? 'numeric' : 'decimal';
    scheduleDynamicAllocationUpdate();
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
    scheduleDynamicAllocationUpdate();
  });

  // 삭제 버튼 — 부드러운 페이드아웃 후 DOM에서 제거
  el.querySelector('.btn-delete').addEventListener('click', () => {
    etfRows = etfRows.filter(r => r.id !== id);
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => {
      el.remove();
      scheduleDynamicAllocationUpdate();
    }, 150);
    updateRatioBadge();
  });

  // 시장 변경 — placeholder/maxlength 갱신 및 티커 재검증 후 재조회
  marketSelect.addEventListener('change', () => {
    const newMarket = normalizeMarket(marketSelect.value);
    const newCfg = MARKET_CONFIG[newMarket];
    invalidatePriceRequest(priceInput);
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
      requestPriceForCurrentRow(ticker, newMarket);
    }
    updateInferredAssetType(el);
    scheduleDynamicAllocationUpdate();
  });

  // 종목코드 입력 시 현재가 자동 조회 (debounce 600ms)
  let debounceTimer;
  tickerInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const currentMarket = marketSelect.value;
    invalidatePriceRequest(priceInput);
    updateInferredAssetType(el);
    scheduleDynamicAllocationUpdate();
    debounceTimer = setTimeout(
      () => requestPriceForCurrentRow(e.target.value.trim(), currentMarket),
      600
    );
  });

  nameInput.addEventListener('input', () => {
    updateInferredAssetType(el);
    scheduleDynamicAllocationUpdate();
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
    scheduleDynamicAllocationUpdate();
  });

  // 비율 변경 시 상단 배지 실시간 업데이트
  ratioInput.addEventListener('input', () => {
    updateRatioBadge();
    scheduleDynamicAllocationUpdate();
  });

  assetTypeSelect.addEventListener('change', () => {
    assetTypeSelect.dataset.manual = 'true';
    scheduleDynamicAllocationUpdate();
  });

  sleeveInput.addEventListener('input', (e) => {
    let raw = e.target.value.replace(/[^\d.]/g, '');
    const dotIdx = raw.indexOf('.');
    if (dotIdx !== -1) {
      raw = raw.slice(0, dotIdx + 1) + raw.slice(dotIdx + 1).replace(/\./g, '');
    }
    e.target.value = raw;
    scheduleDynamicAllocationUpdate();
  });

  list.appendChild(el);
  scheduleDynamicAllocationUpdate();
  return el;
}


// ========== 환율 조회 ==========

async function fetchExchangeRate() {
  if (usdKrwRate && rateFetchedAt && (Date.now() - rateFetchedAt) < CACHE_TTL_MS) {
    return usdKrwRate;
  }
  const res = await fetch('/api/rate/USDKRW');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || '환율 조회 실패');
  }
  const data = await res.json();
  const rate = Number(data.rate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('환율 응답값이 올바르지 않습니다');
  }
  usdKrwRate = rate;
  rateFetchedAt = Date.now();
  return usdKrwRate;
}


// ========== 현재가 자동 조회 ==========

function invalidatePriceRequest(priceInput) {
  const currentSeq = Number(priceInput.dataset.priceRequestSeq || '0');
  priceInput.dataset.priceRequestSeq = String(currentSeq + 1);
  priceInput.classList.remove('loading');
  if (priceInput.placeholder === '조회 중...') priceInput.placeholder = '0';
}


async function fetchPrice(ticker, market, priceInput, isCurrent = null) {
  const cfg = MARKET_CONFIG[market];
  if (!cfg?.tickerPattern.test(ticker)) return;

  const requestSeq = Number(priceInput.dataset.priceRequestSeq || '0') + 1;
  priceInput.dataset.priceRequestSeq = String(requestSeq);
  const isLatestRequest = () => (
    priceInput.dataset.priceRequestSeq === String(requestSeq)
    && (!isCurrent || isCurrent())
  );

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
    if (!isLatestRequest()) return;

    const price = Number(data.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('현재가 응답값이 올바르지 않습니다');
    }

    if (market === 'US') {
      const usdPrice = price;
      priceInput.dataset.usdPrice = String(usdPrice);
      priceInput.value = usdPrice.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } else {
      priceInput.dataset.usdPrice = '';
      priceInput.value = Math.round(price).toLocaleString();
    }
    scheduleDynamicAllocationUpdate();
  } catch (err) {
    if (!isLatestRequest()) return;
    showToast(`현재가 조회 실패: ${err.message}`);
  } finally {
    if (priceInput.dataset.priceRequestSeq === String(requestSeq)) {
      priceInput.classList.remove('loading');
      priceInput.placeholder = prevPlaceholder;
    }
  }
}


// ========== 전체 현재가 갱신 ==========

async function refreshAllPrices() {
  const btn = document.getElementById('btnRefreshPrices');
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }

  await Promise.allSettled(
    Array.from(document.querySelectorAll('.etf-row')).map(row => {
      const ticker = row.querySelector('[data-field="ticker"]')?.value.trim();
      const market = row.querySelector('[data-field="market"]')?.value;
      const priceInput = row.querySelector('[data-field="price"]');
      if (!ticker || !market || !priceInput) return Promise.resolve();
      if (!MARKET_CONFIG[market]?.tickerPattern.test(ticker)) return Promise.resolve();
      return fetchPrice(
        ticker,
        market,
        priceInput,
        () => row.querySelector('[data-field="market"]')?.value === market
          && row.querySelector('[data-field="ticker"]')?.value.trim() === ticker
      );
    })
  );

  if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
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


// ========== 동적 목표비중 ==========

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}


function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function parseNumericInput(id, fallback) {
  const el = document.getElementById(id);
  const value = Number(el?.value ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}


function parsePercentInput(id, fallbackPercent) {
  return parseNumericInput(id, fallbackPercent) / 100;
}


function parseFormattedNumber(value) {
  return Number(String(value || '').replace(/[^\d.]/g, '')) || 0;
}


function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(digits)}%`;
}


function formatPercentNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(digits)}%`;
}


function formatRatioInput(value) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return parseFloat(value.toFixed(2)).toString();
}


function initDynamicAllocationPanel() {
  const card = document.getElementById('dynamicAllocationCard');
  if (!card) return;

  card.addEventListener('input', (e) => {
    if (!e.target.matches('input')) return;
    if (e.target.id === 'dynamicHighWaterMark') {
      const raw = e.target.value.replace(/[^\d]/g, '');
      e.target.value = raw ? Number(raw).toLocaleString() : '';
    }
    if (e.target.id === 'dynamicSignalTicker') {
      e.target.value = e.target.value.toUpperCase();
    }
    scheduleDynamicAllocationUpdate();
  });

  card.addEventListener('change', (e) => {
    if (!e.target.matches('input, select')) return;
    if (e.target.id === 'dynamicMethod') {
      updateDynamicMethodFields();
    }
    if (e.target.id === 'dynamicFloorMode') {
      updateDynamicFloorFields();
    }
    if (e.target.id === 'dynamicAutoApply' && e.target.checked) {
      showToast('자동 적용이 켜졌습니다. 계산값을 적용 전 확인하세요.');
    }
    scheduleDynamicAllocationUpdate();
  });

  document.getElementById('dynamicRefreshHistory')?.addEventListener('click', () => {
    dynamicHistoryCache = new Map();
    calculateAndRenderDynamicAllocation({ forceHistory: true });
  });
  document.getElementById('dynamicApplyTarget')?.addEventListener('click', () => {
    applyDynamicAllocation();
  });

  updateDynamicMethodFields();
}


function updateDynamicMethodFields() {
  const method = document.getElementById('dynamicMethod')?.value || 'volatility_targeting';
  syncDynamicMinDefault(method);

  document.querySelectorAll('[data-method-fields]').forEach(group => {
    group.hidden = group.dataset.methodFields !== method;
  });
  document.querySelectorAll('.history-only').forEach(group => {
    group.hidden = method === 'cppi_floor';
  });
  updateDynamicFloorFields();
}


function syncDynamicMinDefault(method) {
  const minInput = document.getElementById('dynamicMinRiskWeight');
  if (!minInput) return;

  const previousMethod = minInput.dataset.methodDefault || 'volatility_targeting';
  if (method === previousMethod) return;

  if (method === 'cppi_floor' && minInput.value === '20') {
    minInput.value = '0';
  } else if (previousMethod === 'cppi_floor' && minInput.value === '0') {
    minInput.value = '20';
  }
  minInput.dataset.methodDefault = method;
}


function updateDynamicFloorFields() {
  const floorMode = document.getElementById('dynamicFloorMode')?.value || 'current';
  document.querySelectorAll('[data-floor-field]').forEach(field => {
    field.hidden = field.dataset.floorField !== floorMode;
  });
}


function scheduleDynamicAllocationUpdate() {
  if (!document.getElementById('dynamicAllocationCard')) return;
  clearTimeout(dynamicUpdateTimer);
  dynamicUpdateTimer = setTimeout(() => calculateAndRenderDynamicAllocation(), 300);
}


function readDynamicAllocationConfig() {
  return {
    method: document.getElementById('dynamicMethod')?.value || 'volatility_targeting',
    signalTicker: document.getElementById('dynamicSignalTicker')?.value.trim().toUpperCase() || 'VT',
    historyRange: document.getElementById('dynamicHistoryRange')?.value || '1y',
    lookbackDays: Math.max(1, Math.round(parseNumericInput('dynamicLookbackDays', 60))),
    targetVol: parsePercentInput('dynamicTargetVol', 10),
    minRiskWeight: parsePercentInput('dynamicMinRiskWeight', 20),
    maxRiskWeight: parsePercentInput('dynamicMaxRiskWeight', 100),
    expectedReturn: parsePercentInput('dynamicExpectedReturn', 7),
    cashReturn: parsePercentInput('dynamicCashReturn', 3),
    riskAversion: Math.max(0, parseNumericInput('dynamicRiskAversion', 4)),
    riskMetric: document.getElementById('dynamicRiskMetric')?.value || 'historical_var',
    confidenceLevel: parseNumericInput('dynamicConfidenceLevel', 0.95),
    riskHorizonDays: Math.max(1, Math.round(parseNumericInput('dynamicRiskHorizonDays', 21))),
    riskBudget: parsePercentInput('dynamicRiskBudget', 5),
    floorMode: document.getElementById('dynamicFloorMode')?.value || 'current',
    floorRatio: parsePercentInput('dynamicFloorRatio', 80),
    maxDrawdown: parsePercentInput('dynamicMaxDrawdown', 20),
    highWaterMark: parseFormattedNumber(document.getElementById('dynamicHighWaterMark')?.value),
    multiplier: Math.max(0, parseNumericInput('dynamicMultiplier', 3)),
  };
}


function restoreDynamicAllocationConfig(config) {
  if (!config) return;
  const valueMap = {
    dynamicMethod: config.method,
    dynamicSignalTicker: config.signal_ticker,
    dynamicHistoryRange: config.history_range,
    dynamicLookbackDays: config.lookback_days,
    dynamicTargetVol: config.target_vol,
    dynamicMinRiskWeight: config.min_risk_weight,
    dynamicMaxRiskWeight: config.max_risk_weight,
    dynamicExpectedReturn: config.expected_return,
    dynamicCashReturn: config.cash_return,
    dynamicRiskAversion: config.risk_aversion,
    dynamicRiskMetric: config.risk_metric,
    dynamicConfidenceLevel: config.confidence_level,
    dynamicRiskHorizonDays: config.risk_horizon_days,
    dynamicRiskBudget: config.risk_budget,
    dynamicFloorMode: config.floor_mode,
    dynamicFloorRatio: config.floor_ratio,
    dynamicMaxDrawdown: config.max_drawdown,
    dynamicMultiplier: config.multiplier,
  };

  for (const [id, value] of Object.entries(valueMap)) {
    const el = document.getElementById(id);
    if (el && value !== undefined && value !== null) {
      el.value = String(value);
    }
  }

  const highWaterMark = document.getElementById('dynamicHighWaterMark');
  if (highWaterMark && Object.hasOwn(config, 'high_water_mark')) {
    const highWaterMarkValue = sanitizeIntegerString(config.high_water_mark);
    highWaterMark.value = highWaterMarkValue ? Number(highWaterMarkValue).toLocaleString() : '';
  }
  const autoApply = document.getElementById('dynamicAutoApply');
  if (autoApply) {
    autoApply.checked = Boolean(config.auto_apply);
  }

  updateDynamicMethodFields();
}


function exportDynamicAllocationConfig() {
  const config = readDynamicAllocationConfig();
  return {
    method: config.method,
    signal_ticker: config.signalTicker,
    history_range: config.historyRange,
    lookback_days: config.lookbackDays,
    target_vol: config.targetVol * 100,
    min_risk_weight: config.minRiskWeight * 100,
    max_risk_weight: config.maxRiskWeight * 100,
    expected_return: config.expectedReturn * 100,
    cash_return: config.cashReturn * 100,
    risk_aversion: config.riskAversion,
    risk_metric: config.riskMetric,
    confidence_level: config.confidenceLevel,
    risk_horizon_days: config.riskHorizonDays,
    risk_budget: config.riskBudget * 100,
    floor_mode: config.floorMode,
    floor_ratio: config.floorRatio * 100,
    max_drawdown: config.maxDrawdown * 100,
    high_water_mark: config.highWaterMark,
    multiplier: config.multiplier,
    auto_apply: document.getElementById('dynamicAutoApply')?.checked || false,
  };
}


async function fetchPriceHistory(ticker, range, forceHistory = false) {
  const key = `${ticker}|${range}|1d`;
  const cached = dynamicHistoryCache.get(key);
  if (!forceHistory && cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.data;
  }

  const res = await fetch(
    `/api/history/${encodeURIComponent(ticker)}?market=US&range=${range}&interval=1d`
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || '과거 가격 데이터를 불러오지 못했습니다.');
  }

  const data = await res.json();
  dynamicHistoryCache.set(key, { data, fetchedAt: Date.now() });
  return data;
}


function getClosePrices(historyData) {
  return (historyData.points || [])
    .map(point => Number(point.close))
    .filter(close => Number.isFinite(close) && close > 0);
}


function calculateAnnualizedVol(closes, lookbackDays) {
  const required = lookbackDays + 1;
  if (closes.length < required) {
    return {
      valid: false,
      warning: `과거 가격 데이터가 부족합니다. 최소 ${required}개 종가가 필요하지만 현재 ${closes.length}개입니다.`,
    };
  }

  const recent = closes.slice(-required);
  const returns = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push(Math.log(recent[i] / recent[i - 1]));
  }
  if (returns.length < 2) {
    return { valid: false, warning: '실현 변동성을 계산할 수 있는 수익률 표본이 부족합니다.' };
  }

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const annualizedVol = Math.sqrt(variance) * Math.sqrt(252);

  if (!Number.isFinite(annualizedVol) || annualizedVol <= 0) {
    return { valid: false, warning: '실현 변동성이 0이거나 유효하지 않습니다.' };
  }

  return { valid: true, annualizedVol, returnsCount: returns.length };
}


function calculateRollingPeriodReturns(closes, lookbackDays, horizonDays) {
  const recent = closes.slice(-(lookbackDays + horizonDays));
  const returns = [];
  for (let i = horizonDays; i < recent.length; i++) {
    const start = recent[i - horizonDays];
    const end = recent[i];
    if (start > 0 && end > 0) {
      returns.push(end / start - 1);
    }
  }
  return returns;
}


function quantile(values, probability) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(probability, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}


function invalidDynamicResult(config, warnings, metrics = []) {
  return {
    method_id: config.method,
    risk_weight: null,
    cash_weight: null,
    metrics,
    warnings,
    valid: false,
  };
}


function validateDynamicAllocationConfig(config) {
  const errors = [];
  const isPercent = value => Number.isFinite(value) && value >= 0 && value <= 1;

  if (!isPercent(config.minRiskWeight)) {
    errors.push('위험자산 최소 비중은 0% 이상 100% 이하이어야 합니다.');
  }
  if (!isPercent(config.maxRiskWeight)) {
    errors.push('위험자산 최대 비중은 0% 이상 100% 이하이어야 합니다.');
  }
  if (config.minRiskWeight > config.maxRiskWeight) {
    errors.push('위험자산 최소 비중은 최대 비중보다 작거나 같아야 합니다.');
  }
  if (!Number.isFinite(config.lookbackDays) || config.lookbackDays < 1 || config.lookbackDays > 756) {
    errors.push('계산 기간은 1~756거래일 범위여야 합니다.');
  }

  if (config.method === 'volatility_targeting' && (!Number.isFinite(config.targetVol) || config.targetVol <= 0)) {
    errors.push('목표 변동성은 0%보다 커야 합니다.');
  }
  if (config.method === 'mean_variance_merton' && (!Number.isFinite(config.riskAversion) || config.riskAversion <= 0)) {
    errors.push('위험회피도 gamma는 0보다 커야 합니다.');
  }
  if (config.method === 'var_es_risk_budget') {
    if (![0.95, 0.99].some(value => Math.abs(value - config.confidenceLevel) < 1e-9)) {
      errors.push('VaR/ES 신뢰수준은 95% 또는 99%만 지원합니다.');
    }
    if (!Number.isFinite(config.riskHorizonDays) || config.riskHorizonDays < 1 || config.riskHorizonDays > 252) {
      errors.push('위험기간은 1~252거래일 범위여야 합니다.');
    }
    if (!Number.isFinite(config.riskBudget) || config.riskBudget <= 0 || config.riskBudget > 1) {
      errors.push('손실 예산은 0% 초과 100% 이하이어야 합니다.');
    }
  }
  if (config.method === 'cppi_floor') {
    if (!isPercent(config.floorRatio)) {
      errors.push('CPPI 보전 비율은 0% 이상 100% 이하이어야 합니다.');
    }
    if (!isPercent(config.maxDrawdown)) {
      errors.push('CPPI 최대 손실한도는 0% 이상 100% 이하이어야 합니다.');
    }
    if (!Number.isFinite(config.multiplier) || config.multiplier < 0 || config.multiplier > 10) {
      errors.push('CPPI 승수는 0 이상 10 이하이어야 합니다.');
    }
  }

  return errors;
}


function validDynamicResult(config, riskWeight, metrics, warnings = []) {
  if (!Number.isFinite(riskWeight)) {
    return invalidDynamicResult(config, ['계산된 위험자산 비중이 유효하지 않습니다.'], metrics);
  }
  const clampedRiskWeight = clamp(riskWeight, config.minRiskWeight, config.maxRiskWeight);
  return {
    method_id: config.method,
    risk_weight: clampedRiskWeight,
    cash_weight: 1 - clampedRiskWeight,
    metrics,
    warnings,
    valid: true,
  };
}


function calculateVolatilityTargetAllocation(config, closes) {
  const stats = calculateAnnualizedVol(closes, config.lookbackDays);
  if (!stats.valid) return invalidDynamicResult(config, [stats.warning]);

  const rawRiskWeight = config.targetVol / stats.annualizedVol;
  return validDynamicResult(config, rawRiskWeight, [
    { label: '실현 변동성', value: formatPercent(stats.annualizedVol) },
    { label: '목표 변동성', value: formatPercent(config.targetVol) },
    { label: '수익률 표본', value: `${stats.returnsCount}개` },
  ], ['최근 변동성은 미래 위험을 보장하지 않는 참고값입니다.']);
}


function calculateMeanVarianceAllocation(config, closes) {
  const stats = calculateAnnualizedVol(closes, config.lookbackDays);
  if (!stats.valid) return invalidDynamicResult(config, [stats.warning]);
  if (config.riskAversion <= 0) {
    return invalidDynamicResult(config, ['위험회피도 gamma는 0보다 커야 합니다.']);
  }

  const variance = stats.annualizedVol ** 2;
  const expectedExcessReturn = config.expectedReturn - config.cashReturn;
  const rawRiskWeight = expectedExcessReturn / (config.riskAversion * variance);
  const warnings = ['기대수익률 추정 오차에 매우 민감한 이론 계산입니다.'];
  if (expectedExcessReturn <= 0) {
    warnings.push('기대초과수익률이 0 이하라 위험자산 비중은 하한값으로 제한됩니다.');
  }

  return validDynamicResult(config, rawRiskWeight, [
    { label: '실현 변동성', value: formatPercent(stats.annualizedVol) },
    { label: '연율 분산', value: formatPercent(variance, 2) },
    { label: '기대초과수익률', value: formatPercent(expectedExcessReturn) },
    { label: '위험회피도 gamma', value: config.riskAversion.toFixed(1) },
  ], warnings);
}


function calculateTailRiskBudgetAllocation(config, closes) {
  const warnings = ['과거 손실 분포는 극단적 시장 상황의 실제 손실을 과소평가할 수 있습니다.'];
  let tailRisk;
  let metricLabel;
  let sampleCount;

  if (config.riskMetric === 'normal_var') {
    const stats = calculateAnnualizedVol(closes, config.lookbackDays);
    if (!stats.valid) return invalidDynamicResult(config, [stats.warning]);

    const zScore = config.confidenceLevel >= 0.99 ? 2.32635 : 1.64485;
    tailRisk = zScore * stats.annualizedVol * Math.sqrt(config.riskHorizonDays / 252);
    metricLabel = 'Normal VaR';
    sampleCount = stats.returnsCount;
  } else {
    const periodReturns = calculateRollingPeriodReturns(
      closes,
      config.lookbackDays,
      config.riskHorizonDays
    );
    if (periodReturns.length < 30) {
      return invalidDynamicResult(config, [
        `표본 수가 부족해 VaR/ES를 계산하지 않았습니다. 최소 30개 rolling return이 필요하지만 현재 ${periodReturns.length}개입니다.`,
      ]);
    }

    const cutoff = quantile(periodReturns, 1 - config.confidenceLevel);
    const historicalVar = Math.max(-cutoff, 0);
    const tailReturns = periodReturns.filter(value => value <= cutoff);
    const historicalEs = (
      tailReturns.reduce((sum, value) => sum + Math.max(-value, 0), 0)
      / Math.max(tailReturns.length, 1)
    );

    tailRisk = config.riskMetric === 'historical_es'
      ? Math.max(historicalEs, historicalVar)
      : historicalVar;
    metricLabel = config.riskMetric === 'historical_es' ? 'Historical ES' : 'Historical VaR';
    sampleCount = periodReturns.length;
  }

  if (!Number.isFinite(tailRisk) || tailRisk <= 0) {
    return invalidDynamicResult(config, ['선택한 손실위험 추정값이 0이거나 유효하지 않습니다.']);
  }

  const rawRiskWeight = config.riskBudget / tailRisk;
  return validDynamicResult(config, rawRiskWeight, [
    { label: metricLabel, value: formatPercent(tailRisk) },
    { label: '손실 예산', value: formatPercent(config.riskBudget) },
    { label: '위험기간', value: `${config.riskHorizonDays}거래일` },
    { label: '표본 수', value: `${sampleCount}개` },
  ], warnings);
}


function parseRowQuantity(row, market, buyMode) {
  const value = row.querySelector('[data-field="qty"]')?.value || '';
  if (market === 'KR' && buyMode === 'qty') {
    return Number(value.replace(/[^\d]/g, '')) || 0;
  }
  return parseFloat(value.replace(/[^\d.]/g, '')) || 0;
}


function parseRowPrice(row, market) {
  const priceInput = row.querySelector('[data-field="price"]');
  if (!priceInput) return 0;
  if (market === 'US') {
    return parseFloat(priceInput.dataset.usdPrice || priceInput.value.replace(/[^\d.]/g, '')) || 0;
  }
  return Number(priceInput.value.replace(/[^\d]/g, '')) || 0;
}


async function calculatePortfolioValueForCppi() {
  const rows = Array.from(document.querySelectorAll('.etf-row'));
  const warnings = [];
  let totalHeld = 0;
  let rate = null;

  for (const row of rows) {
    const market = row.querySelector('[data-field="market"]')?.value || 'KR';
    const buyMode = row.querySelector('.btn-buy-mode')?.dataset.buyMode ?? 'qty';
    const quantity = parseRowQuantity(row, market, buyMode);
    const price = parseRowPrice(row, market);

    if (buyMode === 'amount') {
      totalHeld += quantity;
      continue;
    }
    if (quantity <= 0) continue;
    if (price <= 0) {
      warnings.push('일부 행은 현재가가 없어 CPPI 기준 금액에서 제외했습니다.');
      continue;
    }
    if (market === 'US') {
      try {
        rate ??= await fetchExchangeRate();
        totalHeld += price * rate * quantity;
      } catch (err) {
        warnings.push(`미국 자산 환율 조회 실패로 일부 행을 제외했습니다: ${err.message}`);
      }
    } else {
      totalHeld += price * quantity;
    }
  }

  const budget = Number(document.getElementById('budget').value.replace(/[^\d]/g, '')) || 0;
  return { totalHeld, budget, portfolioValue: totalHeld + budget, warnings };
}


async function calculateCppiAllocation(config) {
  const snapshot = await calculatePortfolioValueForCppi();
  if (snapshot.portfolioValue <= 0) {
    return invalidDynamicResult(config, [
      '포트폴리오 기준 금액이 0원이라 손실한도 방식으로 계산할 수 없습니다.',
    ]);
  }

  let floorValue;
  if (config.floorMode === 'high_water_mark') {
    if (config.highWaterMark <= 0) {
      return invalidDynamicResult(config, ['고점 기준 자산가치를 입력해야 합니다.']);
    }
    floorValue = config.highWaterMark * (1 - config.maxDrawdown);
  } else {
    floorValue = snapshot.portfolioValue * config.floorRatio;
  }

  const cushion = Math.max(snapshot.portfolioValue - floorValue, 0);
  const riskyExposure = config.multiplier * cushion;
  const rawRiskWeight = riskyExposure / snapshot.portfolioValue;

  // CPPI floor protection must not be forced above the formula's risky exposure.
  const cppiConfig = { ...config, minRiskWeight: 0 };
  return validDynamicResult(cppiConfig, rawRiskWeight, [
    { label: '현재 총 보유액', value: `₩${fmt(snapshot.totalHeld)}` },
    { label: '이번 달 예산', value: `₩${fmt(snapshot.budget)}` },
    { label: '포트폴리오 기준 금액', value: `₩${fmt(snapshot.portfolioValue)}` },
    { label: '바닥가치', value: `₩${fmt(floorValue)}` },
    { label: 'cushion', value: `₩${fmt(cushion)}` },
    { label: '승수 적용 위험노출', value: `₩${fmt(riskyExposure)}` },
  ], [
    ...snapshot.warnings,
    '급락장, 체결 지연, 가격 갭은 CPPI 계산에 반영되지 않습니다.',
  ]);
}


async function calculateDynamicAllocation(config, forceHistory = false) {
  const configErrors = validateDynamicAllocationConfig(config);
  if (configErrors.length > 0) return invalidDynamicResult(config, configErrors);

  if (config.method === 'cppi_floor') {
    return calculateCppiAllocation(config);
  }

  if (!MARKET_CONFIG.US.tickerPattern.test(config.signalTicker)) {
    return invalidDynamicResult(config, ['신호 티커는 Yahoo Finance에서 조회 가능한 US 티커 형식이어야 합니다.']);
  }

  const historyData = await fetchPriceHistory(config.signalTicker, config.historyRange, forceHistory);
  const closes = getClosePrices(historyData);

  switch (config.method) {
    case 'mean_variance_merton':
      return calculateMeanVarianceAllocation(config, closes);
    case 'var_es_risk_budget':
      return calculateTailRiskBudgetAllocation(config, closes);
    case 'volatility_targeting':
    default:
      return calculateVolatilityTargetAllocation(config, closes);
  }
}


function collectDynamicRows() {
  return Array.from(document.querySelectorAll('.etf-row')).map(row => {
    const id = row.dataset.id;
    const name = row.querySelector('[data-field="name"]')?.value.trim() || `ETF ${id}`;
    const ticker = row.querySelector('[data-field="ticker"]')?.value.trim() || '';
    const assetType = row.querySelector('[data-field="asset_type"]')?.value || 'OTHER';
    const sleeveRaw = row.querySelector('[data-field="sleeve_weight"]')?.value || '';
    return {
      id,
      name,
      ticker,
      assetType,
      sleeveWeight: parseFloat(sleeveRaw.replace(/[^\d.]/g, '')) || 0,
    };
  });
}


function normalizedSleeveWeights(rows) {
  if (rows.length === 0) return [];
  const customTotal = rows.reduce((sum, row) => sum + Math.max(row.sleeveWeight, 0), 0);
  if (customTotal <= 0) {
    return rows.map(row => ({ row, weight: 1 / rows.length }));
  }
  return rows.map(row => ({ row, weight: Math.max(row.sleeveWeight, 0) / customTotal }));
}


function appendAllocatedRows(previewRows, allocations, rows, totalPercent, status) {
  for (const { row, weight } of normalizedSleeveWeights(rows)) {
    const ratio = totalPercent * weight;
    allocations.set(row.id, ratio);
    previewRows.push({
      name: row.name,
      ticker: row.ticker,
      type: ASSET_TYPES[row.assetType],
      ratio,
      status,
      statusClass: 'ok',
    });
  }
}


function buildDynamicPreview(calculation) {
  const rows = collectDynamicRows();
  const warnings = [...calculation.warnings];
  const previewRows = [];
  const allocations = new Map();
  let canApply = calculation.valid;
  let unallocatedCash = 0;
  let unallocatedRisk = 0;

  if (!calculation.valid) {
    return { rows: previewRows, allocations, warnings, canApply: false, allocatedTotal: 0, unallocatedCash, unallocatedRisk };
  }
  if (rows.length === 0) {
    warnings.push('ETF 목록이 비어 있어 목표비중을 분배할 수 없습니다.');
    return { rows: previewRows, allocations, warnings, canApply: false, allocatedTotal: 0, unallocatedCash, unallocatedRisk };
  }

  const riskPercent = calculation.risk_weight * 100;
  const cashPercent = calculation.cash_weight * 100;
  const riskRows = rows.filter(row => RISK_ASSET_TYPES.has(row.assetType));
  const cashRows = rows.filter(row => row.assetType === 'CASH_KRW');
  const otherRows = rows.filter(row => row.assetType === 'OTHER');

  if (riskPercent > 0.005) {
    if (riskRows.length === 0) {
      unallocatedRisk = riskPercent;
      canApply = false;
      warnings.push(`위험자산 목표비중 ${formatPercentNumber(riskPercent)}를 배정할 자산 유형이 없습니다.`);
      previewRows.push({ name: '미배정 위험자산', type: '위험자산', ratio: riskPercent, status: '미배정', statusClass: 'warn' });
    } else {
      appendAllocatedRows(previewRows, allocations, riskRows, riskPercent, '배정됨');
    }
  }

  if (cashPercent > 0.005) {
    if (cashRows.length === 0) {
      unallocatedCash = cashPercent;
      warnings.push(`현금성 목표비중 ${formatPercentNumber(cashPercent)}가 미배정 상태입니다.`);
      previewRows.push({ name: '미배정 현금성', type: '현금성 자산', ratio: cashPercent, status: '미배정', statusClass: 'warn' });
    } else {
      appendAllocatedRows(previewRows, allocations, cashRows, cashPercent, '배정됨');
    }
  }

  for (const row of otherRows) {
    allocations.set(row.id, 0);
    previewRows.push({
      name: row.name,
      ticker: row.ticker,
      type: ASSET_TYPES.OTHER,
      ratio: 0,
      status: '유형 확인 필요',
      statusClass: 'warn',
    });
  }
  if (otherRows.length > 0) {
    warnings.push('기타 유형 자산은 동적 목표비중에서 0%로 표시됩니다. 유형을 확인하세요.');
  }

  const allocatedTotal = Array.from(allocations.values()).reduce((sum, value) => sum + value, 0);
  if (allocatedTotal <= 0) canApply = false;

  return { rows: previewRows, allocations, warnings, canApply, allocatedTotal, unallocatedCash, unallocatedRisk };
}


function renderDynamicLoading() {
  const status = document.getElementById('dynamicStatus');
  const applyBtn = document.getElementById('dynamicApplyTarget');
  if (status) {
    status.textContent = '계산 중';
    status.className = 'dynamic-status loading';
  }
  if (applyBtn) applyBtn.disabled = true;
}


function renderDynamicError(message) {
  const status = document.getElementById('dynamicStatus');
  if (status) {
    status.textContent = '계산 불가';
    status.className = 'dynamic-status error';
  }
  document.getElementById('dynamicRiskWeight').textContent = '-';
  document.getElementById('dynamicCashWeight').textContent = '-';
  document.getElementById('dynamicMetrics').innerHTML = '';
  document.getElementById('dynamicWarnings').innerHTML = `<div class="dynamic-warning error">${escapeHtml(message)} 기존 리밸런싱 계산은 계속 사용할 수 있습니다.</div>`;
  document.getElementById('dynamicPreviewBody').innerHTML = '';
  document.getElementById('dynamicPreviewTotal').textContent = '배정 합계 0%';
  document.getElementById('dynamicApplyTarget').disabled = true;
  lastDynamicAllocation = null;
}


function renderDynamicAllocation(calculation, preview) {
  const status = document.getElementById('dynamicStatus');
  const applyBtn = document.getElementById('dynamicApplyTarget');
  const riskWeight = document.getElementById('dynamicRiskWeight');
  const cashWeight = document.getElementById('dynamicCashWeight');
  const metrics = document.getElementById('dynamicMetrics');
  const warnings = document.getElementById('dynamicWarnings');
  const previewBody = document.getElementById('dynamicPreviewBody');
  const previewTotal = document.getElementById('dynamicPreviewTotal');

  riskWeight.textContent = calculation.valid ? formatPercent(calculation.risk_weight) : '-';
  cashWeight.textContent = calculation.valid ? formatPercent(calculation.cash_weight) : '-';

  metrics.innerHTML = calculation.metrics.map(metric => `
    <div class="dynamic-metric">
      <span>${escapeHtml(metric.label)}</span>
      <strong>${escapeHtml(metric.value)}</strong>
    </div>
  `).join('');

  warnings.innerHTML = preview.warnings.map(message => `
    <div class="dynamic-warning ${calculation.valid ? '' : 'error'}">${escapeHtml(message)}</div>
  `).join('');

  previewBody.innerHTML = preview.rows.map(row => `
    <div class="dynamic-preview-row ${row.statusClass}">
      <span class="preview-name">${escapeHtml(row.name)}${row.ticker ? ` <small>${escapeHtml(row.ticker)}</small>` : ''}</span>
      <span>${escapeHtml(row.type)}</span>
      <strong>${formatPercentNumber(row.ratio)}</strong>
      <span>${escapeHtml(row.status)}</span>
    </div>
  `).join('') || '<div class="dynamic-empty">목표비중 미리보기를 표시할 수 없습니다.</div>';

  previewTotal.textContent = `배정 합계 ${formatPercentNumber(preview.allocatedTotal)}`;
  if (status) {
    status.textContent = calculation.valid
      ? (preview.warnings.length ? '확인 필요' : '계산 완료')
      : '계산 불가';
    status.className = `dynamic-status ${calculation.valid ? (preview.warnings.length ? 'warn' : 'ok') : 'error'}`;
  }
  if (applyBtn) applyBtn.disabled = !preview.canApply;
}


async function calculateAndRenderDynamicAllocation({ forceHistory = false } = {}) {
  if (!document.getElementById('dynamicAllocationCard')) return;

  const sequence = ++dynamicCalculationSeq;
  renderDynamicLoading();

  try {
    const config = readDynamicAllocationConfig();
    const calculation = await calculateDynamicAllocation(config, forceHistory);
    if (sequence !== dynamicCalculationSeq) return;

    const preview = buildDynamicPreview(calculation);
    lastDynamicAllocation = preview;
    renderDynamicAllocation(calculation, preview);

    const autoApply = document.getElementById('dynamicAutoApply')?.checked;
    if (autoApply && preview.canApply && preview.unallocatedCash <= 0.005 && preview.unallocatedRisk <= 0.005) {
      applyDynamicAllocation({ silent: true, skipConfirm: true });
    }
  } catch (err) {
    if (sequence !== dynamicCalculationSeq) return;
    renderDynamicError(err.message || '동적 목표비중을 계산할 수 없습니다.');
  }
}


function applyDynamicAllocation({ silent = false, skipConfirm = false } = {}) {
  if (!lastDynamicAllocation?.canApply) return;

  if (lastDynamicAllocation.unallocatedCash > 0.005 && !skipConfirm) {
    const ok = confirm(
      `현금성 목표비중 ${formatPercentNumber(lastDynamicAllocation.unallocatedCash)}를 배정할 자산이 없습니다.\n` +
      '이 상태로 적용하면 ETF 목록의 목표 비율 합계가 100%보다 작을 수 있습니다. 계속하시겠습니까?'
    );
    if (!ok) return;
  }

  for (const row of document.querySelectorAll('.etf-row')) {
    const ratioInput = row.querySelector('[data-field="ratio"]');
    const nextRatio = lastDynamicAllocation.allocations.get(row.dataset.id) ?? 0;
    ratioInput.value = formatRatioInput(nextRatio);
  }
  updateRatioBadge();
  if (!silent) showToast('동적 목표비중을 목표 비율에 적용했습니다');
}


// ========== Export / Import (클라이언트 전용) ==========

/**
 * 현재 입력 상태를 JSON 파일로 내보내기 (v3 형식)
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
      asset_type: row.querySelector('[data-field="asset_type"]')?.value || 'OTHER',
      asset_type_manual: row.querySelector('[data-field="asset_type"]')?.dataset.manual === 'true',
      sleeve_weight: row.querySelector('[data-field="sleeve_weight"]')?.value.trim() || '',
    });
  }

  const data = {
    version: 3,
    exported_at: new Date().toISOString(),
    budget,
    dynamic_allocation: exportDynamicAllocationConfig(),
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
 * JSON 파일에서 데이터 불러오기 — v1/v2/v3 형식 지원
 * 브라우저 메모리에만 로드되므로 다른 사용자에게 전혀 영향 없음
 */
function normalizeImportedHolding(holding, isV1, index) {
  if (!holding || typeof holding !== 'object' || Array.isArray(holding)) {
    throw new Error(`${index + 1}번째 보유 항목 형식이 올바르지 않습니다.`);
  }

  const market = isV1 ? 'KR' : normalizeMarket(holding.market, null);
  if (!market) {
    throw new Error(`${index + 1}번째 보유 항목의 시장 값이 올바르지 않습니다.`);
  }

  const buyMode = holding.buy_mode === 'amount'
    ? 'amount'
    : (market === 'CRYPTO' ? 'amount' : 'qty');
  const ratio = sanitizeDecimalString(holding.ratio);

  return {
    name: stringValue(holding.name).trim(),
    ticker: stringValue(holding.ticker).trim(),
    market,
    price: normalizeImportedPrice(holding.price, market),
    qty: buyMode === 'qty' && market === 'KR'
      ? sanitizeIntegerString(holding.qty)
      : sanitizeDecimalString(holding.qty),
    ratio: ratio || '0',
    buy_mode: buyMode,
    asset_type: normalizeAssetType(holding.asset_type, null),
    asset_type_manual: holding.asset_type_manual === true,
    sleeve_weight: sanitizeDecimalString(holding.sleeve_weight),
  };
}


function importData(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const data = JSON.parse(evt.target.result);

      if (!data || typeof data !== 'object' || !Array.isArray(data.holdings)) {
        showError('올바르지 않은 파일 형식입니다.');
        return;
      }

      const isV1 = !data.version || data.version === 1;
      const importedHoldings = data.holdings.map((holding, index) => (
        normalizeImportedHolding(holding, isV1, index)
      ));

      // 예산 복원
      if (Object.hasOwn(data, 'budget')) {
        const budgetInput = document.getElementById('budget');
        const budget = sanitizeIntegerString(data.budget);
        budgetInput.value = budget ? Number(budget).toLocaleString() : '';
      }

      // 기존 ETF 행 제거 후 새로 로드
      document.getElementById('etfList').innerHTML = '';
      etfRows = [];
      nextId = 0;

      for (const h of importedHoldings) {
        addETFRow({
          name:     h.name,
          ticker:   h.ticker,
          market:   h.market,
          price:    h.price,
          qty:      h.qty,
          ratio:    h.ratio,
          buy_mode: h.buy_mode,
          asset_type: h.asset_type,
          asset_type_manual: h.asset_type_manual,
          sleeve_weight: h.sleeve_weight,
        });
      }

      restoreDynamicAllocationConfig(data.dynamic_allocation);
      updateRatioBadge();
      scheduleDynamicAllocationUpdate();

      const msg = isV1
        ? `${data.holdings.length}개 데이터를 불러왔습니다 (v1 → KR 시장 자동 적용)`
        : `${data.holdings.length}개 데이터를 불러왔습니다`;
      showToast(msg);

    } catch (err) {
      showError(err.message || '파일을 읽는 중 오류가 발생했습니다.');
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
  // amount 모드: held_quantity 자체가 KRW 금액이므로 price를 곱하지 않음
  const totalHeld = holdings.reduce(
    (sum, h) => sum + (h.buy_mode === 'amount' ? h.held_quantity : h.current_price * h.held_quantity), 0
  );

  // 목표 총 자산 (현재 보유 + 이번 달 예산)
  const targetTotal = totalHeld + budget;

  let totalBuy = 0;
  const results = holdings.map(h => {
    // amount 모드: held_quantity가 이미 KRW 금액
    const heldValue = h.buy_mode === 'amount'
      ? h.held_quantity
      : h.current_price * h.held_quantity;
    // 결과 표시를 주 단위로 통일하기 위해 KRW → 주 변환
    const heldShares = (h.buy_mode === 'amount' && h.current_price > 0)
      ? h.held_quantity / h.current_price
      : h.held_quantity;

    const targetValue = targetTotal * (h.target_ratio / 100);
    const gap = targetValue - heldValue;

    // 매수 수량 계산 (최소 0, 항상 주 단위)
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
      held_quantity: heldShares,
      held_value: heldValue,
      target_ratio: h.target_ratio,
      current_ratio: totalHeld > 0 ? (heldValue / totalHeld * 100) : 0,
      buy_quantity: buyQty,
      buy_amount: buyAmount,
      final_quantity: heldShares + buyQty,
      final_value: (heldShares + buyQty) * h.current_price,
      final_ratio: 0, // 남은 예산을 현금으로 포함한 총자산 기준
      final_ratio_invested_only: 0,
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

  // 최종 비율 계산: 목표 비교용은 남은 예산을 현금으로 포함한 총자산 기준입니다.
  const totalFinalInvested = results.reduce((sum, r) => sum + r.final_value, 0);
  const totalFinalIncludingCash = totalHeld + budget;
  for (const r of results) {
    r.final_ratio = totalFinalIncludingCash > 0
      ? (r.final_value / totalFinalIncludingCash * 100)
      : 0;
    r.final_ratio_invested_only = totalFinalInvested > 0
      ? (r.final_value / totalFinalInvested * 100)
      : 0;
  }

  return {
    results,
    total_held_value: totalHeld,
    total_buy_amount: totalBuy,
    total_final_value: totalFinalInvested,
    total_final_with_cash: totalFinalIncludingCash,
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

  await refreshAllPrices();

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
  document.getElementById('sumFinal').textContent = `₩${fmt(data.total_final_with_cash)}`;
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
    const finalRatioTitle = `투자자산 기준 ${r.final_ratio_invested_only.toFixed(1)}%`;

    tr.innerHTML = `
      <td>${escapeHtml(r.name)}${isZero ? ' <small style="color:var(--text-muted)">(매수 중단)</small>' : ''}</td>
      <td>${priceDisplay}</td>
      <td>${heldQtyStr}</td>
      <td>${r.current_ratio.toFixed(1)}%</td>
      <td class="highlight-cell">${r.buy_quantity > 0 ? '+' + buyQtyStr : '0'}</td>
      <td class="highlight-cell">${r.buy_amount > 0 ? '₩' + fmt(r.buy_amount) : '-'}</td>
      <td>${finalQtyStr}</td>
      <td title="${finalRatioTitle}">${r.final_ratio.toFixed(1)}%</td>
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
    rateNote.textContent = `* 미국 주식 가격은 1 USD = ₩${Math.round(usdKrwRate).toLocaleString()} 기준으로 환산되었습니다. 최종 비율은 남은 예산을 현금으로 포함한 총자산 기준입니다.`;
    rateNote.style.display = 'block';
  } else if (data.budget_remaining > 0) {
    rateNote.textContent = '* 최종 비율은 남은 예산을 현금으로 포함한 총자산 기준입니다.';
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
      <span class="chart-label">${escapeHtml(r.name)}</span>
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


if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calculateRebalance,
    calculateCppiAllocation,
    calculateTailRiskBudgetAllocation,
    normalizeImportedHolding,
    validateDynamicAllocationConfig,
  };
}
