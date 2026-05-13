const https = require('https');
const http = require('http');

const API_TOKEN = process.env.CLICKUP_API_TOKEN;
const PORT = process.env.PORT || 3000;
// DASHBOARD_TOKEN: shared secret between frontend (index.html) and backend.
// When set, all routes except OPTIONS (CORS preflight) and /health require an
// X-Dashboard-Token header matching this value. Blocks random API scrapers.
// When NOT set (legacy / first-deploy state), auth is skipped — server logs a
// warning at startup. Set this in Railway env vars to activate enforcement.
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

const LIST_IDS = [
  '901712935558','901712935562','901712935566',
  '901712935573','901712935575','901712935581','901708395565',
];

const PILLAR_MAP = {
  '901712935558':'sops','901712935562':'onboard','901712935566':'referral',
  '901712935573':'kpi','901712935575':'hr','901712935581':'fin',
};

// Partner Outreach Pipeline (Neshel's partner tracking)
const PARTNER_LIST_ID = '901713563582';
const PARTNER_FIELDS = {
  contact_name: '0f640183-dec2-40ec-8fa0-ba477851c5a7',
  contact_info: '070cefed-1161-43b4-b794-4cb0782d4612',
  partner_type: 'f80aafb4-13db-4d53-94df-c4e8fa840634',
  last_touch:   '175e6d67-be03-46c1-a852-4db738fb593c',
  next_action:  '6f43c5f3-b426-47bb-bae0-84a43707a5e8',
};

// Referrals (Matt's actual referral records — separate from operational task list)
const REFERRAL_LIST_ID = '901713684670';
const REFERRAL_FIELDS = {
  source_name:    '1206ad7b-4f9a-4542-8aab-86e2ffb70aaa',
  source_type:    '1e4dd6fb-acf9-44fb-8f69-e8b678c9aa88',
  source_contact: '871fd9eb-e3e4-4f47-95c1-402f42ab8f5d',
  date_received:  'f8e8002a-ef72-4bd8-81c4-79dc0e83b1b0',
  asam_level:     'e7b796cb-f518-40b7-8b3b-615b65e0f24d',
  notes_outcome:  'f81a81c4-e7f6-41ca-869e-6fc62105dafc',
};

// AR Aging (Sheila's outstanding patient balances)
const AR_LIST_ID = '901713702311';
const AR_FIELDS = {
  amount:             '85115b0f-3bac-49fa-8c6a-65e40523e8de',
  date_of_service:    '745b467c-cd28-4429-ae42-3c1845728ade',
  reason_status_note: '16e09408-9d12-4f24-b786-e59287092718',
  payer:              '5ab08285-1454-485b-a994-e911bad0fa2f',
};

// Billing Reports — archive of Sheila's monthly billing PDFs.
// Each task is named "YYYY-MM" with the PDF attached. Created on first upload
// for that month; subsequent uploads for the same month replace the attachment.
const BILLING_REPORTS_LIST_ID = '901713712222';
const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB cap on uploaded PDFs

// Persistent state task — sharedState is JSON.stringify'd into this task's
// description after every POST /state, and hydrated from it on server boot.
// Survives Railway restarts. Single source of truth across replicas.
const STATE_TASK_ID = '86e1bu3ar';

// Shared state — persists in memory on the server, same for all users
// NOTE: snapshot key holds Operating Snapshot tile values (netDelta, partners,
// collection, incidents, plans72) so all admins see the same values.
// clinical_kpis is an array of Dr. Jennifer's weekly submissions, upserted by
// week_of (re-submitting the same week replaces, doesn't duplicate). Capped
// at 52 entries (one year) to prevent unbounded growth.
// operations_kpis follows the same pattern for Dylan's weekly snapshots
// (avg_census, admits, discharges).
// billing_kpis follows the same pattern for Sheila's monthly submissions
// (upserted by month_of "YYYY-MM" instead of week_of).
// marketing_kpis follows the weekly upsert pattern for Jamie's submissions
// (social_posts, inquiries, marketing_hours, ad_spend).
let sharedState = {
  census: 4,
  kpi: {},
  fin: {},
  snapshot: {},
  clinical_kpis: [],
  operations_kpis: [],
  billing_kpis: [],
  marketing_kpis: []
};

