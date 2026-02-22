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
 */

// ========== 상태 관리 ==========

let etfRows = [];
let nextId = 0;

// 기본 ETF 프리셋 — JSON 업로드 전 초기 상태
const PRESETS = [
  { name: 'KODEX 200',          price: '', qty: '', ratio: '40' },
  { name: 'TIGER 미국S&P500',   price: '', qty: '', ratio: '30' },
  { name: 'KODEX 미국나스닥100',  price: '', qty: '', ratio: '20' },
  { name: 'TIGER 단기채권',      price: '', qty: '', ratio: '10' },
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

  el.innerHTML = `
    <div class="input-group">
      ${isMobile ? '<label>ETF 이름</label>' : ''}
      <input type="text" class="input" data-field="name"
             placeholder="ETF 이름" value="${preset?.name || ''}" autocomplete="off">
    </div>
    <div class="input-group">
      ${isMobile ? '<label>현재가</label>' : ''}
      <input type="text" class="input mono" data-field="price"
             placeholder="0" value="${preset?.price || ''}" inputmode="numeric" autocomplete="off">
    </div>
    <div class="input-group">
      ${isMobile ? '<label>보유 수량</label>' : ''}
      <input type="text" class="input mono" data-field="qty"
             placeholder="0" value="${preset?.qty || ''}" inputmode="numeric" autocomplete="off">
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

  // 삭제 버튼 — 부드러운 페이드아웃 후 DOM에서 제거
  el.querySelector('.btn-delete').addEventListener('click', () => {
    etfRows = etfRows.filter(r => r.id !== id);
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => el.remove(), 150);
    updateRatioBadge();
  });

  // 가격 입력 포맷팅 (콤마 자동 삽입)
  const priceInput = el.querySelector('[data-field="price"]');
  priceInput.addEventListener('input', (e) => {
    const raw = e.target.value.replace(/[^\d]/g, '');
    e.target.value = raw ? Number(raw).toLocaleString() : '';
  });

  // 비율 변경 시 상단 배지 실시간 업데이트
  el.querySelector('[data-field="ratio"]').addEventListener('input', updateRatioBadge);

  list.appendChild(el);
  return el;
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
 * 현재 입력 상태를 JSON 파일로 내보내기
 * 서버를 거치지 않으므로 다른 사용자에게 영향 없음
 */
function exportData() {
  const budget = document.getElementById('budget').value.replace(/[^\d]/g, '');
  const rows = document.querySelectorAll('.etf-row');
  const holdings = [];

  for (const row of rows) {
    holdings.push({
      name:  row.querySelector('[data-field="name"]').value.trim(),
      price: row.querySelector('[data-field="price"]').value.replace(/[^\d]/g, ''),
      qty:   row.querySelector('[data-field="qty"]').value.replace(/[^\d]/g, ''),
      ratio: row.querySelector('[data-field="ratio"]').value.trim(),
    });
  }

  const data = {
    version: 1,
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
 * JSON 파일에서 데이터 불러오기 — 각 사용자가 자신의 파일을 업로드
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
        addETFRow({
          name:  h.name || '',
          price: h.price ? Number(h.price).toLocaleString() : '',
          qty:   h.qty || '',
          ratio: h.ratio || '0',
        });
      }

      updateRatioBadge();
      showToast(`${data.holdings.length}개 ETF 데이터를 불러왔습니다`);

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
 * @param {Array} holdings  - [{ name, current_price, held_quantity, target_ratio }]
 * @param {number} budget   - 이번 달 투자 예산
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

    // 매수 수량 계산 (내림, 최소 0)
    let buyQty = 0;
    if (gap > 0 && h.current_price > 0) {
      buyQty = Math.floor(gap / h.current_price);
    }

    const buyAmount = buyQty * h.current_price;
    totalBuy += buyAmount;

    return {
      name: h.name,
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
      const adjustedQty = Math.floor(r.buy_quantity * scale);
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
 * 입력 검증 → 계산 → 결과 렌더링 (서버 호출 없음)
 */
function calculate() {
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
  const holdings = [];

  for (const row of rows) {
    const name = row.querySelector('[data-field="name"]').value.trim();
    const priceRaw = row.querySelector('[data-field="price"]').value.replace(/[^\d]/g, '');
    const qtyRaw = row.querySelector('[data-field="qty"]').value.replace(/[^\d]/g, '');
    const ratioRaw = row.querySelector('[data-field="ratio"]').value.trim();

    if (!name) {
      showError('모든 ETF의 이름을 입력해주세요.');
      return;
    }

    const price = Number(priceRaw);
    const qty = Number(qtyRaw) || 0;
    const ratio = parseFloat(ratioRaw);

    if (!price || price <= 0) {
      showError(`"${name}"의 현재가를 입력해주세요.`);
      return;
    }

    // 0% 이상 허용 (0% = 더 이상 매수하지 않는 ETF)
    if (isNaN(ratio) || ratio < 0) {
      showError(`"${name}"의 목표 비율은 0% 이상이어야 합니다.`);
      return;
    }

    holdings.push({
      name,
      current_price: price,
      held_quantity: qty,
      target_ratio: ratio,
    });
  }

  if (holdings.length === 0) {
    showError('최소 1개 이상의 ETF를 추가해주세요.');
    return;
  }

  // 비율 합계 검증
  const totalRatio = holdings.reduce((sum, h) => sum + h.target_ratio, 0);
  if (Math.abs(totalRatio - 100) > 0.01) {
    showError(`목표 비율의 합이 100%가 아닙니다 (현재: ${totalRatio.toFixed(1)}%)`);
    return;
  }

  // 클라이언트에서 직접 계산 — 서버 호출 없음
  const data = calculateRebalance(holdings, budget);
  renderResult(data);
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

function renderResult(data) {
  const section = document.getElementById('resultSection');

  // 요약 카드
  document.getElementById('sumHeld').textContent = `₩${fmt(data.total_held_value)}`;
  document.getElementById('sumBuy').textContent = `₩${fmt(data.total_buy_amount)}`;
  document.getElementById('sumFinal').textContent = `₩${fmt(data.total_final_value)}`;
  document.getElementById('sumRemain').textContent = `₩${fmt(data.budget_remaining)}`;

  // 상세 테이블
  const tbody = document.getElementById('resultBody');
  tbody.innerHTML = '';

  data.results.forEach(r => {
    const tr = document.createElement('tr');
    const isZero = r.target_ratio === 0;

    tr.innerHTML = `
      <td>${r.name}${isZero ? ' <small style="color:var(--text-muted)">(매수 중단)</small>' : ''}</td>
      <td>${fmt(r.current_price)}</td>
      <td>${r.held_quantity}</td>
      <td>${r.current_ratio.toFixed(1)}%</td>
      <td class="highlight-cell">${r.buy_quantity > 0 ? '+' + r.buy_quantity : '0'}</td>
      <td class="highlight-cell">${r.buy_amount > 0 ? '₩' + fmt(r.buy_amount) : '-'}</td>
      <td>${r.final_quantity}</td>
      <td>${r.final_ratio.toFixed(1)}%</td>
      <td class="${isZero ? 'zero-ratio' : ''}">${r.target_ratio.toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  });

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
