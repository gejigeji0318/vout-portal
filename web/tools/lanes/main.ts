// @ts-nocheck
import '@fontsource/zen-kaku-gothic-new/400.css';
import '@fontsource/zen-kaku-gothic-new/500.css';
import '@fontsource/zen-kaku-gothic-new/700.css';
import '@fontsource/zen-kaku-gothic-new/900.css';
// 既存の championLane の画面（docs/index.html）のスクリプトを、ほぼそのまま移したもの

const LANES = [
  {k:"top",label:"トップ"},{k:"jungle",label:"ジャングル"},{k:"mid",label:"ミッド"},
  {k:"adc",label:"ADC"},{k:"support",label:"サポート"}
];
const laneOf = k => LANES.find(l => l.k === k);
let data = [], meta = "", filter = null;

const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// データはポータルのサーバーから受け取る（OP.GG のデータと Riot 公式の日本語名を、毎日 7:00 にサーバーで取り込んで検査済み）
async function loadData(){
  try {
    const res = await fetch("/api/lanes", {cache:"no-store", credentials:"same-origin"});
    if (res.status === 401) { document.getElementById("status").innerHTML = 'ログインすると見られます。<a href="/auth/login">Discord でログイン</a>'; return; }
    if (!res.ok) throw new Error(`データを取得できませんでした (HTTP ${res.status})`);
    const json = await res.json();
    if (!json.updated_at) { document.getElementById("status").textContent = "まだデータがありません。管理者画面の「今すぐ更新」で取り込めます。"; return; }
    data = json.champions || [];
    const t = new Date(json.updated_at);
    meta = `${t.toLocaleString("ja-JP", {timeZone:"Asia/Tokyo"})} 更新`;
    render();
  } catch(e){
    document.getElementById("status").textContent = e.message;
  }
}

function show(has){
  document.getElementById("empty").hidden = has;
  document.getElementById("main").hidden = !has;
}

function render(){
  show(data.length > 0);
  if (!data.length) return;
  const nodata = data.filter(d => d.nodata).length;
  document.getElementById("meta").textContent = `${data.length}体${nodata ? `（うちデータ不足 ${nodata}体）` : ""}・${meta}`;

  const lanesEl = document.getElementById("lanes");
  lanesEl.innerHTML = "";
  LANES.forEach(l => {
    const b = document.createElement("button");
    b.className = "lane"; b.style.setProperty("--c", `var(--${l.k})`);
    b.setAttribute("aria-pressed", filter === l.k);
    b.innerHTML = `<span class="n">${data.filter(d => d.main === l.k).length}</span><span class="l">${l.label}</span>`;
    b.onclick = () => { filter = filter === l.k ? null : l.k; render(); };
    lanesEl.appendChild(b);
  });

  document.getElementById("legend").innerHTML =
    LANES.map(l => `<span style="--c:var(--${l.k})"><i></i>${l.label}</span>`).join("");

  const q = document.getElementById("q").value.trim().toLowerCase();
  const sort = document.getElementById("sort").value;
  const flex = d => { const v = Object.values(d.rates).sort((a,b)=>b-a); return v.length > 1 ? v[1]/v[0] : 0; };
  let rows = data.filter(d => (!filter || d.main === filter) && (d.name.toLowerCase().includes(q) || d.ja.toLowerCase().includes(q) || toKata(d.ja).includes(toKata(q))));
  rows.sort(sort === "rate" ? (a,b)=>b.rate-a.rate : sort === "flex" ? (a,b)=>flex(b)-flex(a) : (a,b)=>a.ja.localeCompare(b.ja, "ja"));

  const list = document.getElementById("list");
  if (!rows.length){ list.innerHTML = `<p style="padding:16px 4px;color:var(--muted)">条件に合うチャンピオンがいません。</p>`; return; }
  list.innerHTML = rows.map(d => {
    const name = `<span class="name">${esc(d.ja)}${d.ja !== d.name ? `<small>${esc(d.name)}</small>` : ""}</span>`;
    if (d.nodata) return `<div class="row">${name}
      <span class="badge none">データ不足</span>
      <span class="note">ピック率が低く、OP.GGのレーン別一覧に未掲載</span></div>`;
    const l = laneOf(d.main) || {k:"mid",label:d.main};
    const total = Object.values(d.rates).reduce((a,b)=>a+b,0) || 1;
    const segs = LANES.filter(x => d.rates[x.k]).map(x =>
      `<span style="--c:var(--${x.k});width:${d.rates[x.k]/total*100}%" title="${x.label} ${d.rates[x.k]}%"></span>`).join("");
    const aria = LANES.filter(x => d.rates[x.k]).map(x => `${x.label} ${d.rates[x.k]}%`).join("、");
    return `<div class="row">${name}
      <span class="badge" style="--c:var(--${l.k})">${l.label}<small>${d.rate}%</small></span>
      <div class="bar" role="img" aria-label="${aria}">${segs}</div></div>`;
  }).join("");
}
const toKata = s => s.replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
const esc = s => s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

document.getElementById("q").oninput = render;
document.getElementById("sort").onchange = render;
loadData();
