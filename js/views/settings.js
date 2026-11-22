// #/settings — Connections · Product · Data. The active tab lives in ?tab= (e.g. #/settings?tab=data).
import { html, useState, useEffect, useMemo } from '../lib.js';
import { useStore, setState, getState, resetState, toast } from '../store.js';
import { navigate } from '../router.js';
import { Button, Card, Badge, Modal, Tabs, Field, Input, TextArea, Toggle } from '../ui.js';
import { analyzeProduct } from '../services/lens.js';
import { ConnectionsPanel } from './connections.js';

const TABS = [
  { id: 'connections', label: 'Connections', icon: 'plug' },
  { id: 'product', label: 'Product', icon: 'target' },
  { id: 'data', label: 'Data', icon: 'layers' },
];
const TAB_IDS = TABS.map((t) => t.id);

const PRODUCT_FIELDS = ['name', 'url', 'tagline', 'description', 'audience', 'field', 'keywords', 'competitors', 'voice'];
const LIST_FIELDS = ['keywords', 'competitors'];

/* ---------- helpers ---------- */

function errMessage(e) {
  if (!e) return 'Unknown error';
  return typeof e === 'string' ? e : e.message || String(e);
}

function toList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,\n]/);
  const out = [];
  for (const item of arr) {
    const s = String(item || '').trim();
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

function normalizeUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    return new URL(withProto).toString().replace(/\/$/, '');
  } catch {
    return withProto;
  }
}

// Company object → editable form (lists as comma-separated text).
function formFrom(company) {
  const c = company || {};
  const out = {};
  for (const k of PRODUCT_FIELDS) {
    out[k] = LIST_FIELDS.includes(k) ? toList(c[k]).join(', ') : String(c[k] || '');
  }
  return out;
}

function companyFrom(form, base) {
  return {
    ...(base || {}),
    name: form.name.trim(),
    url: normalizeUrl(form.url),
    tagline: form.tagline.trim(),
    description: form.description.trim(),
    audience: form.audience.trim(),
    field: form.field.trim(),
    keywords: toList(form.keywords),
    competitors: toList(form.competitors),
    voice: form.voice.trim(),
  };
}

function sameForm(a, b) {
  return PRODUCT_FIELDS.every((k) => (a[k] || '').trim() === (b[k] || '').trim());
}

/* ---------- Product ---------- */