function classifyOpsTask(name) {
  const n = name.toLowerCase();
  if (['sop','consent forms','intake doc','admission criteria','insurance verif','orientation protocol','iddt','psychiatric eval','clinical team sync','mat manage','crisis protocol','phase advance','search and drug','off-site pass','incident report','discharge planning','billing submission','medical records','r501','dali','treatment plan','psych eval','stabilization','warm handoff'].some(k => n.includes(k))) return 'sops';
  if (['hiring process','transportation position','transportation staff','find transportation','job desc','compensation','background','credential','onboard','thinkific','gusto','simplepractice'].some(k => n.includes(k))) return 'onboard';
  if (['google','facebook','outreach','field outreach','referral','pipeline','waitlist','hospital','therapist'].some(k => n.includes(k))) return 'referral';
  if (['kpi','financial dashboard','collections','ar aging','payroll','payer'].some(k => n.includes(k))) return 'kpi';
  if (['financial dashboard','credentialing'].some(k => n.includes(k))) return 'fin';
  return 'hr';
}

function clickupRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.clickup.com',
      path: `/api/v2${path}`,
      method,
      headers: {
        'Authorization': API_TOKEN,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(responseData)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ───── Persistent state helpers (Approach B) ─────
// hydrateState: read the most recent comment on STATE_TASK_ID. Each persist
// posts a new comment containing the JSON blob; hydrate restores from the
// latest. We use comments instead of the task description because ClickUp's
// PUT /task silently drops description writes for this account. Comments work.
async function hydrateState() {
  if (!STATE_TASK_ID) return;
  try {
    const data = await clickupRequest('GET', `/task/${STATE_TASK_ID}/comment`);
    const comments = (data && data.comments) || [];
    if (!comments.length) {
      console.log('State hydrate: no comments yet, starting from defaults');
      return;
    }
    // Comments are typically returned in reverse-chronological order; sort to be safe.
    comments.sort((a, b) => parseInt(b.date || 0) - parseInt(a.date || 0));
    // Find the most recent comment that contains valid JSON (skip any manual
    // human-entered comments that aren't state blobs).
    for (const c of comments) {
      const text = (c.comment_text || '').trim();
      if (!text || text === '{}') continue;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          Object.assign(sharedState, parsed);
          const counts = {
            snapshot: Object.keys(sharedState.snapshot || {}).length,
            clinical: (sharedState.clinical_kpis || []).length,
            operations: (sharedState.operations_kpis || []).length,
            billing: (sharedState.billing_kpis || []).length,
            marketing: (sharedState.marketing_kpis || []).length
          };
          console.log('State hydrated from ClickUp comment ' + c.id + ':', JSON.stringify(counts));
          return;
        }
      } catch(parseErr) {
        // Not JSON — try the next-most-recent comment.
        continue;
      }
    }
    console.log('State hydrate: no valid JSON comment found, starting from defaults');
  } catch(e) {
    console.error('State hydrate failed:', e.message, '— continuing with defaults');
  }
}

