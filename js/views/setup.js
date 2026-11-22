// #/setup — onboarding: point Lens at your product.
import { html, useState, useRef, useMemo } from '../lib.js';
import { useStore, setState, toast } from '../store.js';
import { navigate } from '../router.js';
import { Button, Card, Badge, Field, Input, TextArea, Icon } from '../ui.js';
import { analyzeProduct, refreshAll } from '../services/lens.js';
import * as demoModule from '../demo-data.js';

// Used only if demo-data.js does not expose a company object under a known name.
const FALLBACK_DEMO_COMPANY = {
  name: 'Sculptex',
  url: 'https://sculptex-git-main-jacksonschorr.vercel.app',
  tagline: 'Precise 3D models from a sentence.',
  description:
    'Sculptex turns plain language into exact, parametric parts you can take straight into your slicer — editable CAD, not a blob mesh.',
  audience:
    "Makers, hobbyist 3D-printer owners, and hardware founders who need functional, printable parts but don't know CAD",
  field: '3D printing / CAD / maker tools',
  keywords: ['text to CAD', 'parametric 3D model', 'replacement part 3D print', '3D printing tolerances'],
  competitors: ['Fusion 360', 'Onshape', 'Tinkercad', 'OpenSCAD'],
  voice: 'Practical, maker-to-maker, no hype. Lead with something useful and always disclose that we build Sculptex.',
};

const VOICE_PRESETS = [
  { label: 'Warm & direct', value: 'Warm and direct. Short sentences. Helpful first, never salesy.' },
  { label: 'Technical', value: 'Precise and technical. Show the how, cite specifics, skip the fluff.' },
  { label: 'Founder diary', value: 'First-person founder voice. Honest about what is hard, shares lessons learned.' },
  { label: 'Playful', value: 'Light and playful, a little wry. Still useful, never cringe.' },
];

const FLOW = [
  { icon: 'search', title: 'Find conversations', body: 'Lens scans communities for people describing the problem you solve.' },
  { icon: 'edit', title: 'Draft replies', body: 'Contextual replies, DMs and posts — you approve every word.' },
  { icon: 'calendar', title: 'Post & schedule', body: 'Publish to LinkedIn (demo) or copy out, on a calm weekly cadence.' },
];

function getDemoCompany() {
  const mod = demoModule || {};
  const d = mod.demo || mod.default || mod;
  let found = d && (d.company || d.demoCompany || d.DEMO_COMPANY);
  if (typeof found === 'function') {
    try {
      found = found(new Date());
    } catch (e) {
      found = null;
    }
  }
  return { ...FALLBACK_DEMO_COMPANY, ...(found && typeof found === 'object' ? found : {}) };
}

function toList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (const item of arr) {
    const s = (typeof item === 'string' ? item : item && (item.name || item.title || item.label) || '').trim();
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : 'https://' + s;
}

