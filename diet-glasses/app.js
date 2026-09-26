import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

// ---------- food catalogue: CLIP prompt -> Japanese name + kcal per serving ----------

const FOODS = [
  { prompt: 'a photo of sushi on a plate',              name: '寿司 (1人前)',        kcal: 500 },
  { prompt: 'a photo of a bowl of ramen noodles',       name: 'ラーメン (1杯)',      kcal: 550 },
  { prompt: 'a photo of onigiri rice balls',            name: 'おにぎり (2個)',      kcal: 360 },
  { prompt: 'a photo of Japanese curry rice',           name: 'カレーライス (1皿)',   kcal: 700 },
  { prompt: 'a photo of a hamburger',                   name: 'ハンバーガー (1個)',   kcal: 520 },
  { prompt: 'a photo of pizza slices',                  name: 'ピザ (2切れ)',        kcal: 560 },
  { prompt: 'a photo of a green salad',                 name: 'サラダ (1皿)',        kcal: 150 },
  { prompt: 'a photo of fried chicken karaage',         name: '唐揚げ (5個)',        kcal: 450 },
  { prompt: 'a photo of a sandwich',                    name: 'サンドイッチ (1個)',   kcal: 350 },
  { prompt: 'a photo of udon noodle soup',              name: 'うどん (1杯)',        kcal: 400 },
  { prompt: 'a photo of a Japanese bento box',          name: '弁当 (1個)',          kcal: 750 },
  { prompt: 'a photo of gyoza dumplings',               name: '餃子 (6個)',          kcal: 300 },
  { prompt: 'a photo of a steak',                       name: 'ステーキ (1枚)',      kcal: 600 },
  { prompt: 'a photo of pasta on a plate',              name: 'パスタ (1皿)',        kcal: 620 },
  { prompt: 'a photo of grilled meat',                  name: '焼肉 (1人前)',        kcal: 800 },
  { prompt: 'a photo of tempura',                       name: '天ぷら (1人前)',      kcal: 500 },
  { prompt: 'a photo of a Japanese rice bowl donburi',  name: '丼物 (1杯)',          kcal: 700 },
  { prompt: 'a photo of bread or toast',                name: 'パン (1個)',          kcal: 250 },
  { prompt: 'a photo of a slice of cake',               name: 'ケーキ (1個)',        kcal: 380 },
  { prompt: 'a photo of ice cream',                     name: 'アイスクリーム (1個)', kcal: 250 },
  { prompt: 'a photo of a donut',                       name: 'ドーナツ (1個)',      kcal: 300 },
  { prompt: 'a photo of french fries',                  name: 'フライドポテト (1人前)', kcal: 350 },
  { prompt: 'a photo of fruit',                         name: 'フルーツ (1人前)',    kcal: 100 },
  { prompt: 'a photo of a soft drink',                  name: 'ジュース (1杯)',      kcal: 150 },
];

const NON_FOOD = [
  'a photo of a person',
  'a close-up photo of a human face',
  'a selfie photo of a face looking at the camera',
  'a photo of hands',
  'a photo of an office desk',
  'a photo of a laptop computer',
  'a photo of a smartphone',
  'a photo of a street',
  'a photo of a room interior',
  'a photo of green plants',
];

const LABELS = [...FOODS.map(f => f.prompt), ...NON_FOOD];
const FOOD_BY_PROMPT = new Map(FOODS.map(f => [f.prompt, f]));

const CONF_THRESHOLD = 0.35;   // minimum score to treat top food label as a detection
const STABLE_FRAMES  = 2;      // consecutive identical detections required to auto-log
const LOG_COOLDOWN_MS = 90_000;
const SCAN_MS = 1400;

const DEMO_IMAGES = [
  'demo/sushi.jpg', 'demo/ramen.jpg', 'demo/burger.jpg',
  'demo/onigiri.jpg', 'demo/curry.jpg', 'demo/desk.jpg', 'demo/face.jpg',
];
const DEMO_INTERVAL_MS = 5000;

// ---------- DOM ----------

const el = id => document.getElementById(id);
const cam = el('cam'), demoImg = el('demoImg'), cap = el('cap');
const capCtx = cap.getContext('2d');
const modelStatus = el('modelStatus'), warnBanner = el('warnBanner');
const hudFood = el('hud-food'), foodName = el('foodName'), foodKcal = el('foodKcal'),
      foodConf = el('foodConf'), logBtn = el('logBtn');
const totalText = el('totalText'), progressFill = el('progressFill');
const vignette = el('vignette'), stamp = el('stamp'), stampFood = el('stampFood');
const panel = el('panel'), logList = el('logList');
const limitInput = el('limitInput'), autoLogChk = el('autoLog');
const toast = el('toast');

// ---------- state ----------

let classifier = null;
let busy = false;
let mode = 'camera';            // 'camera' | 'demo'
let demoTimer = null, demoIdx = 0;
let currentFood = null;         // {prompt,name,kcal,score}
let lastLabel = null, streak = 0;
const loggedAt = new Map();     // prompt -> epoch ms