// persistState: called fire-and-forget after every successful POST /state body
// merge. Writes JSON.stringify(sharedState) to the task description. Failures
// are logged but don't affect the response (state still lives in memory).
let _persistInFlight = false;
let _persistPending = false;
async function persistState() {
  if (!STATE_TASK_ID) return;
  // Coalesce concurrent writes: if one is already in flight, mark pending and
  // run another after it completes. Prevents losing the latest state to an
  // older writer that happened to finish later.
  if (_persistInFlight) { _persistPending = true; return; }
  _persistInFlight = true;
  try {
    const json = JSON.stringify(sharedState);
    // Persist by appending a comment to STATE_TASK_ID. Each comment is the
    // raw JSON blob. hydrateState reads the most recent one. Old comments
    // accumulate harmlessly (could be cleaned up periodically — phase 4 nice-to-have).
    const result = await clickupRequest('POST', `/task/${STATE_TASK_ID}/comment`, {
      comment_text: json,
      notify_all: false
    });
    if (result && (result.err || result.errors)) {
      console.error('State persist rejected by ClickUp:', JSON.stringify(result).slice(0, 200));
    } else if (result && result.id) {
      console.log('State persisted as comment ' + result.id + ' (' + json.length + ' bytes)');
    } else {
      console.log('State persist: response missing comment id');
    }
  } catch(e) {
    console.error('State persist failed:', e.message);
  } finally {
    _persistInFlight = false;
    if (_persistPending) {
      _persistPending = false;
      // Run another immediately to capture any state that arrived while we were busy.
      persistState();
    }
  }
}

async function getAllTasks() {
  const pillars = { sops:[], onboard:[], referral:[], kpi:[], hr:[], fin:[] };
  for (const listId of LIST_IDS) {
    try {
      const data = await clickupRequest('GET', `/list/${listId}/task?include_closed=true&subtasks=true`);
      const tasks = (data.tasks || []).map(t => ({
        id: t.id, name: t.name,
        status: t.status?.status || 'to do',
        assignees: (t.assignees || []).map(a => ({ id: a.id, username: a.username, email: a.email })),
        priority: t.priority?.priority || null,
        url: t.url, due_date: t.due_date, list: t.list?.name
      }));
      if (PILLAR_MAP[listId]) {
        pillars[PILLAR_MAP[listId]].push(...tasks);
      } else {
        tasks.forEach(t => { pillars[classifyOpsTask(t.name)].push(t); });
      }
    } catch(e) {
      console.error(`Error fetching list ${listId}:`, e.message);
    }
  }
  return pillars;
}

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getCachedTasks(force) {
  const now = Date.now();
  if (!force && cache && (now - cacheTime) < CACHE_TTL) return cache;
  console.log('Fetching fresh data from ClickUp...');
  cache = await getAllTasks();
  cacheTime = now;
  return cache;
}

// Outreach cache (separate from main task cache, shorter TTL)
let outreachCache = null;
let outreachCacheTime = 0;
const OUTREACH_TTL = 30 * 1000;

async function getOutreachTasks() {
  const data = await clickupRequest('GET', `/list/${PARTNER_LIST_ID}/task?include_closed=true&subtasks=false`);
  return (data.tasks || []).map(t => {
    const cf = { contact_name: '', contact_info: '', partner_type: '', partner_type_id: null, last_touch: null, next_action: '' };
    (t.custom_fields || []).forEach(f => {
      if (f.id === PARTNER_FIELDS.contact_name) cf.contact_name = f.value || '';
      else if (f.id === PARTNER_FIELDS.contact_info) cf.contact_info = f.value || '';
      else if (f.id === PARTNER_FIELDS.partner_type) {
        cf.partner_type_id = f.value || null;
        if (f.value !== undefined && f.value !== null && f.type_config && Array.isArray(f.type_config.options)) {
          const opt = f.type_config.options.find(o => o.id === f.value || o.orderindex === f.value);
          cf.partner_type = opt ? opt.name : '';
        }
      }
      else if (f.id === PARTNER_FIELDS.last_touch) cf.last_touch = f.value ? parseInt(f.value) : null;
      else if (f.id === PARTNER_FIELDS.next_action) cf.next_action = f.value || '';
    });
    return {
      id: t.id,
      name: t.name,
      status: t.status?.status || 'Cold',
      url: t.url,
      date_created: t.date_created,
      date_updated: t.date_updated,
      description: t.description || '',
      ...cf
    };
  });
}

async function getCachedOutreach(force) {
  const now = Date.now();
  if (!force && outreachCache && (now - outreachCacheTime) < OUTREACH_TTL) return outreachCache;
  console.log('Fetching outreach from ClickUp...');
  outreachCache = await getOutreachTasks();
  outreachCacheTime = now;
  return outreachCache;
}

