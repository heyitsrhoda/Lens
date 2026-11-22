// Demo data for Lens. Everything here is SAMPLE data used in demo mode (no keys).
// The demo company is the real product Sculptex; the conversations, handles and
// events are invented examples that link to real community search pages.
// All dates are computed relative to the current time — never hard-coded.

const HOUR = 3600 * 1000;

function toDate(now) {
  if (now instanceof Date) return now;
  if (now === undefined || now === null) return new Date();
  return new Date(now);
}

function ago(now, hours) {
  return new Date(toDate(now).getTime() - hours * HOUR).toISOString();
}

function atLocal(now, dayOffset, hour, minute) {
  const d = new Date(toDate(now).getTime());
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/* ------------------------------------------------------------------ */
/* Company + mock LinkedIn profile                                     */
/* ------------------------------------------------------------------ */

const company = {
  name: 'Sculptex',
  url: 'https://sculptex.app',
  tagline: 'Precise 3D models from a sentence.',
  description:
    'Sculptex turns plain language into exact, parametric parts you can take straight into your slicer — editable CAD, not a blob mesh.',
  audience:
    "Makers, hobbyist 3D-printer owners, and hardware founders or product designers who need functional, printable parts but don't know CAD",
  field: '3D printing / CAD / maker tools',
  keywords: [
    'text to CAD',
    'parametric 3D model',
    'replacement part 3D print',
    'functional print',
    '3D printing tolerances',
    'press fit',
    'OpenSCAD parameters',
    'STEP file',
    'AI 3D model not printable',
    'CAD for beginners',
  ],
  competitors: ['Fusion 360', 'Onshape', 'Tinkercad', 'OpenSCAD', 'Text-to-3D mesh generators'],
  voice:
    'Practical, maker-to-maker, no hype. Lead with something useful (a measurement tip, a tolerance number), speak plainly about trade-offs, and always disclose that we build Sculptex.',
};

const competitorNotes = [
  { name: 'Fusion 360', note: 'Full-featured parametric CAD/CAM; very capable, with a real learning curve for occasional users.' },
  { name: 'Onshape', note: 'Browser-based parametric CAD with strong collaboration; same sketch-and-constraint workflow as traditional CAD.' },
  { name: 'Tinkercad', note: 'Beginner-friendly block modeling in the browser; quick for simple shapes, limited for precise or parametric edits.' },
  { name: 'OpenSCAD', note: 'Code-based parametric modeling; precise and scriptable, but models with many variables get hard to maintain.' },
  { name: 'Text-to-3D mesh generators', note: 'Generate visual meshes from prompts; good for concept art, usually not dimensionally exact or easy to edit.' },
];

const linkedinProfile = {
  name: 'Jackson S.',
  headline: 'Building Sculptex — precise 3D parts from a sentence',
  initials: 'JS',
};

/* ------------------------------------------------------------------ */
/* Sample conversations (invented handles, real search-page URLs)      */
/* ------------------------------------------------------------------ */

const THREAD_SEED = [
  {
    id: 't1',
    source: 'reddit',
    community: 'r/functionalprint',
    title: 'Need a replacement clip for my dishwasher rack — no idea where to start in CAD',
    url: 'https://www.reddit.com/r/functionalprint/search/?q=replacement+bracket',
    author: 'u/layerlines_dan',
    snippet:
      'Upper rack clip snapped. I have calipers and a printer, but every tutorial I open starts with sketch constraints and I just need one small part that fits.',
    quote:
      'The plastic clip that holds the upper rack snapped. The manufacturer wants $38 for a 2-gram part and I have a printer sitting right here, but every CAD tutorial starts with 40 minutes of sketch constraints.',
    hoursAgo: 5,
    relevance: 94,
    painPoint: 'Replacement parts',
    intent: 'high',
    engagement: { replies: 23, upvotes: 141 },
    status: 'new',
  },
  {
    id: 't2',
    source: 'reddit',
    community: 'r/3Dprinting',
    title: 'Tried an AI text-to-3D generator for a phone mount. Looks great, prints terribly.',
    url: 'https://www.reddit.com/r/3Dprinting/search/?q=ai+generated+model+printable',
    author: 'u/petg_pete',
    snippet:
      'Preview looked perfect. In the slicer it was non-manifold, had paper-thin walls, and the phone slot was nowhere near the size I asked for.',
    quote:
      "The model looked fine in the preview but it was a single non-manifold mesh, the walls were 0.3 mm in places and the phone slot was 'about' the right size. I ended up remodeling it from scratch.",
    hoursAgo: 14,
    relevance: 92,
    painPoint: "AI meshes aren't printable",
    intent: 'high',
    engagement: { replies: 58, upvotes: 412 },
    status: 'new',
  },
  {
    id: 't3',
    source: 'reddit',
    community: 'r/cad',
    title: "Fastest way for a total beginner to get to 'I can model a simple enclosure'?",
    url: 'https://www.reddit.com/r/cad/search/?q=beginner+enclosure',
    author: 'u/sketchconstraint',
    snippet:
      'Not trying to become a CAD professional. Just need small project boxes for electronics with standoffs and a couple of cutouts.',
    quote:
      "I don't want to become a CAD person. I want a box with four M3 standoffs and a USB-C cutout, and every path seems to be a weekend of tutorials.",
    hoursAgo: 27,
    relevance: 89,
    painPoint: 'CAD learning curve',
    intent: 'medium',
    engagement: { replies: 41, upvotes: 96 },
    status: 'new',
  },
  {
    id: 't4',
    source: 'reddit',
    community: 'r/prusa3d',
    title: 'Press-fit bearing seats keep coming out too tight — how do you dial in tolerances?',
    url: 'https://www.reddit.com/r/prusa3d/search/?q=press+fit+tolerance',
    author: 'u/mk4_marta',
    snippet:
      'Six test prints in, changing the bore by 0.1 mm each time. Either the part cracks on insertion or the bearing spins freely.',
    quote:
      "608 bearing, 22 mm bore in the model, and it either cracks the part or spins loose. I've printed six versions changing the diameter by 0.1 mm each time.",
    hoursAgo: 44,
    relevance: 86,
    painPoint: 'Exact dimensions & tolerances',
    intent: 'medium',
    engagement: { replies: 34, upvotes: 188 },
    status: 'new',
  },
  {
    id: 't5',
    source: 'reddit',
    community: 'r/BambuLab',
    title: 'Is there a way to make a model where I can just change the measurements later?',
    url: 'https://www.reddit.com/r/BambuLab/search/?q=parametric+model',
    author: 'u/ams_andy',
    snippet:
      'Built a drawer divider for one drawer, now need a slightly different size for the next one and it looks like I have to start over.',
    quote:
      "I made a drawer divider in Tinkercad and now I need it 4 mm narrower for the other drawer. I have to redo the whole thing because I can't just change one number.",
    hoursAgo: 54,
    relevance: 83,
    painPoint: 'Parametric tweaks',
    intent: 'high',
    engagement: { replies: 19, upvotes: 77 },
    status: 'saved',
  },
  {
    id: 't6',
    source: 'hackernews',
    community: 'Hacker News',
    title: "Ask HN: Is anyone using LLMs to generate CAD that's actually manufacturable?",
    url: 'https://hn.algolia.com/?q=LLM+CAD+STEP',
    author: 'bracketbuilder',
    snippet:
      'Looking for tools that output real solid geometry with exact dimensions rather than meshes. Curious what people use for quick functional parts.',
    quote:
      'Every demo I see outputs a mesh. That is fine for a render, but I need a STEP file with real dimensions I can hand to a printer or a machine shop.',
    hoursAgo: 63,
    relevance: 91,
    painPoint: "AI meshes aren't printable",
    intent: 'medium',
    engagement: { replies: 112, upvotes: 287 },
    status: 'new',
  },
  {
    id: 't7',
    source: 'x',
    community: 'X',
    title: 'Spent a Saturday learning Fusion 360 to make a 3 cm spacer',
    url: 'https://x.com/search?q=fusion%20360%20learning%20curve&f=live',
    author: '@nozzle_nina',
    snippet: 'Thread on how steep the on-ramp is for people who only need simple functional parts now and then.',
    quote:
      "Spent 4 hours in Fusion learning what a 'sketch constraint' is so I could print a 3 cm spacer. There has to be a better on-ramp for people who just need simple parts.",
    hoursAgo: 74,
    relevance: 78,
    painPoint: 'CAD learning curve',
    intent: 'medium',
    engagement: { replies: 31, upvotes: 264 },
    status: 'new',
  },
  {
    id: 't8',
    source: 'reddit',
    community: 'r/functionalprint',
    title: 'Replacement knob for a 20-year-old stand mixer — 6 mm D-shaft, discontinued everywhere',
    url: 'https://www.reddit.com/r/functionalprint/search/?q=replacement+knob',
    author: 'u/clamp_it_carl',
    snippet:
      'Have the measurements, have the printer, but every attempt either slips on the shaft or will not go on at all.',
    quote:
      "The original part has been discontinued for years. I know the shaft is 6 mm with a flat, I just can't turn those numbers into a model that fits the first time.",
    hoursAgo: 90,
    relevance: 90,
    painPoint: 'Replacement parts',
    intent: 'high',
    engagement: { replies: 27, upvotes: 203 },
    status: 'saved',
  },
  {
    id: 't9',
    source: 'linkedin',
    community: 'LinkedIn',
    title: 'Hardware founders: how are you handling quick fixture and jig iterations?',
    url: 'https://www.linkedin.com/search/results/content/?keywords=hardware%20fixtures%203d%20printing',
    author: 'Priya R.',
    snippet:
      'Small hardware team; every jig, fixture and test bracket goes through one mechanical engineer, which slows the whole build cycle.',
    quote:
      "Our ME is the bottleneck for every little jig and fixture. I'd love for the rest of the team to describe a part and get something printable with real dimensions, without waiting a week.",
    hoursAgo: 101,
    relevance: 81,
    painPoint: 'CAD learning curve',
    intent: 'high',
    engagement: { replies: 18, upvotes: 132 },
    status: 'new',
  },
  {
    id: 't10',
    source: 'reddit',
    community: 'r/3Dprinting',
    title: 'Why is my 20 mm hole printing at 19.6 mm?',
    url: 'https://www.reddit.com/r/3Dprinting/search/?q=hole+dimensions+undersized',
    author: 'u/caliper_cass',
    snippet:
      'Designed a tube mount, hole came out undersized. Looking for a reliable way to get fits right without trial and error on every printer.',
    quote:
      "I designed a mount for a 20 mm tube and the hole came out 19.6. I get that FDM holes shrink, but I don't want to guess an offset every time I change printers or materials.",
    hoursAgo: 121,
    relevance: 76,
    painPoint: 'Exact dimensions & tolerances',
    intent: 'low',
    engagement: { replies: 45, upvotes: 233 },
    status: 'new',
  },
  {
    id: 't11',
    source: 'indiehackers',
    community: 'Indie Hackers',
    title: 'Selling customizable 3D-printed organizers — how do you handle custom sizes?',
    url: 'https://www.google.com/search?q=site%3Aindiehackers.com+3d+printing+custom+sizes',
    author: 'maker_mo',
    snippet:
      'Small shop selling printed desk and drawer organizers. Custom-size requests are the best customers and the biggest time sink.',
    quote:
      "Every third customer wants it 'just a bit wider'. Right now that means me reopening OpenSCAD, fixing variables that break other variables, and re-exporting by hand.",
    hoursAgo: 142,
    relevance: 72,
    painPoint: 'Parametric tweaks',
    intent: 'medium',
    engagement: { replies: 12, upvotes: 38 },
    status: 'new',
  },
  {
    id: 't12',
    source: 'producthunt',
    community: 'Product Hunt',
    title: 'Discussion: which text-to-3D tools export something you can actually edit?',
    url: 'https://www.producthunt.com/search?q=text%20to%203d',
    author: 'Leo T.',
    snippet:
      'Comparing generators for prototyping. Output looks impressive, but editing a mesh after the fact is painful for functional parts.',
    quote:
      "Generated models are fun, but the moment I need to move a hole 2 mm I'm stuck with a triangle soup I can't edit.",
    hoursAgo: 152,
    relevance: 68,
    painPoint: "AI meshes aren't printable",
    intent: 'medium',
    engagement: { replies: 9, upvotes: 54 },
    status: 'new',
  },
  {
    id: 't13',
    source: 'x',
    community: 'X',
    title: 'Customer sent a photo of a broken latch and asked if I can print one',
    url: 'https://x.com/search?q=3d%20printed%20replacement%20part&f=live',
    author: '@printfarm_ferg',
    snippet: 'Print-farm owner on how much time goes into modeling one-off replacement parts from photos and caliper readings.',
    quote:
      "Half my print-farm requests are 'can you make this broken part?' Modeling each one from a photo and a few caliper readings eats most of my week.",
    hoursAgo: 172,
    relevance: 64,
    painPoint: 'Replacement parts',
    intent: 'medium',
    engagement: { replies: 14, upvotes: 97 },
    status: 'new',
  },
  {
    id: 't14',
    source: 'hackernews',
    community: 'Hacker News',
    title: 'OpenSCAD is great until your model has 40 parameters',
    url: 'https://hn.algolia.com/?q=openscad+parameters',
    author: 'openscad_owen',
    snippet:
      'Discussion about code-CAD ergonomics: precise and reproducible, but dependency chains between variables get hard to follow.',
    quote:
      "I love that it's code, but once the model grows, changing one dimension means tracing which other variables depend on it. I'd happily trade some control for describing intent in plain words.",
    hoursAgo: 203,
    relevance: 58,
    painPoint: 'Parametric tweaks',
    intent: 'low',
    engagement: { replies: 47, upvotes: 131 },
    status: 'new',
  },
];

function makeThreads(now) {
  return THREAD_SEED.map(({ hoursAgo, ...t }) => ({
    ...t,
    engagement: { ...t.engagement },
    publishedAt: ago(now, hoursAgo),
  }));
}

/* ------------------------------------------------------------------ */
/* Trends + events (functions of now)                                  */
/* ------------------------------------------------------------------ */

function makeTrends(now) {
  return [
    {
      id: 'tr1',
      title: 'Text-to-CAD tools move from meshes to parametric models',
      summary:
        'Builders working on AI-for-hardware increasingly target solid, editable geometry (STEP, feature trees) instead of visual meshes, because functional parts need exact dimensions and later edits.',
      url: 'https://hn.algolia.com/?q=text+to+CAD',
      source: 'hackernews',
      publishedAt: ago(now, 6),
      tag: 'AI x CAD',
    },
    {
      id: 'tr2',
      title: 'Multi-material printing goes mainstream on desktop printers',
      summary:
        'Filament changers and multi-tool heads are now common on consumer machines, so makers design more parts that combine rigid and flexible materials — and need models that separate those regions cleanly.',
      url: 'https://www.reddit.com/r/3Dprinting/search/?q=multi+material',
      source: 'reddit',
      publishedAt: ago(now, 20),
      tag: 'Hardware',
    },
    {
      id: 'tr3',
      title: 'Makers lean into functional prints: brackets, mounts and repair parts',
      summary:
        'Community showcases feature more practical prints — replacement clips, cable management, jigs — where fit and strength matter more than looks.',
      url: 'https://www.reddit.com/r/functionalprint/top/?t=week',
      source: 'reddit',
      publishedAt: ago(now, 31),
      tag: 'Community',
    },
    {
      id: 'tr4',
      title: 'STEP and 3MF gain ground as the hand-off between CAD and slicers',
      summary:
        'More slicers and design tools read 3MF and STEP directly, preserving units, colors and editable geometry that plain STL files lose.',
      url: 'https://hn.algolia.com/?q=3MF+STEP+slicer',
      source: 'hackernews',
      publishedAt: ago(now, 52),
      tag: 'File formats',
    },
    {
      id: 'tr5',
      title: 'Hardware startups shorten prototype loops with in-house printing',
      summary:
        'Early hardware teams print fixtures, enclosures and test parts daily; the bottleneck is shifting from print time to how fast someone can produce an accurate model.',
      url: 'https://hn.algolia.com/?q=hardware+prototyping+3d+printing',
      source: 'hackernews',
      publishedAt: ago(now, 76),
      tag: 'Hardware startups',
    },
    {
      id: 'tr6',
      title: 'Code-CAD sees renewed interest alongside LLMs',
      summary:
        'Script-based modelers such as OpenSCAD and CadQuery pair naturally with language models, renewing interest in describing parts as parameters and intent rather than clicks.',
      url: 'https://www.reddit.com/r/openscad/',
      source: 'reddit',
      publishedAt: ago(now, 110),
      tag: 'Code-CAD',
    },
  ];
}

function makeEvent(now, { id, dayOffset, hour, minute, durationMin, ...rest }) {
  const start = atLocal(now, dayOffset, hour, minute);
  const end = new Date(start.getTime() + durationMin * 60 * 1000);
  return { id, ...rest, start: start.toISOString(), end: end.toISOString() };
}

function makeEvents(now) {
  return [
    makeEvent(now, {
      id: 'e1',
      title: 'Hardware founders meetup',
      dayOffset: 1,
      hour: 18,
      minute: 30,
      durationMin: 120,
      location: 'San Francisco, CA',
      format: 'in-person',
      url: 'https://www.meetup.com/find/?keywords=hardware%20startups',
      host: 'Local hardware founders group',
      why: 'A room of founders who need fixtures and enclosures yesterday — bring a part printed from a one-line Sculptex prompt.',
    }),
    makeEvent(now, {
      id: 'e2',
      title: 'AI x CAD demo night',
      dayOffset: 2,
      hour: 12,
      minute: 0,
      durationMin: 90,
      location: 'Online',
      format: 'virtual',
      url: 'https://lu.ma/discover',
      host: 'Community-run AI x CAD demo series',
      why: 'Five-minute demo slots: a live "sentence → STEP file → slicer" run is exactly the format, and the audience already cares about meshes vs. CAD.',
    }),
    makeEvent(now, {
      id: 'e3',
      title: 'Makerspace open night',
      dayOffset: 3,
      hour: 19,
      minute: 0,
      durationMin: 150,
      location: 'Boston, MA',
      format: 'in-person',
      url: 'https://www.meetup.com/find/?keywords=makerspace',
      host: 'Neighborhood makerspace volunteers',
      why: 'Hobbyists with a backlog of broken parts — the core Sculptex user. Watch first-timers try a prompt and note where they get stuck.',
    }),
    makeEvent(now, {
      id: 'e4',
      title: 'Office hours for early-stage hardware startups',
      dayOffset: 4,
      hour: 15,
      minute: 0,
      durationMin: 120,
      location: 'New York, NY',
      format: 'in-person',
      url: 'https://lu.ma/discover',
      host: 'Volunteer hardware founder mentors',
      why: 'Get pricing and positioning feedback from people who have shipped hardware and paid for quick-turn CAD work.',
    }),
    makeEvent(now, {
      id: 'e5',
      title: '3D printing & CAD meetup',
      dayOffset: 5,
      hour: 18,
      minute: 0,
      durationMin: 120,
      location: 'Austin, TX',
      format: 'in-person',
      url: 'https://www.meetup.com/find/?keywords=3d%20printing',
      host: 'Local 3D printing users group',
      why: 'Print-farm operators field "can you make this part?" requests daily — a strong early-adopter segment for describing parts in plain language.',
    }),
    makeEvent(now, {
      id: 'e6',
      title: 'Build-in-public founder hangout',
      dayOffset: 6,
      hour: 10,
      minute: 0,
      durationMin: 60,
      location: 'Online',
      format: 'virtual',
      url: 'https://lu.ma/discover',
      host: 'Online indie founder community',
      why: "Share this week's top pain points from Discover and get feedback on the scheduled post before it goes out.",
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* Sculptex demo render: isometric mechanical bracket as inline SVG     */
/* ------------------------------------------------------------------ */

function buildBracketSvg() {
  const W = 640;
  const H = 480;
  const S = 4;
  const C = Math.cos(Math.PI / 6);
  const raw = ([x, y, z]) => [(x - y) * C, (x + y) * 0.5 - z];

  const boundsPts = [
    [0, 0, 0], [60, 0, 0], [60, 48, 0], [0, 48, 0], [0, 0, 44], [6, 0, 44], [0, 48, 44],
  ].map(raw);
  const minX = Math.min(...boundsPts.map((p) => p[0]));
  const maxX = Math.max(...boundsPts.map((p) => p[0]));
  const minY = Math.min(...boundsPts.map((p) => p[1]));
  const maxY = Math.max(...boundsPts.map((p) => p[1]));
  const ox = W / 2 - ((minX + maxX) / 2) * S;
  const oy = H / 2 - ((minY + maxY) / 2) * S;

  const P = (p) => {
    const [u, v] = raw(p);
    return [ox + u * S, oy + v * S];
  };
  const f = (n) => n.toFixed(1);
  const pts = (arr) => arr.map((p) => P(p).map(f).join(',')).join(' ');
  const edge = 'stroke="#1E1B4B" stroke-opacity=".3" stroke-width="1" stroke-linejoin="round"';
  const poly = (arr, fill) => `<polygon points="${pts(arr)}" fill="${fill}" ${edge}/>`;
  const line = (a, b, attrs) => {
    const [x1, y1] = P(a);
    const [x2, y2] = P(b);
    return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ${attrs}/>`;
  };

  const N = 40;
  const circleTop = (cx, cy, z, r) =>
    Array.from({ length: N }, (_, i) => {
      const t = (i / N) * Math.PI * 2;
      return [cx + r * Math.cos(t), cy + r * Math.sin(t), z];
    });
  const circleSide = (x, cy, cz, r) =>
    Array.from({ length: N }, (_, i) => {
      const t = (i / N) * Math.PI * 2;
      return [x, cy + r * Math.cos(t), cz + r * Math.sin(t)];
    });
  let holeId = 0;
  const hole = (top, bottom) => {
    holeId += 1;
    const id = `hole${holeId}`;
    return (
      `<clipPath id="${id}"><polygon points="${pts(top)}"/></clipPath>` +
      `<polygon points="${pts(top)}" fill="url(#gWall)"/>` +
      `<g clip-path="url(#${id})"><polygon points="${pts(bottom)}" fill="#0F0B2E" fill-opacity=".88"/></g>` +
      `<polygon points="${pts(top)}" fill="none" stroke="#1E1B4B" stroke-opacity=".5" stroke-width="1"/>`
    );
  };

  // Ground grid on z = 0
  const grid = [];
  for (let x = -30; x <= 90; x += 10) grid.push(line([x, -30, 0], [x, 70, 0], ''));
  for (let y = -30; y <= 70; y += 10) grid.push(line([-30, y, 0], [90, y, 0], ''));
  const [shx, shy] = P([33, 22, 0]);

  // Body faces (painter's order: back to front)
  const faces = [
    poly([[60, 0, 0], [60, 40, 0], [60, 40, 6], [60, 0, 6]], 'url(#gRight)'),
    poly([[6, 0, 6], [60, 0, 6], [60, 40, 6], [6, 40, 6]], 'url(#gTop)'),
    poly([[6, 0, 6], [6, 40, 6], [6, 40, 44], [6, 0, 44]], 'url(#gRight)'),
    poly([[0, 0, 44], [6, 0, 44], [6, 40, 44], [0, 40, 44]], 'url(#gTop)'),
    poly([[0, 40, 0], [60, 40, 0], [60, 40, 6], [6, 40, 6], [6, 40, 44], [0, 40, 44]], 'url(#gLeft)'),
  ].join('');

  const r = 2.8;
  const holes = [
    hole(circleTop(45, 11, 6, r), circleTop(45, 11, 0, r)),
    hole(circleTop(45, 29, 6, r), circleTop(45, 29, 0, r)),
    hole(circleSide(6, 11, 32, r), circleSide(0, 11, 32, r)),
    hole(circleSide(6, 29, 32, r), circleSide(0, 29, 32, r)),
  ].join('');

  const gusset = [
    poly([[30, 18, 6], [30, 22, 6], [6, 22, 30], [6, 18, 30]], 'url(#gSlope)'),
    poly([[6, 22, 6], [30, 22, 6], [6, 22, 30]], 'url(#gLeft)'),
  ].join('');

  const hl = 'stroke="#FFFFFF" stroke-opacity=".55" stroke-width="1.2" stroke-linecap="round"';
  const highlights = [
    line([6, 40, 6], [60, 40, 6], hl),
    line([60, 0, 6], [60, 40, 6], hl),
    line([0, 40, 44], [6, 40, 44], hl),
    line([6, 0, 44], [6, 40, 44], hl),
    line([30, 22, 6], [6, 22, 30], hl),
  ].join('');

  // Dimension annotations
  const dim = 'stroke="#64748B" stroke-width="1"';
  const ext = 'stroke="#94A3B8" stroke-width=".8" stroke-dasharray="2 2"';
  const [lx, ly] = P([30, 53, 0]);
  const [vx, vy] = P([0, 51, 22]);
  const dims = [
    line([0, 41, 0], [0, 50, 0], ext),
    line([60, 41, 0], [60, 50, 0], ext),
    line([0, 48, 0], [60, 48, 0], dim),
    line([0, 46.8, 0], [0, 49.2, 0], dim),
    line([60, 46.8, 0], [60, 49.2, 0], dim),
    `<text x="${f(lx)}" y="${f(ly)}" transform="rotate(30 ${f(lx)} ${f(ly)})" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12" fill="#475569">60.00 mm</text>`,
    line([0, 41, 44], [0, 50, 44], ext),
    line([0, 48, 0], [0, 48, 44], dim),
    line([0, 46.8, 44], [0, 49.2, 44], dim),
    `<text x="${f(vx)}" y="${f(vy)}" transform="rotate(-90 ${f(vx)} ${f(vy)})" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12" fill="#475569">44.00 mm</text>`,
  ].join('');

  const labels =
    `<text x="24" y="448" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11" letter-spacing="1.5" fill="#4F46E5">SCULPTEX · DEMO RENDER</text>` +
    `<text x="24" y="466" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11" fill="#64748B">L-bracket · 60 × 40 × 44 mm · 2× Ø5.6 per face</text>` +
    `<g transform="translate(${W - 24} 28)"><rect x="-92" y="-14" width="92" height="22" rx="11" fill="#EEF2FF" stroke="#C7D2FE"/>` +
    `<text x="-46" y="1" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10.5" fill="#4338CA">STEP · 3MF</text></g>`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>` +
    `<linearGradient id="gBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F8FAFC"/><stop offset="1" stop-color="#E2E8F0"/></linearGradient>` +
    `<radialGradient id="gGlow" cx=".5" cy=".38" r=".6"><stop offset="0" stop-color="#EEF2FF" stop-opacity=".95"/><stop offset="1" stop-color="#EEF2FF" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="gShadow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#1E293B" stop-opacity=".28"/><stop offset=".6" stop-color="#1E293B" stop-opacity=".08"/><stop offset="1" stop-color="#1E293B" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="gFade" cx=".5" cy=".55" r=".5"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#000000"/></radialGradient>` +
    `<mask id="gridMask"><rect width="${W}" height="${H}" fill="url(#gFade)"/></mask>` +
    `<linearGradient id="gTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E0E7FF"/><stop offset="1" stop-color="#A5B4FC"/></linearGradient>` +
    `<linearGradient id="gRight" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#818CF8"/><stop offset="1" stop-color="#4F46E5"/></linearGradient>` +
    `<linearGradient id="gLeft" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4338CA"/><stop offset="1" stop-color="#312E81"/></linearGradient>` +
    `<linearGradient id="gSlope" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C7D2FE"/><stop offset="1" stop-color="#6366F1"/></linearGradient>` +
    `<linearGradient id="gWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#312E81"/><stop offset="1" stop-color="#6366F1"/></linearGradient>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="url(#gBg)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#gGlow)"/>` +
    `<g mask="url(#gridMask)" stroke="#64748B" stroke-opacity=".22" stroke-width=".8">${grid.join('')}</g>` +
    `<ellipse cx="${f(shx)}" cy="${f(shy + 10)}" rx="230" ry="105" fill="url(#gShadow)"/>` +
    dims +
    faces +
    holes +
    gusset +
    highlights +
    labels +
    `</svg>`;

  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

const sculptexDemoRender = buildBracketSvg();

const sculptexDemoPrompt =
  'L-bracket, 60 × 40 mm base and 44 mm upright, 6 mm thick, center gusset, two Ø5.6 mm clearance holes on each face';

/* ------------------------------------------------------------------ */
/* Draft templates                                                     */
/* ------------------------------------------------------------------ */

const PLAYBOOK = {
  'Replacement parts': {
    empathy:
      'that one is painfully familiar — a tiny part breaks, the replacement is discontinued or absurdly priced, and the printer is right there.',
    tips: [
      'Measure the mating features first (shaft diameter and flat, hole spacing, the wall it clips onto) and write them on a sketch before modeling anything.',
      'Print only the interface first — a thin slice with the hole or clip — so a bad fit costs five minutes instead of two hours.',
      'If it lives near heat or under constant load, PETG or ASA hold up much better than PLA, which slowly creeps.',
    ],
    prompt: 'a clip 18 mm wide that snaps onto a 6 mm rod, 2 mm walls, 0.3 mm clearance',
    ask: 'hear what made this particular part hard to model',
    offer: 'model the part from your measurements and send you the STEP and 3MF',
    postHook:
      "A small plastic part breaks, the replacement is discontinued or absurdly priced, and there's a 3D printer three feet away. Most people still get stuck.",
    postInsight:
      'The printer is rarely the bottleneck. Turning "6 mm shaft with a flat" into a model that fits on the first try is.',
    question:
      "What's the last part you had to replace — and did you end up printing it, buying it, or giving up?",
  },
  "AI meshes aren't printable": {
    empathy:
      'that gap between a nice-looking preview and something that actually prints and fits is real.',
    tips: [
      'Run the mesh through your slicer\'s repair step and look for non-manifold edges and walls thinner than about 2× your nozzle width before you print.',
      'For anything that has to mate with another object, model the critical dimensions explicitly — a mesh generator will only get them "about right".',
      'If you expect to edit it later, keep a STEP or 3MF from a CAD tool rather than an STL; triangles are very hard to change precisely.',
    ],
    prompt: 'phone mount for a 78 mm wide phone, 2.4 mm walls, 15° tilt, two M4 screw holes',
    ask: 'hear what you ended up having to fix by hand',
    offer: 'generate the part with exact dimensions and send you the editable file to compare',
    postHook:
      'AI can generate a 3D model from a sentence now. Getting one that prints and fits is a different problem.',
    postInsight:
      'A render only has to look right. A functional part has to be manifold, have walls your nozzle can actually lay down, hit the dimensions of whatever it mates with — and stay editable when it does not.',
    question:
      'Has anyone gotten an AI-generated model to print and fit without remodeling it? What did you have to fix?',
  },
  'CAD learning curve': {
    empathy:
      'you are definitely not alone — a lot of people want a handful of simple parts, not a new hobby in CAD.',
    tips: [
      'Learn just three operations first: sketch a rectangle or circle, extrude, and cut. That covers most brackets, spacers and boxes.',
      'Put the key sizes into named parameters from day one (Fusion 360 and Onshape both support this) so resizing later is one change.',
      'Draw the part on paper with every dimension before opening any software — most of the struggle is deciding the numbers, not the clicks.',
    ],
    prompt: 'enclosure 80 × 50 × 30 mm with four M3 standoffs and a USB-C cutout on the short side',
    ask: 'understand which part of the CAD workflow cost you the most time',
    offer: 'turn a description of the part into a model and send it over so you can see whether it fits your use',
    postHook:
      "Lots of people who own a 3D printer will never learn CAD — and they shouldn't have to in order to print a simple bracket.",
    postInsight:
      'The hard part usually is not the geometry. It is the hours of sketch constraints and UI before you can make a box with four holes in it.',
    question:
      "If you print but don't do CAD: what's the simplest part you wish you could just describe?",
  },
  'Exact dimensions & tolerances': {
    empathy:
      'dialing in fits is one of those things nobody warns you about until you have a pile of test prints.',
    tips: [
      'Print a small tolerance test (pegs and holes stepping by 0.05–0.1 mm) once per printer and material, and keep the numbers in a note.',
      'FDM holes usually print undersized; try your slicer\'s hole or XY compensation setting before changing the model itself.',
      'For press fits, a few small crush ribs are much more forgiving than a perfectly round bore.',
    ],
    prompt: 'bearing seat for a 608 bearing, 22 mm bore, press fit with 0.1 mm interference and three crush ribs',
    ask: 'hear which fits give you the most trouble',
    offer: 'generate a version with the clearance as an editable parameter so you can step it without remodeling',
    postHook: 'Designed it at 20 mm. Printed at 19.6. Every maker has a version of this story.',
    postInsight:
      'Fit is a property of the printer, the material and the design together. A model with the right nominal size can still be wrong on your machine — so the clearance should be a number you can change, not something baked in.',
    question: "What's your go-to method for dialing in fits on a new printer or material?",
  },
  'Parametric tweaks': {
    empathy:
      '"same part, slightly different size" should be a ten-second change, and it rarely is.',
    tips: [
      'Pull every dimension that might change into a named variable at the top, and derive the rest from those.',
      'Keep the exposed parameters to the 3–5 numbers someone would actually change; everything else should follow from them.',
      "If you are in OpenSCAD, Customizer comments turn those variables into a form, so you're not editing code for each size.",
    ],
    prompt: 'drawer divider 120 mm long, 40 mm tall, 2 mm thick, with the length as a parameter',
    ask: 'hear how you handle custom sizes today',
    offer: 'set the part up with the dimensions you change most as parameters and send it over',
    postHook: '"Can you make it 4 mm narrower?" should be a ten-second change, not a remodel.',
    postInsight:
      'Models built without parameters work exactly once. The second size is where people end up starting over.',
    question: 'How do you handle "same part, slightly different size" requests today?',
  },
};

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:—-]+$/, '') + '…';
}

function lowerFirst(text) {
  const s = String(text || '').trim().replace(/[.!]+$/, '');
  if (!s) return '';
  // Keep acronyms / product-like words ("3D", "CAD") intact.
  if (/^[A-Z0-9]{2,}/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function greetingName(author) {
  const a = String(author || '').trim();
  if (!a) return 'there';
  if (/\s/.test(a)) return a.split(/\s+/)[0];
  return a.replace(/^u\//, '');
}

function listJoin(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list.join('');
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function isMakerProduct(company) {
  const hay = `${company?.name || ''} ${company?.field || ''} ${company?.description || ''}`;
  return /3d|cad|print|sculptex|parametric/i.test(hay);
}

function productLine(company) {
  const name = company?.name || 'our product';
  const what = lowerFirst(company?.tagline) || lowerFirst(clip(company?.description, 140));
  return what ? `${name} — ${what}` : name;
}

/**
 * Public reply to a thread. Leads with practical help, paraphrases the
 * person's own words, and discloses the founder affiliation.
 */
export function replyTemplate(thread, company) {
  const t = thread || {};
  const pb = PLAYBOOK[t.painPoint];
  const name = company?.name || 'our product';
  const said = clip(t.quote || t.snippet || t.title, 120);
  const lines = [];

  if (pb) {
    lines.push(`"${said}" — ${pb.empathy}`);
    lines.push('');
    lines.push('A few things that have helped me:');
    pb.tips.forEach((tip) => lines.push(`- ${tip}`));
  } else {
    lines.push(`"${said}" — thanks for writing this up so clearly; it's a problem I've run into too.`);
    lines.push('');
    lines.push(
      'What has helped me most is writing down the exact constraints first (sizes, what it has to fit, what it must survive) before picking a tool, then testing the riskiest part in isolation.'
    );
  }

  lines.push('');
  const disclosure = [`Full disclosure: I'm the founder of ${productLine(company)}.`];
  if (pb && isMakerProduct(company)) {
    disclosure.push(
      `You can describe a part the way you'd say it out loud — e.g. "${pb.prompt}" — and get an editable model you can take into your slicer.`
    );
    disclosure.push(`Happy to ${pb.offer} if that's useful. No pressure either way; the tips above work without it.`);
  } else {
    disclosure.push(
      `If it's relevant, I'm happy to show how ${name} handles this — but the approach above works regardless of tools.`
    );
  }
  lines.push(disclosure.join(' '));

  return lines.join('\n');
}

/**
 * Private, low-pressure direct message. References the specific post and
 * asks permission rather than pitching.
 */
export function dmTemplate(thread, company) {
  const t = thread || {};
  const pb = PLAYBOOK[t.painPoint];
  const name = company?.name || 'our product';
  const url = company?.url ? ` (${company.url})` : '';
  const where = t.community ? ` on ${t.community}` : '';
  const said = clip(t.quote || t.snippet, 130);
  const lines = [];

  lines.push(`Hi ${greetingName(t.author)} — I came across your post "${clip(t.title, 90)}"${where}.`);
  if (said) lines.push(`This line stuck with me: "${said}"`);
  lines.push('');
  lines.push(
    `Full disclosure: I'm the founder of ${name}${url} — ${lowerFirst(company?.tagline) || lowerFirst(clip(company?.description, 120)) || 'we work on exactly this problem'}.`
  );
  if (pb) {
    lines.push(
      `I'm not trying to sell you anything here — I'd genuinely like to ${pb.ask}.${isMakerProduct(company) ? ` If it's helpful, I could also ${pb.offer}, free.` : ''}`
    );
  } else {
    lines.push("I'm not trying to sell you anything here — I'd genuinely like to hear how you handle this today.");
  }
  lines.push('');
  lines.push('Totally fine to ignore this. Thanks for posting it either way.');

  return lines.join('\n');
}

/**
 * Public post built from a recurring pain point. Paraphrases what people said
 * (without naming individuals), offers practical advice, discloses affiliation,
 * and ends with an open question.
 */
export function postTemplate(painPoint, threads, company) {
  const label = painPoint || 'this problem';
  const pb = PLAYBOOK[painPoint];
  const all = Array.isArray(threads) ? threads : [];
  const related = all.filter((t) => t && t.painPoint === painPoint);
  const pool = related.length ? related : all;
  const communities = [...new Set(pool.map((t) => t.community).filter(Boolean))].slice(0, 3);
  const quotes = pool
    .filter((t) => t.quote)
    .slice()
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
    .slice(0, 2);
  const lines = [];

  lines.push(pb ? pb.postHook : `I keep seeing the same problem come up: ${label.toLowerCase()}.`);
  lines.push('');

  if (pool.length) {
    const n = pool.length;
    const whereText = communities.length ? ` across ${listJoin(communities)}` : '';
    lines.push(
      `Over the last few days I read ${n} conversation${n === 1 ? '' : 's'} about this${whereText}.${quotes.length ? ` ${quotes.length === 1 ? 'One' : 'Two'} that stuck with me:` : ''}`
    );
    quotes.forEach((t) => lines.push(`“${clip(t.quote, 170)}” — someone on ${t.community || 'a maker forum'}`));
    lines.push('');
  }

  if (pb) {
    lines.push(pb.postInsight);
    lines.push('');
    lines.push('What actually helps, whatever tools you use:');
    pb.tips.forEach((tip, i) => lines.push(`${i + 1}. ${tip}`));
    lines.push('');
  }

  const name = company?.name || 'our product';
  if (pb && isMakerProduct(company)) {
    lines.push(
      `Disclosure: I'm building ${productLine(company)}. It's our attempt at closing this gap — you describe the part in plain language, get an exact parametric model, and can still change any dimension before sending it to your slicer.`
    );
  } else {
    lines.push(`Disclosure: I'm building ${productLine(company)}, so I think about ${name}'s users and this problem a lot.`);
  }
  lines.push('');
  lines.push(pb ? pb.question : `How do you deal with ${label.toLowerCase()} today?`);
  if (isMakerProduct(company)) {
    lines.push('');
    lines.push('#3Dprinting #CAD #makers');
  }

  return lines.join('\n');
}

const VISUAL_IDEAS = {
  'Replacement parts': 'Close-up of the snapped original clip next to its printed replacement, calipers in frame',
  "AI meshes aren't printable": 'Before/after: a glossy AI mesh preview next to the clean, manifold parametric part that actually printed',
  'CAD learning curve': 'A sticky note with one sentence on it, and the part it turned into',
  'Exact dimensions & tolerances': 'A tolerance test strip with pegs stepping by 0.05 mm, the one that fits circled',
  'Parametric tweaks': 'Three sizes of the same part in a row, generated from one model with one number changed',
};

/** Suggested visual concept + Sculptex prompt for a pain point (falls back to the demo bracket). */
export function postVisual(painPoint) {
  const pb = PLAYBOOK[painPoint];
  return {
    visualIdea: VISUAL_IDEAS[painPoint] || `A clean render of a part that solves "${painPoint || 'this problem'}"`,
    sculptexPrompt: pb ? pb.prompt : sculptexDemoPrompt,
  };
}

/**
 * A different angle on the same pain point (used when "Generate more" revisits a topic):
 * leads with one concrete tip, quotes a different conversation, discloses, ends with a question.
 */
export function altPostTemplate(painPoint, threads, company, variant = 1) {
  const label = painPoint || 'this problem';
  const pb = PLAYBOOK[painPoint];
  const all = Array.isArray(threads) ? threads : [];
  const related = all.filter((t) => t && t.painPoint === painPoint && t.quote);
  const pool = (related.length ? related : all.filter((t) => t && t.quote)).slice().sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
  const v = Math.max(1, Number(variant) || 1);
  const quoteThread = pool.length ? pool[v % pool.length] : null;
  const tip = pb ? pb.tips[v % pb.tips.length] : '';
  const hooks = [
    `One thing I wish someone had told me about ${lowerFirst(label)}:`,
    `The most useful fix I've seen for ${lowerFirst(label)} takes five minutes:`,
    `A small habit that makes ${lowerFirst(label)} a lot less painful:`,
  ];
  const lines = [hooks[(v - 1) % hooks.length], ''];
  if (tip) lines.push(tip, '');
  if (quoteThread) lines.push(`Someone on ${quoteThread.community || 'a maker forum'} put the problem better than I could: “${clip(quoteThread.quote, 170)}”`, '');
  if (pb) lines.push(pb.postInsight, '');
  lines.push(`Disclosure: I'm building ${productLine(company)}, so I spend a lot of time on exactly this.`, '');
  lines.push(pb ? pb.question : `How do you deal with ${lowerFirst(label)} today?`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Sample drafts (function of now)                                     */
/* ------------------------------------------------------------------ */

function makeDrafts(now) {
  const n = toDate(now);
  const threads = makeThreads(n);
  const byId = Object.fromEntries(threads.map((t) => [t.id, t]));
  const scheduled = atLocal(n, 2, 9, 30);

  return [
    {
      id: 'd1',
      kind: 'reply',
      threadId: 't1',
      body: replyTemplate(byId.t1, company),
      status: 'pending',
      createdAt: ago(n, 0.7),
      updatedAt: ago(n, 0.7),
      channel: 'copy',
      painPoint: byId.t1.painPoint,
    },
    {
      id: 'd2',
      kind: 'dm',
      threadId: 't9',
      body: dmTemplate(byId.t9, company),
      status: 'pending',
      createdAt: ago(n, 2.5),
      updatedAt: ago(n, 2.5),
      channel: 'linkedin',
      painPoint: byId.t9.painPoint,
    },
    {
      id: 'd3',
      kind: 'post',
      title: 'Why replacement parts are still hard to print',
      body: postTemplate('Replacement parts', threads, company),
      status: 'scheduled',
      createdAt: ago(n, 20),
      updatedAt: ago(n, 3),
      scheduledFor: scheduled.toISOString(),
      channel: 'linkedin',
      painPoint: 'Replacement parts',
      visual: {
        type: 'sculptex',
        src: sculptexDemoRender,
        renderUrl: sculptexDemoRender,
        caption: `Sculptex render: ${sculptexDemoPrompt}`,
      },
    },
    ...makeSuggestions(n),
  ];
}

/* ------------------------------------------------------------------ */
/* v2: suggested posts for the swipe stack (pending, function of now)  */
/* ------------------------------------------------------------------ */

const SUGGESTION_SEED = [
  {
    id: 's1',
    painPoint: 'Exact dimensions & tolerances',
    threadIds: ['t4', 't10'],
    hoursAgo: 0.3,
    visualIdea: 'Side-by-side: a 608 bearing seat with three crush ribs, labelled 22.0 mm nominal vs 21.9 mm printed',
  },
  {
    id: 's2',
    painPoint: "AI meshes aren't printable",
    threadIds: ['t2', 't6', 't12'],
    hoursAgo: 0.6,
    visualIdea: 'Before/after: a glossy AI mesh preview next to the clean, manifold parametric phone mount that actually printed',
  },
  {
    id: 's3',
    painPoint: 'CAD learning curve',
    threadIds: ['t3', 't7', 't9'],
    hoursAgo: 0.9,
    visualIdea: 'A sticky note with one sentence on it, and the enclosure it turned into — standoffs and USB-C cutout visible',
  },
  {
    id: 's4',
    painPoint: 'Parametric tweaks',
    threadIds: ['t5', 't11', 't14'],
    hoursAgo: 1.2,
    visualIdea: 'Three drawer dividers in a row — 100, 120 and 140 mm — generated from the same model with one number changed',
  },
];

function trendSuggestionBody(trend) {
  return [
    'Text-to-3D is quietly splitting into two different products.',
    '',
    `One makes things that look right. The other makes things that fit. ${trend.summary}`,
    '',
    'For a game asset or a concept render, a good-looking mesh is enough. For a bracket, a clip or an enclosure, you need exact dimensions, real wall thicknesses, and a model you can still edit when the first print is 0.3 mm off.',
    '',
    'Disclosure: I build Sculptex, which sits firmly in the second camp — plain-language descriptions in, editable parametric parts out.',
    '',
    'If you print functional parts: which matters more to you right now — speed to a first model, or being able to change it afterwards?',
  ].join('\n');
}

function makeSuggestions(now) {
  const n = toDate(now);
  const threads = makeThreads(n);
  const out = SUGGESTION_SEED.map((seed) => {
    const pb = PLAYBOOK[seed.painPoint] || {};
    const related = threads.filter((t) => seed.threadIds.includes(t.id));
    return {
      id: seed.id,
      kind: 'post',
      title: '',
      body: postTemplate(seed.painPoint, related, company),
      status: 'pending',
      createdAt: ago(n, seed.hoursAgo),
      updatedAt: ago(n, seed.hoursAgo),
      channel: 'linkedin',
      painPoint: seed.painPoint,
      source: { type: 'pain', label: seed.painPoint, threadIds: seed.threadIds.slice() },
      visualIdea: seed.visualIdea,
      sculptexPrompt: pb.prompt || sculptexDemoPrompt,
    };
  });
  const trend = makeTrends(n)[0];
  out.push({
    id: 's5',
    kind: 'post',
    title: '',
    body: trendSuggestionBody(trend),
    status: 'pending',
    createdAt: ago(n, 1.5),
    updatedAt: ago(n, 1.5),
    channel: 'linkedin',
    source: { type: 'trend', label: trend.title, threadIds: [], trendId: trend.id },
    visualIdea: 'A split image: a pretty but broken AI mesh on the left, a dimensioned parametric L-bracket on the right',
    sculptexPrompt: sculptexDemoPrompt,
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* v2: mock LinkedIn history for Analytics (function of now)           */
/* ------------------------------------------------------------------ */

// Past activity over the last ~5 weeks. Times vary by weekday/time-of-day so the "best time" heatmap has signal.
const FEED_SEED = [
  { id: 'li_seed_1', kind: 'post', daysAgo: 3, hour: 9, minute: 30, painPoint: 'Replacement parts', impressions: 4820, reactions: 168, comments: 41, reposts: 12, profileViews: 63 },
  { id: 'li_seed_2', kind: 'post', daysAgo: 6, hour: 12, minute: 0, painPoint: "AI meshes aren't printable", impressions: 6310, reactions: 241, comments: 57, reposts: 19, profileViews: 88 },
  { id: 'li_seed_3', kind: 'post', daysAgo: 9, hour: 17, minute: 45, painPoint: 'Parametric tweaks', impressions: 1490, reactions: 38, comments: 6, reposts: 1, profileViews: 14 },
  { id: 'li_seed_4', kind: 'post', daysAgo: 12, hour: 8, minute: 0, painPoint: 'Exact dimensions & tolerances', impressions: 3975, reactions: 132, comments: 35, reposts: 9, profileViews: 47 },
  { id: 'li_seed_5', kind: 'post', daysAgo: 15, hour: 10, minute: 0, painPoint: 'CAD learning curve', impressions: 5240, reactions: 189, comments: 49, reposts: 15, profileViews: 71 },
  { id: 'li_seed_6', kind: 'post', daysAgo: 19, hour: 19, minute: 30, painPoint: 'Replacement parts', impressions: 1210, reactions: 29, comments: 4, reposts: 0, profileViews: 9 },
  { id: 'li_seed_7', kind: 'post', daysAgo: 22, hour: 9, minute: 15, painPoint: 'Exact dimensions & tolerances', impressions: 2860, reactions: 87, comments: 22, reposts: 5, profileViews: 31 },
  { id: 'li_seed_8', kind: 'post', daysAgo: 26, hour: 11, minute: 30, painPoint: "AI meshes aren't printable", impressions: 3420, reactions: 104, comments: 27, reposts: 8, profileViews: 39 },
  { id: 'li_seed_9', kind: 'post', daysAgo: 30, hour: 14, minute: 0, painPoint: 'CAD learning curve', impressions: 1980, reactions: 52, comments: 11, reposts: 2, profileViews: 18 },
  { id: 'li_seed_10', kind: 'post', daysAgo: 34, hour: 8, minute: 30, painPoint: 'Parametric tweaks', impressions: 2340, reactions: 66, comments: 14, reposts: 3, profileViews: 22 },
  { id: 'li_seed_11', kind: 'reply', daysAgo: 4, hour: 13, minute: 10, painPoint: 'Replacement parts', threadId: 't8', impressions: 0, reactions: 3, comments: 1, reposts: 0, profileViews: 2 },
  { id: 'li_seed_12', kind: 'dm', daysAgo: 8, hour: 16, minute: 20, painPoint: 'CAD learning curve', threadId: 't9', impressions: 0, reactions: 0, comments: 1, reposts: 0, profileViews: 1 },
  { id: 'li_seed_13', kind: 'reply', daysAgo: 17, hour: 10, minute: 40, painPoint: 'Exact dimensions & tolerances', threadId: 't10', impressions: 0, reactions: 5, comments: 2, reposts: 0, profileViews: 3 },
];

function feedPostBody(painPoint) {
  const pb = PLAYBOOK[painPoint];
  if (!pb) return `Something I keep hearing from makers: ${painPoint.toLowerCase()}.`;
  return [pb.postHook, '', pb.postInsight, '', `One thing that helps: ${pb.tips[0]}`, '', pb.question].join('\n');
}

function makeLinkedinFeed(now) {
  const n = toDate(now);
  const threads = makeThreads(n);
  const byId = Object.fromEntries(threads.map((t) => [t.id, t]));
  return FEED_SEED.map(({ daysAgo, hour, minute, threadId, ...rest }) => {
    const at = atLocal(n, -daysAgo, hour, minute);
    const thread = threadId ? byId[threadId] : null;
    let body;
    if (rest.kind === 'post') body = feedPostBody(rest.painPoint);
    else if (rest.kind === 'dm') body = dmTemplate(thread, company);
    else body = replyTemplate(thread, company);
    return {
      ...rest,
      draftId: null,
      body,
      to: thread ? thread.author || undefined : undefined,
      threadUrl: thread ? thread.url : undefined,
      at: at.toISOString(),
      demo: true,
    };
  });
}

/* ------------------------------------------------------------------ */
/* v2: scripted onboarding chat                                        */
/* ------------------------------------------------------------------ */

// Lines for the demo-mode onboarding chat. Each takes the founder's own words so replies feel heard.
const onboardingScript = {
  defaults: {
    pains: Object.keys(PLAYBOOK).slice(0, 4),
    channels: ['r/3Dprinting', 'r/functionalprint', 'r/cad', 'Hacker News'],
  },
  opener: (c) =>
    `I took a look at ${c?.name || 'your site'}${c?.tagline ? ` — "${String(c.tagline).replace(/\.$/, '')}"` : ''}${c?.field ? `, in ${c.field}` : ''}. Who is it for? Describe the person who feels this problem most — their role, and what they're trying to get done.`,
  askPains: (audience) =>
    `Got it — ${lowerFirst(clip(audience, 140))}. What do they struggle with most today? A few frustrations in their own words is perfect (commas are fine).`,
  askChannels: (pains) =>
    `"${clip(pains[0] || 'That', 80)}"${pains[1] ? ` and "${clip(pains[1], 60)}"` : ''} — that's exactly the kind of thing Lens can listen for. Where do these people hang out online? Subreddits, forums, communities, LinkedIn groups…`,
  ready: ({ channels, pains, voice }) =>
    `Perfect. I'll watch ${listJoin((channels || []).slice(0, 3)) || 'those communities'} for people describing ${pains && pains[0] ? `"${clip(pains[0], 60)}"` : 'this problem'}, and draft in a ${voice ? clip(lowerFirst(String(voice).split(/[.;(]/)[0]), 60) : 'helpful, maker-to-maker'} voice. Your audience profile is ready.`,
  skip: (c) =>
    `No problem — I've filled in the rest from what I learned about ${c?.name || 'your product'}. Here's the profile; you can tweak anything in Settings → Product later.`,
};

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export const demo = {
  company,
  competitorNotes,
  linkedinProfile,
  threads: makeThreads(new Date()),
  makeThreads: (now = new Date()) => makeThreads(now),
  trends: (now = new Date()) => makeTrends(now),
  events: (now = new Date()) => makeEvents(now),
  drafts: (now = new Date()) => makeDrafts(now),
  suggestions: (now = new Date()) => makeSuggestions(now),
  linkedinFeed: (now = new Date()) => makeLinkedinFeed(now),
  onboardingScript,
  sculptexDemoRender,
  sculptexDemoPrompt,
  painPoints: Object.keys(PLAYBOOK),
  templates: { replyTemplate, dmTemplate, postTemplate, altPostTemplate },
  postVisual,
};

export default demo;