function ProductTab() {
  const company = useStore((s) => s.company || {});
  const saved = useMemo(() => formFrom(company), [company]);
  const [form, setForm] = useState(saved);
  const [analyzing, setAnalyzing] = useState(false);
  const dirty = !sameForm(form, saved);

  // Pick up changes made elsewhere (e.g. "Analyze URL" or onboarding) when there are no local edits.
  const [base, setBase] = useState(saved);
  useEffect(() => {
    if (sameForm(form, base)) setForm(saved);
    setBase(saved);
  }, [saved]);

  const set = (k) => (e) => {
    const v = e && e.target ? e.target.value : e;
    setForm((f) => ({ ...f, [k]: v }));
  };

  function save(e) {
    if (e) e.preventDefault();
    if (!form.url.trim() && !form.name.trim()) {
      toast('Add at least a product name or URL.', 'error');
      return;
    }
    const next = companyFrom(form, getState().company);
    setState({ company: next });
    setForm(formFrom(next));
    toast('Product profile saved.', 'success');
  }

  async function analyze() {
    const url = normalizeUrl(form.url);
    if (!url) {
      toast('Enter your product URL first.', 'error');
      return;
    }
    setAnalyzing(true);
    try {
      // analyzeProduct writes the refreshed profile into the store; keep the URL the user typed.
      const result = await analyzeProduct(url);
      const current = getState().company || {};
      const merged = { ...current, ...(result && typeof result === 'object' ? result : {}), url };
      setForm(formFrom(merged));
      toast('Profile refreshed from your URL.', 'success');
    } catch (err) {
      toast(`Couldn't analyze that URL: ${errMessage(err)}`, 'error');
    } finally {
      setAnalyzing(false);
    }
  }

  function rerunOnboarding() {
    const s = getState();
    setState({ onboarded: false, onboarding: { ...(s.onboarding || {}), step: 'url' } });
    navigate('/start');
  }

  const keywordChips = toList(form.keywords);

  return html`
    <div className="set-product">
      <form className="stack" onSubmit=${save}>
        <${Card}
          title="Product"
          subtitle="What Lens listens for and how it writes for you."
          actions=${dirty ? html`<${Badge} tone="warning">Unsaved changes<//>` : html`<${Badge} tone="success" icon="check">Saved<//>`}
        >
          <div className="stack">
            <div className="grid-2">
              <${Field} label="Product name" htmlFor="set-name">
                <${Input} id="set-name" value=${form.name} onChange=${set('name')} placeholder="Sculptex" autoComplete="organization" />
              <//>
              <${Field} label="Product URL" htmlFor="set-url" hint="Lens reads this page to understand what you build.">
                <div className="set-inline">
                  <${Input} id="set-url" type="url" inputMode="url" value=${form.url} onChange=${set('url')} placeholder="https://your-product.com" spellCheck=${false} />
                  <${Button} variant="secondary" icon="sparkles" loading=${analyzing} disabled=${analyzing || !form.url.trim()} onClick=${analyze}>Analyze<//>
                </div>
              <//>
            </div>
            <${Field} label="Tagline" htmlFor="set-tagline">
              <${Input} id="set-tagline" value=${form.tagline} onChange=${set('tagline')} placeholder="One line on what it does" />
            <//>
            <${Field} label="Description" htmlFor="set-description">
              <${TextArea} id="set-description" rows=${3} autoGrow=${true} value=${form.description} onChange=${set('description')} placeholder="What it does, for whom, and why it's different." />
            <//>
            <div className="grid-2">
              <${Field} label="Target audience" htmlFor="set-audience">
                <${TextArea} id="set-audience" rows=${2} autoGrow=${true} value=${form.audience} onChange=${set('audience')} placeholder="Who has the problem you solve?" />
              <//>
              <${Field} label="Field" htmlFor="set-field" hint="Used for trends and founder events.">
                <${Input} id="set-field" value=${form.field} onChange=${set('field')} placeholder="3D printing / CAD / maker tools" />
              <//>
            </div>
            <${Field} label="Keywords" htmlFor="set-keywords" hint="Comma-separated. Lens searches for conversations using these.">
              <${Input} id="set-keywords" value=${form.keywords} onChange=${set('keywords')} placeholder="text to CAD, printable parts, tolerances" />
            <//>
            ${keywordChips.length > 0 &&
            html`<div className="set-chips" aria-label="Keywords preview">
              ${keywordChips.slice(0, 16).map((k) => html`<span key=${k} className="pill">${k}</span>`)}
            </div>`}
            <${Field} label="Competitors" htmlFor="set-competitors" hint="Comma-separated. Optional.">
              <${Input} id="set-competitors" value=${form.competitors} onChange=${set('competitors')} placeholder="Fusion 360, Onshape" />
            <//>
            <${Field} label="Voice" htmlFor="set-voice" hint="How drafts should sound.">
              <${TextArea} id="set-voice" rows=${2} autoGrow=${true} value=${form.voice} onChange=${set('voice')} placeholder="Practical, maker-to-maker, no hype." />
            <//>
            <div className="row set-actions">
              <${Button} type="submit" variant="primary" icon="check" disabled=${!dirty}>Save profile<//>
              <${Button} variant="ghost" disabled=${!dirty} onClick=${() => setForm(saved)}>Discard changes<//>
            </div>
          </div>
        <//>
      </form>

      <${Card} className="set-rerun" title="Start over" subtitle="Walk through the guided setup again: URL scan, audience chat, tools and your first posts.">
        <div className="row set-actions">
          <${Button} variant="secondary" icon="refresh" onClick=${rerunOnboarding}>Re-run onboarding<//>
          <span className="small muted">Your threads, drafts and schedule are kept.</span>
        </div>
      <//>
    </div>
  `;
}

/* ---------- Data ---------- */

function exportData() {
  const s = getState();
  const { settings, connections, toasts, ui, ...rest } = s;
  const { youKey, claudeKey, ...safeSettings } = settings || {};
  const now = new Date();
  const payload = {
    app: 'Lens',
    format: 1,
    exportedAt: now.toISOString(),
    note: 'API keys and connections are intentionally excluded.',
    state: { ...rest, settings: safeSettings },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const pad = (n) => String(n).padStart(2, '0');
  const a = document.createElement('a');
  a.href = url;
  a.download = `lens-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Exported your Lens data (without keys or connections).', 'success');
}

function clearEverything() {
  // Remove every Lens key from localStorage (other apps on the same origin keep theirs).
  // sessionStorage is per-tab, so it is cleared fully.
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.toLowerCase().startsWith('lens')) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* storage unavailable — nothing to clear */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* storage unavailable — nothing to clear */
  }
  location.hash = '';
  location.reload();
}