// Referrals cache (mirrors outreach pattern)
let referralCache = null;
let referralCacheTime = 0;
const REFERRAL_TTL = 30 * 1000;

async function getReferralTasks() {
  const data = await clickupRequest('GET', `/list/${REFERRAL_LIST_ID}/task?include_closed=true&subtasks=false`);
  return (data.tasks || []).map(t => {
    const cf = { source_name: '', source_type: '', source_type_id: null, source_contact: '', date_received: null, asam_level: '', notes_outcome: '' };
    (t.custom_fields || []).forEach(f => {
      if (f.id === REFERRAL_FIELDS.source_name) cf.source_name = f.value || '';
      else if (f.id === REFERRAL_FIELDS.source_contact) cf.source_contact = f.value || '';
      else if (f.id === REFERRAL_FIELDS.source_type) {
        cf.source_type_id = f.value || null;
        if (f.value !== undefined && f.value !== null && f.type_config && Array.isArray(f.type_config.options)) {
          const opt = f.type_config.options.find(o => o.id === f.value || o.orderindex === f.value);
          cf.source_type = opt ? opt.name : '';
        }
      }
      else if (f.id === REFERRAL_FIELDS.date_received) cf.date_received = f.value ? parseInt(f.value) : null;
      else if (f.id === REFERRAL_FIELDS.asam_level) cf.asam_level = f.value || '';
      else if (f.id === REFERRAL_FIELDS.notes_outcome) cf.notes_outcome = f.value || '';
    });
    return {
      id: t.id,
      name: t.name,
      status: t.status?.status || 'New',
      url: t.url,
      date_created: t.date_created,
      date_updated: t.date_updated,
      description: t.description || '',
      ...cf
    };
  });
}

async function getCachedReferrals(force) {
  const now = Date.now();
  if (!force && referralCache && (now - referralCacheTime) < REFERRAL_TTL) return referralCache;
  console.log('Fetching referrals from ClickUp...');
  referralCache = await getReferralTasks();
  referralCacheTime = now;
  return referralCache;
}

// AR Aging cache (mirrors referrals pattern)
let arCache = null;
let arCacheTime = 0;
const AR_TTL = 30 * 1000;

async function getARTasks() {
  const data = await clickupRequest('GET', `/list/${AR_LIST_ID}/task?include_closed=true&subtasks=false`);
  return (data.tasks || []).map(t => {
    const cf = { amount: null, date_of_service: null, reason_status_note: '', payer: '' };
    (t.custom_fields || []).forEach(f => {
      if (f.id === AR_FIELDS.amount) cf.amount = (f.value !== undefined && f.value !== null) ? parseFloat(f.value) : null;
      else if (f.id === AR_FIELDS.date_of_service) cf.date_of_service = f.value ? parseInt(f.value) : null;
      else if (f.id === AR_FIELDS.reason_status_note) cf.reason_status_note = f.value || '';
      else if (f.id === AR_FIELDS.payer) cf.payer = f.value || '';
    });
    return {
      id: t.id,
      name: t.name,
      status: t.status?.status || 'Open',
      url: t.url,
      date_created: t.date_created,
      date_updated: t.date_updated,
      description: t.description || '',
      ...cf
    };
  });
}

async function getCachedAR(force) {
  const now = Date.now();
  if (!force && arCache && (now - arCacheTime) < AR_TTL) return arCache;
  console.log('Fetching AR Aging from ClickUp...');
  arCache = await getARTasks();
  arCacheTime = now;
  return arCache;
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch(e) { resolve({}); }
    });
  });
}

