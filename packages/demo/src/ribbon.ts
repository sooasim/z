/** Fixed "DEMO" ribbon (bottom-left): explains the static demo, quick persona switch, reset. Shadow DOM, inline styles. */
import { F } from './fixtures';
import { PERSONA_LABEL, PERSONA_ORDER, mfaEnabled, persona, session, setSession } from './auth';
import { UI_KEY, readJson, resetAll, writeJson } from './store';

export function mountRibbon() {
  if (document.getElementById('jetpool-demo-ribbon')) return;
  const host = document.createElement('div');
  host.id = 'jetpool-demo-ribbon';
  host.setAttribute('data-demo', 'ribbon');
  host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  // First visit: open, so the visitor reads what this is. Afterwards it stays a small pill unless re-opened.
  const ui = readJson<{ collapsed?: boolean; seen?: number }>(UI_KEY, {});
  const firstVisit = !ui.seen;
  ui.seen = (ui.seen ?? 0) + 1;
  const lang = (document.documentElement.lang || 'ko').startsWith('en') ? 'en' : 'ko';
  const L = (ko: string, en: string) => (lang === 'ko' ? ko : en);
  const s = session();
  const p = s ? persona(s.persona) : null;
  const opts = PERSONA_ORDER.filter((k) => F.personas[k])
    .map((k) => `<option value="${k}" ${p?.key === k ? 'selected' : ''}>${PERSONA_LABEL[k]?.[lang === 'ko' ? 0 : 1] ?? k} · ${F.personas[k].email}</option>`)
    .join('');
  const custom = p?.custom ? `<option value="${p.key}" selected>${p.displayName} · ${p.email}</option>` : '';
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif; }
  .pill { display:flex; align-items:center; gap:6px; border:0; cursor:pointer; background:#0b1f3a; color:#fff; font:700 12px/1 system-ui; letter-spacing:.08em;
          padding:9px 12px; border-radius:999px; box-shadow:0 6px 20px rgba(0,0,0,.25); }
  .pill .dot { width:8px; height:8px; border-radius:50%; background:#ffb020; }
  .card { width:min(320px, calc(100vw - 24px)); background:#0b1f3a; color:#e9f0fb; border-radius:14px; padding:12px 14px 12px; box-shadow:0 12px 32px rgba(0,0,0,.32);
          font-size:12.5px; line-height:1.45; }
  .row { display:flex; align-items:center; gap:8px; }
  .between { justify-content:space-between; }
  .tag { background:#ffb020; color:#0b1f3a; font-weight:800; font-size:11px; letter-spacing:.1em; padding:3px 7px; border-radius:6px; }
  p { margin:8px 0; color:#c9d6ea; }
  b { color:#fff; }
  select { width:100%; margin-top:4px; padding:7px 8px; border-radius:8px; border:1px solid #2b4669; background:#10294b; color:#fff; font-size:12.5px; }
  label { display:block; margin-top:6px; font-weight:600; color:#fff; }
  .btns { display:flex; gap:6px; margin-top:10px; }
  button.b { flex:1; padding:7px 8px; border-radius:8px; border:1px solid #2b4669; background:#10294b; color:#fff; cursor:pointer; font-size:12px; font-weight:600; }
  button.b:hover, .pill:hover { filter:brightness(1.15); }
  button.x { border:0; background:transparent; color:#c9d6ea; cursor:pointer; font-size:18px; line-height:1; padding:2px 4px; }
  .small { font-size:11.5px; color:#9fb3cf; }
  code { background:#10294b; padding:1px 5px; border-radius:5px; color:#fff; }
</style>
<div id="wrap"></div>`;
  const wrap = root.getElementById('wrap')!;
  const render = (collapsed: boolean, persist = true) => {
    if (persist) ui.collapsed = collapsed;
    writeJson(UI_KEY, ui);
    if (collapsed) {
      wrap.innerHTML = `<button class="pill" id="open" aria-label="${L('데모 안내 열기', 'Open demo panel')}"><span class="dot"></span>DEMO${p ? ` · ${PERSONA_LABEL[p.key]?.[lang === 'ko' ? 0 : 1] ?? p.displayName}` : ''}</button>`;
      root.getElementById('open')!.addEventListener('click', () => render(false));
      return;
    }
    wrap.innerHTML = `
<div class="card" role="region" aria-label="JETPOOL demo">
  <div class="row between"><span class="row"><span class="tag">DEMO</span><b>JETPOOL ${L('정적 데모', 'static demo')}</b></span>
    <button class="x" id="close" aria-label="${L('접기', 'Collapse')}">×</button></div>
  <p>정적 데모: 데이터는 브라우저에만 저장됩니다<br/>Static demo — data stays in your browser. ${L('결제는 테스트(MOCK) 모드입니다.', 'Payments run in MOCK mode.')}</p>
  <label for="persona">${L('페르소나 바로 전환', 'Switch persona')}</label>
  <select id="persona"><option value="" ${p ? '' : 'selected'}>${L('로그아웃 상태 (방문자)', 'Signed out (visitor)')}</option>${opts}${custom}</select>
  <div class="small" style="margin-top:6px">${L('직접 로그인', 'Or sign in with')}: <code>guest@jetpool.dev</code> / <code>${F.password}</code></div>
  <div class="btns"><button class="b" id="reset">${L('데모 초기화', 'Reset demo')}</button><button class="b" id="hide">${L('접기', 'Collapse')}</button></div>
</div>`;
    root.getElementById('close')!.addEventListener('click', () => render(true));
    root.getElementById('hide')!.addEventListener('click', () => render(true));
    root.getElementById('persona')!.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      setSession(v || null, v && mfaEnabled(v) ? 'aal2' : 'aal1');
      location.reload();
    });
    root.getElementById('reset')!.addEventListener('click', () => {
      if (!confirm(L('이 브라우저에 저장된 데모 활동(예약, 메시지, 즐겨찾기 등)을 모두 지울까요?', 'Clear all demo activity stored in this browser?'))) return;
      resetAll();
      location.reload();
    });
  };
  render(ui.collapsed ?? (!firstVisit || (window.matchMedia?.('(max-width: 640px)').matches ?? false)), false);
  const place = () => {
    const nav = document.querySelector<HTMLElement>('.bottom-nav, nav.bottomnav, [data-bottom-nav]');
    const h = nav && getComputedStyle(nav).display !== 'none' && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().height : 0;
    host.style.bottom = `${12 + h}px`;
  };
  document.body.appendChild(host);
  place();
  window.addEventListener('resize', place);
  setTimeout(place, 1500);
}