function DataTab() {
  const demoMode = useStore((s) => !(s.settings && s.settings.demoMode === false));
  const counts = useStore((s) => [
    (s.threads || []).length,
    (s.drafts || []).length,
    (s.events || []).length,
    (s.linkedinFeed || []).length,
    (s.chat || []).length + (s.ideaChat || []).length,
  ]);
  const [confirm, setConfirm] = useState(null);

  function setDemo(on) {
    setState((s) => ({ settings: { ...(s.settings || {}), demoMode: on } }));
    toast(on ? 'Demo mode on — using sample data.' : 'Demo mode off — Lens uses You.com when a key (yours or the shared one) is available.', 'info');
  }

  function doReset() {
    resetState();
    setConfirm(null);
    toast('Demo data restored. Your API keys were kept.', 'success');
    navigate('/start');
  }

  const [threads, drafts, events, feed, chats] = counts;

  return html`
    <div className="stack">
      <${Card} title="Demo mode" subtitle="Everything works without keys using bundled sample data.">
        <${Toggle}
          checked=${demoMode}
          onChange=${setDemo}
          label="Use demo data"
          hint="Sample conversations, trends and events instead of live You.com results. Turn off to go live."
        />
      <//>

      <${Card} title="Your data" subtitle="Everything Lens knows lives in this browser — no accounts, no database.">
        <div className="stack">
          <div className="set-stats">
            <div><strong>${threads}</strong><span>threads</span></div>
            <div><strong>${drafts}</strong><span>drafts</span></div>
            <div><strong>${events}</strong><span>events</span></div>
            <div><strong>${feed}</strong><span>LinkedIn (demo) items</span></div>
            <div><strong>${chats}</strong><span>chat messages</span></div>
          </div>
          <p className="small muted">
            App data is in localStorage (<code>lens_state_v1</code>). Connections are in sessionStorage (<code>lens_mcp_v1</code>)
            and disappear when you close the tab.
          </p>
          <div className="set-data-actions">
            <${Button} variant="secondary" icon="download" onClick=${exportData}>Export data (JSON)<//>
            <${Button} variant="secondary" icon="refresh" onClick=${() => setConfirm('reset')}>Reset demo data<//>
            <${Button} variant="danger" icon="trash" onClick=${() => setConfirm('clear')}>Clear everything<//>
          </div>
        </div>
      <//>

      <${Modal}
        open=${confirm === 'reset'}
        title="Reset demo data?"
        onClose=${() => setConfirm(null)}
        footer=${html`
          <${Button} variant="ghost" onClick=${() => setConfirm(null)}>Cancel<//>
          <${Button} variant="primary" onClick=${doReset}>Reset<//>
        `}
      >
        <p>
          Your company profile, threads, drafts, events, trends, chats and the demo LinkedIn feed go back to the sample data,
          and onboarding starts again. Your API keys and model choice are kept.
        </p>
      <//>

      <${Modal}
        open=${confirm === 'clear'}
        title="Clear everything?"
        onClose=${() => setConfirm(null)}
        footer=${html`
          <${Button} variant="ghost" onClick=${() => setConfirm(null)}>Cancel<//>
          <${Button} variant="danger" onClick=${clearEverything}>Clear and reload<//>
        `}
      >
        <p>
          This deletes all Lens data from this browser — your company profile, drafts, API keys and any connections — then
          reloads the page. It can't be undone. Export first if you want a copy.
        </p>
      <//>
    </div>
  `;
}

/* ---------- page ---------- */

export default function Settings({ params = {} }) {
  const tab = TAB_IDS.includes(params.tab) ? params.tab : 'connections';
  const onboarded = useStore((s) => !!s.onboarded);

  const go = (id) => navigate(`/settings?tab=${id}`, { replace: true });

  return html`
    <div className="page set-page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="page-sub">
            Connections, your product profile and your data. No accounts — keys stay in this browser and tool connections last
            only for this tab.
          </p>
        </div>
        ${!onboarded &&
        html`<div className="page-actions">
          <${Button} variant="primary" iconRight="arrowRight" onClick=${() => navigate('/start')}>Continue setup<//>
        </div>`}
      </div>

      <${Tabs} className="set-tabs" tabs=${TABS} value=${tab} onChange=${go} />

      <div className="set-body" role="tabpanel" aria-label=${(TABS.find((t) => t.id === tab) || TABS[0]).label}>
        ${tab === 'connections' && html`<${ConnectionsPanel} />`}
        ${tab === 'product' && html`<${ProductTab} />`}
        ${tab === 'data' && html`<${DataTab} />`}
      </div>
    </div>
  `;
}