// ───── Billing report PDF helpers ─────
// Find a task in BILLING_REPORTS_LIST_ID named monthOf (e.g. "2026-04"); create it if missing.
async function findOrCreateBillingReportTask(monthOf) {
  const data = await clickupRequest('GET', `/list/${BILLING_REPORTS_LIST_ID}/task?include_closed=true&subtasks=false`);
  const existing = (data.tasks || []).find(t => t.name === monthOf);
  if (existing) return existing;
  const created = await clickupRequest('POST', `/list/${BILLING_REPORTS_LIST_ID}/task`, { name: monthOf });
  return created;
}

// Upload a binary file as a ClickUp task attachment using vanilla Node.js
// multipart/form-data — no external deps. Returns the parsed JSON response.
function clickupAttachmentUpload(taskId, filename, contentType, fileBuffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----BHBoundary' + Date.now() + Math.random().toString(36).slice(2);
    const safeName = String(filename || 'attachment.pdf').replace(/"/g, '');
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="attachment"; filename="${safeName}"\r\n` +
      `Content-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, fileBuffer, tail]);
    const options = {
      hostname: 'api.clickup.com',
      path: `/api/v2/task/${taskId}/attachment`,
      method: 'POST',
      headers: {
        'Authorization': API_TOKEN,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); }
        catch(e) { reject(new Error('Attachment response not JSON: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Origin, X-Dashboard-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];
  const query = req.url.includes('?') ? req.url.split('?')[1] : '';
  const force = query.includes('refresh=true');

  // Auth check — only enforced when DASHBOARD_TOKEN env var is set.
  // /health stays public (monitoring); everything else requires the header.
  if (DASHBOARD_TOKEN && url !== '/health') {
    const provided = req.headers['x-dashboard-token'];
    if (provided !== DASHBOARD_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'unauthorized — missing or invalid X-Dashboard-Token header' }));
      return;
    }
  }

  // GET tasks
  if (req.method === 'GET' && url === '/tasks') {
    try {
      const tasks = await getCachedTasks(force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: tasks, cached_at: new Date(cacheTime).toISOString() }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // GET shared state — census, kpi, fin data
  if (req.method === 'GET' && url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, state: sharedState }));
    return;
  }

  // POST shared state — only owner can update census
  if (req.method === 'POST' && url === '/state') {
    try {
      const body = await parseBody(req);
      // Merge incoming state with existing state
      if (body.census !== undefined) sharedState.census = body.census;
      if (body.kpi) sharedState.kpi = { ...sharedState.kpi, ...body.kpi };
      if (body.fin) sharedState.fin = { ...sharedState.fin, ...body.fin };
      if (body.snapshot) sharedState.snapshot = { ...sharedState.snapshot, ...body.snapshot };
      // Clinical KPI weekly submission — upsert by week_of, cap at 52 entries
      if (body.clinical_kpi_entry && body.clinical_kpi_entry.week_of) {
        sharedState.clinical_kpis = Array.isArray(sharedState.clinical_kpis) ? sharedState.clinical_kpis : [];
        const wk = body.clinical_kpi_entry.week_of;
        const idx = sharedState.clinical_kpis.findIndex(e => e && e.week_of === wk);
        if (idx >= 0) sharedState.clinical_kpis[idx] = body.clinical_kpi_entry;
        else sharedState.clinical_kpis.push(body.clinical_kpi_entry);
        // Sort ascending by week_of so consumers (sparklines) can read left→right.
        sharedState.clinical_kpis.sort((a, b) => (a.week_of || '').localeCompare(b.week_of || ''));
        if (sharedState.clinical_kpis.length > 52) {
          sharedState.clinical_kpis = sharedState.clinical_kpis.slice(-52);
        }
      }
      // Operations KPI weekly submission (Dylan) — same upsert pattern
      if (body.operations_kpi_entry && body.operations_kpi_entry.week_of) {
        sharedState.operations_kpis = Array.isArray(sharedState.operations_kpis) ? sharedState.operations_kpis : [];
        const wk = body.operations_kpi_entry.week_of;
        const idx = sharedState.operations_kpis.findIndex(e => e && e.week_of === wk);
        if (idx >= 0) sharedState.operations_kpis[idx] = body.operations_kpi_entry;
        else sharedState.operations_kpis.push(body.operations_kpi_entry);
        sharedState.operations_kpis.sort((a, b) => (a.week_of || '').localeCompare(b.week_of || ''));
        if (sharedState.operations_kpis.length > 52) {
          sharedState.operations_kpis = sharedState.operations_kpis.slice(-52);
        }
      }
      // Billing KPI monthly submission (Sheila) — upsert by month_of (YYYY-MM), cap at 36 (3 years)
      if (body.billing_kpi_entry && body.billing_kpi_entry.month_of) {
        sharedState.billing_kpis = Array.isArray(sharedState.billing_kpis) ? sharedState.billing_kpis : [];
        const mo = body.billing_kpi_entry.month_of;
        const idx = sharedState.billing_kpis.findIndex(e => e && e.month_of === mo);
        if (idx >= 0) sharedState.billing_kpis[idx] = body.billing_kpi_entry;
        else sharedState.billing_kpis.push(body.billing_kpi_entry);
        sharedState.billing_kpis.sort((a, b) => (a.month_of || '').localeCompare(b.month_of || ''));
        if (sharedState.billing_kpis.length > 36) {
          sharedState.billing_kpis = sharedState.billing_kpis.slice(-36);
        }
      }
      // Marketing KPI weekly submission (Jamie) — upsert by week_of, cap at 52
      if (body.marketing_kpi_entry && body.marketing_kpi_entry.week_of) {
        sharedState.marketing_kpis = Array.isArray(sharedState.marketing_kpis) ? sharedState.marketing_kpis : [];
        const wk = body.marketing_kpi_entry.week_of;
        const idx = sharedState.marketing_kpis.findIndex(e => e && e.week_of === wk);
        if (idx >= 0) sharedState.marketing_kpis[idx] = body.marketing_kpi_entry;
        else sharedState.marketing_kpis.push(body.marketing_kpi_entry);
        sharedState.marketing_kpis.sort((a, b) => (a.week_of || '').localeCompare(b.week_of || ''));
        if (sharedState.marketing_kpis.length > 52) {
          sharedState.marketing_kpis = sharedState.marketing_kpis.slice(-52);
        }
      }
      // Persist to ClickUp task description (fire-and-forget — don't block response).
      persistState();
      console.log('Shared state updated:', JSON.stringify(sharedState).slice(0, 200) + '...');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, state: sharedState }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST assign
  if (req.method === 'POST' && url === '/assign') {
    try {
      const body = await parseBody(req);
      const { task_id, assignee_id } = body;
      if (!task_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'task_id required' }));
        return;
      }
      const payload = assignee_id ? { assignees: [assignee_id] } : { assignees: [] };
      const result = await clickupRequest('PUT', `/task/${task_id}`, payload);
      cache = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, task: result }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST status
  if (req.method === 'POST' && url === '/status') {
    try {
      const body = await parseBody(req);
      const { task_id, status } = body;
      if (!task_id || !status) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'task_id and status required' }));
        return;
      }
      const result = await clickupRequest('PUT', `/task/${task_id}`, { status });
      cache = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, task: result }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // GET outreach — fetch all tasks from Partner Outreach Pipeline (with custom fields parsed)
  if (req.method === 'GET' && url === '/outreach') {
    try {
      const tasks = await getCachedOutreach(force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tasks, cached_at: new Date(outreachCacheTime).toISOString() }));
    } catch(e) {
      console.error('Outreach fetch error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST outreach — create new partner outreach task in the Partner Outreach Pipeline list
  if (req.method === 'POST' && url === '/outreach') {
    try {
      const body = await parseBody(req);
      const { partner_name, status, contact_name, contact_info, partner_type, last_touch, next_action, notes } = body;

      if (!partner_name || !partner_name.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'partner_name is required' }));
        return;
      }

      // Only include custom fields that have values
      const custom_fields = [];
      if (contact_name) custom_fields.push({ id: PARTNER_FIELDS.contact_name, value: contact_name });
      if (contact_info) custom_fields.push({ id: PARTNER_FIELDS.contact_info, value: contact_info });
      if (partner_type) custom_fields.push({ id: PARTNER_FIELDS.partner_type, value: partner_type });
      if (last_touch)   custom_fields.push({ id: PARTNER_FIELDS.last_touch,   value: parseInt(last_touch) });
      if (next_action)  custom_fields.push({ id: PARTNER_FIELDS.next_action,  value: next_action });

      const payload = {
        name: partner_name.trim(),
        description: notes || '',
        ...(status ? { status } : {}),
        ...(custom_fields.length > 0 ? { custom_fields } : {})
      };

      const result = await clickupRequest('POST', `/list/${PARTNER_LIST_ID}/task`, payload);

      // ClickUp returns errors in the body, not via HTTP status — check explicitly
      if (result.err || result.errors) {
        console.error('ClickUp rejected outreach create:', JSON.stringify(result));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: result.err || JSON.stringify(result.errors) }));
        return;
      }

      // Invalidate outreach cache so the next GET picks up the new task
      outreachCache = null;
      outreachCacheTime = 0;

      console.log(`Outreach created: ${result.id} — ${result.name}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        task: { id: result.id, name: result.name, url: result.url, status: result.status?.status }
      }));
    } catch(e) {
      console.error('Outreach create error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // GET referrals — fetch all tasks from BH Referrals (with custom fields parsed)
  if (req.method === 'GET' && url === '/referrals') {
    try {
      const tasks = await getCachedReferrals(force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tasks, cached_at: new Date(referralCacheTime).toISOString() }));
    } catch(e) {
      console.error('Referrals fetch error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST referrals — create new referral record in the BH Referrals list.
  // `initials` becomes the task name (patient initials only for privacy).
  if (req.method === 'POST' && url === '/referrals') {
    try {
      const body = await parseBody(req);
      const { initials, status, source_name, source_type, source_contact, date_received, asam_level, notes_outcome } = body;

      if (!initials || !initials.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'initials is required' }));
        return;
      }

      const custom_fields = [];
      if (source_name)    custom_fields.push({ id: REFERRAL_FIELDS.source_name,    value: source_name });
      if (source_type)    custom_fields.push({ id: REFERRAL_FIELDS.source_type,    value: source_type });
      if (source_contact) custom_fields.push({ id: REFERRAL_FIELDS.source_contact, value: source_contact });
      if (date_received)  custom_fields.push({ id: REFERRAL_FIELDS.date_received,  value: parseInt(date_received) });
      if (asam_level)     custom_fields.push({ id: REFERRAL_FIELDS.asam_level,     value: asam_level });
      if (notes_outcome)  custom_fields.push({ id: REFERRAL_FIELDS.notes_outcome,  value: notes_outcome });

      const payload = {
        name: initials.trim(),
        description: notes_outcome || '',
        ...(status ? { status } : {}),
        ...(custom_fields.length > 0 ? { custom_fields } : {})
      };

      const result = await clickupRequest('POST', `/list/${REFERRAL_LIST_ID}/task`, payload);

      if (result.err || result.errors) {
        console.error('ClickUp rejected referral create:', JSON.stringify(result));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: result.err || JSON.stringify(result.errors) }));
        return;
      }

      referralCache = null;
      referralCacheTime = 0;

      console.log(`Referral created: ${result.id} — ${result.name}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        task: { id: result.id, name: result.name, url: result.url, status: result.status?.status }
      }));
    } catch(e) {
      console.error('Referral create error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // GET ar — fetch all AR Aging tasks with custom fields parsed
  if (req.method === 'GET' && url === '/ar') {
    try {
      const tasks = await getCachedAR(force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tasks, cached_at: new Date(arCacheTime).toISOString() }));
    } catch(e) {
      console.error('AR fetch error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST ar — create a new AR line item. `initials` becomes the task name.
  if (req.method === 'POST' && url === '/ar') {
    try {
      const body = await parseBody(req);
      const { initials, status, amount, date_of_service, reason_status_note, payer } = body;

      if (!initials || !initials.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'initials is required' }));
        return;
      }

      const custom_fields = [];
      if (amount !== undefined && amount !== null && amount !== '') custom_fields.push({ id: AR_FIELDS.amount, value: parseFloat(amount) });
      if (date_of_service) custom_fields.push({ id: AR_FIELDS.date_of_service, value: parseInt(date_of_service) });
      if (reason_status_note) custom_fields.push({ id: AR_FIELDS.reason_status_note, value: reason_status_note });
      if (payer) custom_fields.push({ id: AR_FIELDS.payer, value: payer });

      const payload = {
        name: initials.trim(),
        description: reason_status_note || '',
        ...(status ? { status } : {}),
        ...(custom_fields.length > 0 ? { custom_fields } : {})
      };

      const result = await clickupRequest('POST', `/list/${AR_LIST_ID}/task`, payload);

      if (result.err || result.errors) {
        console.error('ClickUp rejected AR create:', JSON.stringify(result));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: result.err || JSON.stringify(result.errors) }));
        return;
      }

      arCache = null;
      arCacheTime = 0;

      console.log(`AR item created: ${result.id} — ${result.name}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        task: { id: result.id, name: result.name, url: result.url, status: result.status?.status }
      }));
    } catch(e) {
      console.error('AR create error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // POST billing-report-upload — accept a base64-encoded PDF, attach it to the
  // monthly task in BILLING_REPORTS_LIST_ID. Creates the task if it doesn't
  // exist yet. Body: { month_of: "YYYY-MM", filename: "x.pdf", base64: "..." }
  if (req.method === 'POST' && url === '/billing-report-upload') {
    try {
      const body = await parseBody(req);
      const { month_of, filename, base64 } = body;
      if (!month_of || !/^\d{4}-\d{2}$/.test(month_of)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'month_of (YYYY-MM) is required' }));
        return;
      }
      if (!filename || !base64) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'filename and base64 are required' }));
        return;
      }
      let fileBuffer;
      try { fileBuffer = Buffer.from(base64, 'base64'); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'base64 decode failed' }));
        return;
      }
      if (fileBuffer.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'empty file' }));
        return;
      }
      if (fileBuffer.length > MAX_PDF_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `file too large (${fileBuffer.length} bytes, max ${MAX_PDF_BYTES})` }));
        return;
      }
      const task = await findOrCreateBillingReportTask(month_of);
      if (!task || !task.id) {
        throw new Error('Could not find or create billing report task');
      }
      const att = await clickupAttachmentUpload(task.id, filename, 'application/pdf', fileBuffer);
      if (att && (att.err || att.errors)) {
        console.error('ClickUp rejected attachment:', JSON.stringify(att));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: att.err || JSON.stringify(att.errors) }));
        return;
      }
      console.log(`Billing PDF attached: ${filename} -> task ${task.id} (${month_of})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        task_id: task.id,
        task_url: task.url,
        attachment_url: (att && att.url) || null,
        attachment_id: (att && att.id) || null
      }));
    } catch(e) {
      console.error('Billing PDF upload error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // GET health
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'Bright Horizons Command Center API', token_set: !!API_TOKEN }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Bright Horizons API running on port ${PORT}`);
  if (!API_TOKEN) console.warn('WARNING: CLICKUP_API_TOKEN not set');
  if (!DASHBOARD_TOKEN) console.warn('WARNING: DASHBOARD_TOKEN not set — auth enforcement DISABLED');
  else console.log('Auth enabled — DASHBOARD_TOKEN required on all routes except /health');
  // Hydrate sharedState from the persistent ClickUp task. Does NOT block the
  // listen() — first few GET /state calls during boot may return defaults
  // briefly until hydration completes (~500ms). Acceptable for a small tool.
  hydrateState();
});
