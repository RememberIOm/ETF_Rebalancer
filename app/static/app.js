/**
 * ETF 리밸런싱 계산기 — 프론트엔드 로직
 */

// ========== 상태 관리 ==========

let etfRows = [];
let nextId = 0;

// 기본 ETF 프리셋 (한국 인기 ETF)
const PRESETS = [
  { name: 'KODEX 200',        price: '',  qty: '', ratio: '40' },
  { name: 'TIGER 미국S&P500',  price: '',  qty: '', ratio: '30' },
  { name: 'KODEX 미국나스닥100', price: '',  qty: '', ratio: '20' },
  { name: 'TIGER 단기채권',     price: '',  qty: '', ratio: '10' },
];


// ========== 초기화 ==========

document.addEventListener('DOMContentLoaded', () => {
  // 프리셋 ETF 추가
  PRESETS.forEach(p => addETFRow(p));

  document.getElementById('addBtn').addEventListener('click', () => addETFRow());
  document.getElementById('calcBtn').addEventListener('click', calculate);

  // 예산 입력 — 숫자 포맷팅
  const budgetInput = document.getElementById('budget');
  budgetInput.addEventListener('input', (e) => {
    const raw = e.target.value.replace(/[^\d]/g, '');
    e.target.value = raw ? Number(raw).toLocaleString() : '';
  });

  // Enter 키로 계산
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      calculate();
    }
  });

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

  // 삭제 버튼
  el.querySelector('.btn-delete').addEventListener('click', () => {
    etfRows = etfRows.filter(r => r.id !== id);
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => el.remove(), 150);
    updateRatioBadge();
  });

  // 가격 입력 포맷팅
  const priceInput = el.querySelector('[data-field="price"]');
  priceInput.addEventListener('input', (e) => {
    const raw = e.target.value.replace(/[^\d]/g, '');
    e.target.value = raw ? Number(raw).toLocaleString() : '';
  });

  // 비율 변경 시 배지 업데이트
  el.querySelector('[data-field="ratio"]').addEventListener('input', updateRatioBadge);

  list.appendChild(el);
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
    // OK
  } else if (total < 100) {
    badge.classList.add('warn');
  } else {
    badge.classList.add('error');
  }
}


// ========== 계산 ==========

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

  // ETF 데이터 수집
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

    if (isNaN(ratio) || ratio <= 0) {
      showError(`"${name}"의 목표 비율을 입력해주세요.`);
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

  // API 호출
  try {
    const res = await fetch('/api/rebalance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdings, monthly_budget: budget }),
    });

    if (!res.ok) {
      const data = await res.json();
      showError(data.detail || '계산 중 오류가 발생했습니다.');
      return;
    }

    const data = await res.json();
    renderResult(data);
  } catch (err) {
    showError('서버 연결에 실패했습니다. 다시 시도해주세요.');
    console.error(err);
  }
}


function showError(msg) {
  const errorBox = document.getElementById('errorBox');
  document.getElementById('errorMsg').textContent = msg;
  errorBox.style.display = 'block';
  errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}


// ========== 결과 렌더링 ==========

function fmt(n) {
  return Math.round(n).toLocaleString();
}

function renderResult(data) {
  const section = document.getElementById('resultSection');

  // 요약
  document.getElementById('sumHeld').textContent = `₩${fmt(data.total_held_value)}`;
  document.getElementById('sumBuy').textContent = `₩${fmt(data.total_buy_amount)}`;
  document.getElementById('sumFinal').textContent = `₩${fmt(data.total_final_value)}`;
  document.getElementById('sumRemain').textContent = `₩${fmt(data.budget_remaining)}`;

  // 테이블
  const tbody = document.getElementById('resultBody');
  tbody.innerHTML = '';

  data.results.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${fmt(r.current_price)}</td>
      <td>${r.held_quantity}</td>
      <td>${r.current_ratio.toFixed(1)}%</td>
      <td class="highlight-cell">${r.buy_quantity > 0 ? '+' + r.buy_quantity : '0'}</td>
      <td class="highlight-cell">${r.buy_amount > 0 ? '₩' + fmt(r.buy_amount) : '-'}</td>
      <td>${r.final_quantity}</td>
      <td>${r.final_ratio.toFixed(1)}%</td>
      <td>${r.target_ratio.toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  });

  // 차트
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

  // 애니메이션
  requestAnimationFrame(() => {
    setTimeout(() => {
      area.querySelectorAll('.chart-bar').forEach(bar => {
        bar.style.width = bar.dataset.width;
      });
    }, 50);
  });
}