const dayKeyFor = t => {
  const d = new Date(t);
  return `dg_log_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const todayKey = () => dayKeyFor(Date.now());

// Earlier builds keyed logs by UTC date. Re-bucket any stored entries by their
// timestamps into local-day keys once, so near-midnight meals land on the right day.
// Writes complete before any source key is dropped, so a quota/IO failure loses nothing.
(function migrateLogs() {
  try {
    if (localStorage.getItem('dg_migrated') === '1') return;
    const sig = e => `${e.t}|${e.name}|${e.kcal}`;
    const parse = s => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

    const legacyKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('dg_log_')) legacyKeys.push(k);
    }
    const legacyKeySet = new Set(legacyKeys);

    const buckets = new Map();
    for (const k of legacyKeys) {
      for (const e of parse(localStorage.getItem(k))) {
        const bk = dayKeyFor(e.t);
        if (!buckets.has(bk)) buckets.set(bk, []);
        const arr = buckets.get(bk);
        if (!arr.some(x => sig(x) === sig(e))) arr.push(e);
      }
    }

    for (const [bk, incoming] of buckets) {
      const existing = legacyKeySet.has(bk)
        ? []
        : parse(localStorage.getItem(bk)).filter(x => !incoming.some(n => sig(n) === sig(x)));
      localStorage.setItem(bk, JSON.stringify([...existing, ...incoming]));
    }

    for (const k of legacyKeys) {
      if (!buckets.has(k)) localStorage.removeItem(k);
    }
    localStorage.setItem('dg_migrated', '1');
  } catch (e) {
    console.warn('meal-log migration failed; original entries preserved', e);
  }
})();
let limit = parseInt(localStorage.getItem('dg_limit') || '2000', 10);
let autoLog = localStorage.getItem('dg_autolog') !== '0';
limitInput.value = limit;
autoLogChk.checked = autoLog;

const loadLog = () => { try { return JSON.parse(localStorage.getItem(todayKey()) || '[]'); } catch { return []; } };
const saveLog = entries => localStorage.setItem(todayKey(), JSON.stringify(entries));
const dayTotal = () => loadLog().reduce((s, e) => s + e.kcal, 0);

// ---------- UI helpers ----------

let toastTimer = null;
function showToast(msg, ms = 2600) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
}

function renderTotals() {
  const total = dayTotal();
  totalText.textContent = `${total.toLocaleString()} / ${limit.toLocaleString()} kcal`;
  const pct = Math.min(100, (total / limit) * 100);
  progressFill.style.width = `${pct}%`;
  progressFill.className = total >= limit ? 'over' : total >= limit * 0.8 ? 'warn' : '';
  renderBan();
}

function renderLog() {
  const entries = loadLog();
  logList.innerHTML = '';
  if (!entries.length) {
    logList.innerHTML = '<li style="color:#888">まだ記録がありません</li>';
    return;
  }
  entries.forEach((e, i) => {
    const li = document.createElement('li');
    const time = new Date(e.t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const label = document.createElement('span');
    label.textContent = `${time} ${e.name}`;
    const kcal = document.createElement('span');
    kcal.textContent = `${e.kcal} kcal`;
    li.append(label, kcal);
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '✕'; del.title = '削除';
    del.onclick = () => { const l = loadLog(); l.splice(i, 1); saveLog(l); renderLog(); renderTotals(); };
    li.appendChild(del);
    logList.appendChild(li);
  });
}

function renderDetection() {
  if (currentFood) {
    hudFood.hidden = false;
    foodName.textContent = currentFood.name;
    foodKcal.textContent = `約${currentFood.kcal} kcal`;
    foodConf.textContent = `信頼度 ${(currentFood.score * 100).toFixed(0)}%`;
  } else {
    hudFood.hidden = true;
  }
  renderBan();
}

function renderBan() {
  const over = dayTotal() >= limit;
  const food = over && currentFood;
  stamp.hidden = !food;
  if (food) stampFood.textContent = `${currentFood.name} +${currentFood.kcal} kcal`;
  vignette.classList.toggle('ban', !!food);
  warnBanner.hidden = !(dayTotal() >= limit * 0.8);
  if (over) {
    warnBanner.textContent = '本日の摂取カロリー上限を超過しました';
    warnBanner.style.background = 'rgba(200,0,0,.85)';
  } else if (dayTotal() >= limit * 0.8) {
    warnBanner.textContent = `上限まで残り ${(limit - dayTotal()).toLocaleString()} kcal`;
    warnBanner.style.background = 'rgba(214,140,0,.85)';
  }
}

function addLog(food, via) {
  const entries = loadLog();
  entries.push({ t: Date.now(), name: food.name, kcal: food.kcal });
  saveLog(entries);
  renderLog(); renderTotals();
  showToast(`${food.name} を記録 (+${food.kcal} kcal)${via === 'auto' ? ' [自動]' : ''}`);
}

// ---------- frame capture ----------

function captureFrame() {
  const src = mode === 'camera' ? cam : demoImg;
  const w = src.videoWidth || src.naturalWidth, h = src.videoHeight || src.naturalHeight;
  if (!w || !h) return null;
  // Classify only what object-fit:cover actually shows: the centered source
  // rect matching the stage's aspect ratio.
  const stage = src.getBoundingClientRect();
  const stageAspect = stage.width && stage.height ? stage.width / stage.height : w / h;
  let cw = w, ch = h;
  if (w / h > stageAspect) cw = Math.max(1, Math.round(h * stageAspect));
  else ch = Math.max(1, Math.round(w / stageAspect));
  cap.width = cap.height = 384;
  capCtx.drawImage(src, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, 384, 384);
  return cap.toDataURL('image/jpeg', 0.85);
}

// ---------- classification loop ----------

let shownDay = todayKey();

async function scan() {
  if (busy || !classifier) return;
  if (shownDay !== todayKey()) {
    shownDay = todayKey();
    renderLog();
    renderTotals();
  }
  const frame = captureFrame();
  if (!frame) return;
  busy = true;
  try {
    const out = await classifier(frame, LABELS, { hypothesis_template: '{}' });
    out.sort((a, b) => b.score - a.score);
    handleResult(out[0]);
  } catch (e) {
    console.error('classify error', e);
  } finally {
    busy = false;
  }
}

function handleResult(top) {
  const food = top.score >= CONF_THRESHOLD ? FOOD_BY_PROMPT.get(top.label) : null;
  if (food && food.prompt === lastLabel) streak++;
  else { lastLabel = food ? food.prompt : null; streak = food ? 1 : 0; }
  currentFood = food ? { ...food, score: top.score } : null;
  renderDetection();

  if (autoLog && food && streak >= STABLE_FRAMES) {
    const last = loggedAt.get(food.prompt) || 0;
    if (Date.now() - last > LOG_COOLDOWN_MS) {
      loggedAt.set(food.prompt, Date.now());
      addLog(food, 'auto');
      streak = 0;
    }
  }
}

// ---------- sources ----------

let cameraPending = false;
async function startCamera() {
  if (cameraPending) return;
  cameraPending = true;
  stopDemo();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } },
      audio: false,
    });
    if (cam.srcObject) cam.srcObject.getTracks().forEach(t => t.stop());
    cam.srcObject = stream;
    await cam.play();
    cam.hidden = false; demoImg.hidden = true;
    mode = 'camera';
    el('srcBtn').textContent = '🎞 デモ';
  } catch (e) {
    console.warn('camera unavailable:', e);
    showToast('カメラが使えません → デモモードで動作します', 3500);
    startDemo();
  } finally {
    cameraPending = false;
  }
}

function startDemo() {
  if (cam.srcObject) { cam.srcObject.getTracks().forEach(t => t.stop()); cam.srcObject = null; }
  cam.hidden = true; demoImg.hidden = false;
  mode = 'demo';
  const next = () => { demoImg.src = DEMO_IMAGES[demoIdx]; demoIdx = (demoIdx + 1) % DEMO_IMAGES.length; };
  next();
  demoTimer = setInterval(next, DEMO_INTERVAL_MS);
  el('srcBtn').textContent = '📷 カメラ';
}

function stopDemo() { clearInterval(demoTimer); demoTimer = null; }

// ---------- events ----------

el('srcBtn').onclick = () => (mode === 'camera' ? startDemo() : startCamera());
el('panelBtn').onclick = () => { panel.hidden = !panel.hidden; renderLog(); };
el('panelClose').onclick = () => { panel.hidden = true; };
logBtn.onclick = () => {
  if (!currentFood) return;
  loggedAt.set(currentFood.prompt, Date.now());
  streak = 0;
  addLog(currentFood, 'manual');
};
limitInput.onchange = () => {
  limit = Math.max(100, parseInt(limitInput.value, 10) || 2000);
  localStorage.setItem('dg_limit', limit);
  renderTotals();
};
autoLogChk.onchange = () => {
  autoLog = autoLogChk.checked;
  localStorage.setItem('dg_autolog', autoLog ? '1' : '0');
};
el('resetDay').onclick = () => {
  saveLog([]); loggedAt.clear();
  renderLog(); renderTotals();
  showToast('今日の記録をリセットしました');
};

// ---------- boot ----------

(async function init() {
  renderLog(); renderTotals();
  startCamera();

  try {
    modelStatus.textContent = 'AIモデルを読み込み中…';
    const opts = {
      progress_callback: p => {
        if (p.status === 'progress' && p.total) {
          modelStatus.textContent = `AIモデルDL中… ${Math.round((p.loaded / p.total) * 100)}% (${p.file})`;
        } else if (p.status === 'ready') {
          modelStatus.textContent = 'モデル準備完了';
        }
      },
    };
    try {
      classifier = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch16', { ...opts, dtype: 'q8' });
    } catch (e) {
      console.warn('quantized model failed, retrying fp32', e);
      classifier = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch16', opts);
    }
    modelStatus.textContent = '稼働中 — 食べ物をカメラに向けてください';
    setTimeout(() => (modelStatus.style.opacity = '0'), 4000);
    setInterval(scan, SCAN_MS);
  } catch (e) {
    modelStatus.textContent = 'モデルの読み込みに失敗しました（ネットワークを確認）';
    console.error(e);
  }
})();