function hostOf(raw) {
  try {
    return new URL(normalizeUrl(raw)).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function nameFromUrl(raw) {
  const host = hostOf(raw);
  if (!host) return '';
  const base = host.split('.')[0].split('-')[0];
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
}

function formFromCompany(c) {
  const co = c || {};
  return {
    name: co.name || '',
    url: co.url || '',
    tagline: co.tagline || '',
    description: co.description || '',
    audience: co.audience || '',
    field: co.field || '',
    keywords: toList(co.keywords),
    competitors: toList(co.competitors),
    voice: co.voice || '',
  };
}

function ChipInput({ id, value, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  const add = (raw) => {
    const parts = String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) {
      setDraft('');
      return;
    }
    const next = [...value];
    for (const p of parts) {
      if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    onChange(next);
    setDraft('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const onInput = (e) => {
    const v = e.target.value;
    if (v.includes(',')) add(v);
    else setDraft(v);
  };

  return html`
    <div className="chip-input" onClick=${() => inputRef.current && inputRef.current.focus()}>
      ${value.map(
        (v) => html`
          <span className="chip" key=${v}>
            <span className="chip-label">${v}</span>
            <button
              type="button"
              className="chip-x"
              aria-label=${'Remove ' + v}
              onClick=${(e) => {
                e.stopPropagation();
                onChange(value.filter((x) => x !== v));
              }}
            >
              <${Icon} name="x" size=${12} />
            </button>
          </span>
        `
      )}
      <input
        ref=${inputRef}
        id=${id}
        className="chip-field"
        value=${draft}
        onChange=${onInput}
        onKeyDown=${onKeyDown}
        onBlur=${() => add(draft)}
        placeholder=${value.length ? 'Add more…' : placeholder}
        autoComplete="off"
      />
    </div>
  `;
}

export default function Setup() {
  const company = useStore((s) => s.company);
  const onboarded = useStore((s) => s.onboarded);
  const settings = useStore((s) => s.settings) || {};
  const connections = useStore((s) => s.connections) || {};

  const [form, setForm] = useState(() => formFromCompany(company));
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzedHost, setAnalyzedHost] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  const set = (key) => (e) => {
    const v = e && e.target ? e.target.value : e;
    setForm((f) => ({ ...f, [key]: v }));
    if (errors[key]) setErrors((er) => ({ ...er, [key]: '' }));
  };

  const demoMode = !!settings.demoMode || !settings.youKey;
  const linkedinOn = connections.linkedin && connections.linkedin.status === 'connected';
  const sculptexOn = connections.sculptex && connections.sculptex.status === 'connected';

  const completeness = useMemo(() => {
    const checks = [
      !!form.url.trim(),
      !!form.audience.trim(),
      !!form.field.trim(),
      form.keywords.length > 0,
      form.competitors.length > 0,
      !!form.voice.trim(),
    ];
    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }, [form]);

  async function onAnalyze() {
    const url = normalizeUrl(form.url);
    if (!url || !hostOf(url)) {
      setErrors((er) => ({ ...er, url: 'Enter a product URL to analyze.' }));
      return;
    }
    setAnalyzing(true);
    try {
      const r = (await analyzeProduct(url)) || {};
      const keywords = toList(r.keywords);
      const competitors = toList(r.competitors);
      setForm((f) => ({
        ...f,
        url,
        name: r.name || f.name || nameFromUrl(url),
        tagline: r.tagline || f.tagline,
        description: r.description || f.description,
        field: r.field || f.field,
        audience: r.audience || f.audience,
        keywords: keywords.length ? keywords : f.keywords,
        competitors: competitors.length ? competitors : f.competitors,
        voice: r.voice || f.voice,
      }));
      setAnalyzedHost(hostOf(url));
      toast('Prefilled from ' + hostOf(url) + ' — review and adjust anything.', 'success');
    } catch (err) {
      toast('Could not analyze that URL: ' + (err && err.message ? err.message : String(err)), 'error');
    } finally {
      setAnalyzing(false);
    }
  }

  function loadDemo() {
    const d = getDemoCompany();
    setForm(formFromCompany(d));
    setErrors({});
    setAnalyzedHost('');
    toast('Loaded the ' + (d.name || 'Sculptex') + ' demo profile.', 'info');
  }

  function onSave() {
    const url = normalizeUrl(form.url);
    const nextErrors = {};
    if (!url || !hostOf(url)) nextErrors.url = 'A product URL helps Lens understand what you build.';
    if (!form.audience.trim()) nextErrors.audience = 'Who should Lens look for? Describe them in a sentence.';
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      toast('A couple of fields need attention.', 'error');
      return;
    }
    setSaving(true);
    const nextCompany = {
      ...(company || {}),
      name: form.name.trim() || nameFromUrl(url),
      url,
      tagline: form.tagline.trim(),
      description: form.description.trim(),
      audience: form.audience.trim(),
      field: form.field.trim(),
      keywords: toList(form.keywords),
      competitors: toList(form.competitors),
      voice: form.voice.trim(),
    };
    setState({ company: nextCompany, onboarded: true });
    refreshAll().catch((err) =>
      toast('Refresh failed: ' + (err && err.message ? err.message : String(err)), 'error')
    );
    toast(onboarded ? 'Saved. Refreshing your feed…' : 'You are set up. Finding conversations…', 'success');
    setSaving(false);
    navigate('/');
  }

  return html`
    <div className="page setup-page">
      <section className="setup-hero">
        <div className="setup-hero-text">
          <div className="setup-eyebrow">
            <${Badge} tone="accent">Step 1 of 3</${Badge}>
            ${demoMode && html`<${Badge} tone="neutral">Demo mode</${Badge}>`}
          </div>
          <h1>Point Lens at your product</h1>
          <p className="setup-lede">
            Tell Lens what you build and who it is for. It will find people describing that problem
            right now, help you reply like a human, and turn recurring pain into posts.
          </p>
          <div className="row setup-hero-actions">
            <${Button} variant="secondary" icon="sparkles" onClick=${loadDemo}>Use Sculptex demo<//>
            <span className="small muted">No account needed — everything stays in this browser.</span>
          </div>
        </div>
        <ol className="flow-steps" aria-label="How Lens works">
          ${FLOW.map(
            (s, i) => html`
              <li className="flow-step" key=${s.title}>
                <span className="flow-step-icon"><${Icon} name=${s.icon} size=${18} /></span>
                <div className="flow-step-text">
                  <div className="flow-step-title"><span className="flow-step-num">${i + 1}</span>${s.title}</div>
                  <div className="small muted">${s.body}</div>
                </div>
                ${i < FLOW.length - 1 &&
                html`<span className="flow-step-arrow" aria-hidden="true"><${Icon} name="arrowRight" size=${16} /></span>`}
              </li>
            `
          )}
        </ol>
      </section>

      <div className="setup-layout">
        <div className="setup-form stack">
          <${Card}
            title="Your product"
            subtitle="Paste a URL and let Lens draft the rest, or fill it in yourself."
          >
            <div className="stack">
              <${Field}
                label="Product URL"
                group=${true}
                error=${errors.url}
                hint=${analyzedHost
                  ? html`<span className="setup-ok"><${Icon} name="check" size=${12} /> Analyzed ${analyzedHost}</span>`
                  : 'Lens reads your site to infer field, keywords and competitors.'}
              >
                <div className="setup-url-row">
                  <div className="setup-url-input">
                    <span className="setup-url-icon" aria-hidden="true"><${Icon} name="link" size=${16} /></span>
                    <${Input}
                      type="url"
                      inputMode="url"
                      placeholder="https://yourproduct.com"
                      value=${form.url}
                      onChange=${set('url')}
                      onKeyDown=${(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          onAnalyze();
                        }
                      }}
                      aria-invalid=${errors.url ? 'true' : 'false'}
                    />
                  </div>
                  <${Button} variant="primary" icon="sparkles" loading=${analyzing} disabled=${analyzing} onClick=${onAnalyze}>
                    ${analyzing ? 'Analyzing…' : 'Analyze URL'}
                  <//>
                </div>
              <//>

              <div className="grid-2 setup-grid">
                <${Field} label="Product name">
                  <${Input} placeholder="Sculptex" value=${form.name} onChange=${set('name')} />
                <//>
                <${Field} label="Field / industry" hint="Used for “Trending in your field” and events.">
                  <${Input} placeholder="e.g. Developer tools, Fintech, 3D printing" value=${form.field} onChange=${set('field')} />
                <//>
              </div>

              <${Field} label="Tagline">
                <${Input} placeholder="One line on what it does" value=${form.tagline} onChange=${set('tagline')} />
              <//>

              <${Field} label="What it does" hint="A few sentences. Lens uses this to ground replies and posts.">
                <${TextArea} rows=${3} value=${form.description} onChange=${set('description')} placeholder="Describe the product and the problem it solves." />
              <//>
            </div>
          <//>

          <${Card} title="Who you want to reach" subtitle="This is what Lens searches for.">
            <div className="stack">
              <${Field}
                label="Target audience"
                error=${errors.audience}
                hint="Be specific: role, stage, the moment they feel the pain."
              >
                <${TextArea}
                  rows=${2}
                  value=${form.audience}
                  onChange=${set('audience')}
                  placeholder="e.g. Hobbyist 3D-printer owners who need a functional part but don't know CAD"
                  aria-invalid=${errors.audience ? 'true' : 'false'}
                />
              <//>

              <${Field} label="Keywords" group=${true} hint="Press Enter or comma to add. Phrases people actually type work best.">
                <${ChipInput}
                  id="setup-keywords"
                  value=${form.keywords}
                  onChange=${(v) => setForm((f) => ({ ...f, keywords: v }))}
                  placeholder="text to CAD, replacement parts…"
                />
              <//>

              <${Field} label="Competitors" group=${true} hint="Threads mentioning them are often the warmest leads.">
                <${ChipInput}
                  id="setup-competitors"
                  value=${form.competitors}
                  onChange=${(v) => setForm((f) => ({ ...f, competitors: v }))}
                  placeholder="Add a competitor"
                />
              <//>
            </div>
          <//>

          <${Card} title="Your voice" subtitle="How replies, DMs and posts should sound.">
            <div className="stack">
              <div className="voice-presets" role="group" aria-label="Voice presets">
                ${VOICE_PRESETS.map(
                  (p) => html`
                    <button
                      type="button"
                      key=${p.label}
                      className=${'pill voice-preset' + (form.voice === p.value ? ' is-active' : '')}
                      onClick=${() => setForm((f) => ({ ...f, voice: p.value }))}
                    >
                      ${p.label}
                    </button>
                  `
                )}
              </div>
              <${TextArea} rows=${2} value=${form.voice} onChange=${set('voice')} placeholder="e.g. Warm, direct, a little technical. Never salesy." />
            </div>
          <//>

          <div className="setup-savebar">
            <div className="setup-progress" aria-label=${'Profile ' + completeness + '% complete'}>
              <div className="setup-progress-track"><div className="setup-progress-fill" style=${{ width: completeness + '%' }}></div></div>
              <span className="small muted">${completeness}% complete</span>
            </div>
            <div className="spacer"></div>
            ${onboarded &&
            html`<${Button} variant="ghost" onClick=${() => navigate('/')}>Cancel<//>`}
            <${Button} variant="primary" icon="arrowRight" loading=${saving} disabled=${saving || analyzing} onClick=${onSave}>
              ${onboarded ? 'Save changes' : 'Save & find conversations'}
            <//>
          </div>
        </div>

        <aside className="setup-aside stack">
          <${Card} title="Connect tools" subtitle="Optional — Lens works in demo mode without any of these.">
            <ul className="setup-tools">
              <li>
                <span className="setup-tool-icon"><${Icon} name="linkedin" size=${16} /></span>
                <div className="setup-tool-text">
                  <div className="setup-tool-name">LinkedIn <span className="muted">(demo)</span></div>
                  <div className="small muted">Simulated connection for sending and posting.</div>
                </div>
                <${Badge} tone=${linkedinOn ? 'success' : 'neutral'}>${linkedinOn ? 'Connected' : 'Off'}</${Badge}>
              </li>
              <li>
                <span className="setup-tool-icon"><${Icon} name="cube" size=${16} /></span>
                <div className="setup-tool-text">
                  <div className="setup-tool-name">Sculptex MCP</div>
                  <div className="small muted">Real 3D renders for your post visuals.</div>
                </div>
                <${Badge} tone=${sculptexOn ? 'success' : 'neutral'}>${sculptexOn ? 'Connected' : 'Off'}</${Badge}>
              </li>
              <li>
                <span className="setup-tool-icon"><${Icon} name="search" size=${16} /></span>
                <div className="setup-tool-text">
                  <div className="setup-tool-name">You.com + Claude keys</div>
                  <div className="small muted">Live search and drafting. Keys stay in this browser.</div>
                </div>
                <${Badge} tone=${settings.youKey && settings.claudeKey ? 'success' : 'neutral'}>
                  ${settings.youKey && settings.claudeKey ? 'Added' : settings.youKey || settings.claudeKey ? 'Partial' : 'Off'}
                </${Badge}>
              </li>
            </ul>
            <p className="small muted setup-temp-note">
              <${Icon} name="clock" size=${12} /> Tool connections are temporary: they last for this tab only and are forgotten when you close it.
            </p>
            <${Button} variant="secondary" size="sm" icon="plug" onClick=${() => navigate('/connections')}>Open Connections<//>
          <//>

          <div className="setup-tip">
            <div className="setup-tip-title"><${Icon} name="bolt" size=${14} /> What happens next</div>
            <p className="small">
              Lens pulls recent threads, trends in your field and founder events this week. Nothing is
              ever sent or posted without you clicking approve.
            </p>
          </div>
        </aside>
      </div>
    </div>
  `;
}
