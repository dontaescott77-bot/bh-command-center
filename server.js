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

// ANTHROPIC_API_KEY: used by /billing-extract to read Sheila's monthly billing
// PDF and pre-fill the 5 numeric fields. If not set, /billing-extract returns
// a structured error and the frontend silently falls back to manual entry.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const LIST_IDS = [
  '901712935558','901712935562','901712935566',
  '901712935573','901712935575','901712935581','901708395565',
];

const PILLAR_MAP = {
  '901712935558':'sops','901712935562':'onboard','901712935566':'referral',
  '901712935573':'kpi','901712935575':'hr','901712935581':'fin',
};

// Team member name -> ClickUp user ID. Used by /outreach (Phase 4.6) to
// auto-assign meeting follow-up subtasks to the person Neshel is meeting with,
// which triggers a ClickUp notification to them. Names match the values in
// the frontend Meeting With dropdown. Sheila is DWA Consulting in ClickUp.
// Matt is not in this map yet — meetings with Matt will still be created but
// without an assignee until his ClickUp user ID is added.
const TEAM_MEMBER_IDS = {
  'DT':           180152883,  // Dontae Scott
  'Dylan':        101139872,  // Dylan Messal
  'Dr. Jennifer': 95364912,   // Jennifer McChristian
  'Sheila':       180295736,  // DWA Consulting
  'Jamie':        95202610,   // Jamie Fry
  // 'Matt':      pending — add ClickUp ID here when he's added to the workspace
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
async function hydrateState() {
  if (!STATE_TASK_ID) return;
  try {
    const data = await clickupRequest('GET', `/task/${STATE_TASK_ID}/comment`);
    const comments = (data && data.comments) || [];
    if (!comments.length) {
      console.log('State hydrate: no comments yet, starting from defaults');
      return;
    }
    comments.sort((a, b) => parseInt(b.date || 0) - parseInt(a.date || 0));
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
        continue;
      }
    }
    console.log('State hydrate: no valid JSON comment found, starting from defaults');
  } catch(e) {
    console.error('State hydrate failed:', e.message, '— continuing with defaults');
  }
}

let _persistInFlight = false;
let _persistPending = false;
async function persistState() {
  if (!STATE_TASK_ID) return;
  if (_persistInFlight) { _persistPending = true; return; }
  _persistInFlight = true;
  try {
    const json = JSON.stringify(sharedState);
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

// ───── Input validation helpers (Phase 4.1) ─────
function safeText(value, maxLen) {
  if (value == null) return '';
  let s = String(value).replace(/<[^>]*>/g, '').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}
function safeInt(value, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}
function safeFloat(value, min, max) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}
function safeWeekOf(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}
function safeMonthOf(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return null;
  return value;
}
function safeEnum(value, allowed) {
  if (typeof value !== 'string') return null;
  return allowed.includes(value) ? value : null;
}

// ───── Billing report PDF helpers ─────
async function findOrCreateBillingReportTask(monthOf) {
  const data = await clickupRequest('GET', `/list/${BILLING_REPORTS_LIST_ID}/task?include_closed=true&subtasks=false`);
  const existing = (data.tasks || []).find(t => t.name === monthOf);
  if (existing) return existing;
  const created = await clickupRequest('POST', `/list/${BILLING_REPORTS_LIST_ID}/task`, { name: monthOf });
  return created;
}

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

// ───── Anthropic API helper for billing PDF extraction (Phase 4.5) ─────
function anthropicRequest(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(text);
          if (res.statusCode >= 400) {
            return reject(new Error(`Anthropic ${res.statusCode}: ${parsed.error?.message || text.slice(0, 200)}`));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Anthropic response not JSON: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function extractBillingFields(pdfBase64) {
  const prompt = [
    'You are extracting five numeric fields from a monthly billing report PDF.',
    'Return ONLY a JSON object (no prose, no markdown, no code fences) with exactly these keys:',
    '',
    '{',
    '  "total_billed": <number, dollars without $ or commas>,',
    '  "total_collected": <number, dollars without $ or commas>,',
    '  "denial_rate": <number, percentage as 0-100 e.g. 0 for "0%", 5.2 for "5.2%">,',
    '  "claims_count": <integer, total count of claims submitted in the period>,',
    '  "total_ar": <number, total accounts receivable in dollars without $ or commas>',
    '}',
    '',
    'Field mapping inside the PDF:',
    '- "Total Billed" in the Financial Summary  ->  total_billed',
    '- "Total Collected" in the Financial Summary  ->  total_collected',
    '- "Denial Rate" in the Denial Rate section (drop the % sign)  ->  denial_rate',
    '- "Claims Submitted" in the Denial Rate section  ->  claims_count',
    '- The row labeled exactly "Total AR" in the AR Aging section  ->  total_ar',
    '',
    'If a value cannot be found, set it to null. Return only the JSON object.'
  ].join('\n');

  const resp = await anthropicRequest({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfBase64
            }
          },
          { type: 'text', text: prompt }
        ]
      }
    ]
  });

  const textBlock = (resp.content || []).find(b => b.type === 'text');
  const raw = (textBlock && textBlock.text) ? textBlock.text.trim() : '';
  if (!raw) throw new Error('Anthropic returned no text content');
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(stripped); }
  catch (e) { throw new Error('Model output was not valid JSON: ' + stripped.slice(0, 200)); }
  const out = {
    total_billed:    safeFloat(parsed.total_billed,    0, 10000000),
    total_collected: safeFloat(parsed.total_collected, 0, 10000000),
    denial_rate:     safeFloat(parsed.denial_rate,     0, 100),
    claims_count:    safeInt(parsed.claims_count,      0, 100000),
    total_ar:        safeFloat(parsed.total_ar,        0, 10000000)
  };
  return out;
}

// ───── Outreach follow-up subtasks (Phase 4.6) ─────
// createOutreachFollowupSubtask: creates a subtask under a partner outreach
// task representing a planned follow-up action with a due date. The subtask
// surfaces in Neshel's ClickUp queue automatically with the picked due date
// so she never has to remember to chase a partner.
//   parentTaskId: id of the partner outreach task just created/updated
//   actionLabel:  human label, e.g. "Call back in 1 week", "Send proposal"
//   dueDateMs:    unix ms timestamp for the due date
//   meetingWith:  optional name of the team member when action is a meeting
//   partnerName:  partner's name (for the description)
//   assigneeId:   optional ClickUp user id; when provided, the subtask is
//                 assigned to that person (triggers a ClickUp notification).
async function createOutreachFollowupSubtask(parentTaskId, params) {
  const { actionLabel, dueDateMs, meetingWith, partnerName, assigneeId } = params;
  let subtaskName;
  if (meetingWith) {
    subtaskName = 'Meeting with ' + meetingWith;
  } else {
    subtaskName = actionLabel || 'Follow up';
  }
  const descLines = [
    'Auto-created from outreach log.',
    partnerName ? 'Partner: ' + partnerName : '',
    meetingWith ? 'Scheduled with: ' + meetingWith : '',
    'Action: ' + (actionLabel || '(none)'),
  ].filter(Boolean);
  const payload = {
    name: subtaskName,
    description: descLines.join('\n'),
    parent: parentTaskId,
    due_date: dueDateMs,
    due_date_time: false,
    // When the meeting is with someone in TEAM_MEMBER_IDS, assign the subtask
    // to them. ClickUp sends them a notification, the task lands in their
    // queue. If meeting_with isn't recognized (e.g. Matt for now), the task
    // is created unassigned so it still surfaces in Neshel's queue.
    ...(assigneeId ? { assignees: [assigneeId] } : {})
  };
  return clickupRequest('POST', `/list/${PARTNER_LIST_ID}/task`, payload);
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

  if (DASHBOARD_TOKEN && url !== '/health') {
    const provided = req.headers['x-dashboard-token'];
    if (provided !== DASHBOARD_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'unauthorized — missing or invalid X-Dashboard-Token header' }));
      return;
    }
  }

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

  if (req.method === 'GET' && url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, state: sharedState }));
    return;
  }

  if (req.method === 'POST' && url === '/state') {
    try {
      const body = await parseBody(req);
      const censusN = safeInt(body.census, 0, 50);
      if (censusN !== null) sharedState.census = censusN;
      if (body.kpi && typeof body.kpi === 'object') sharedState.kpi = { ...sharedState.kpi, ...body.kpi };
      if (body.fin && typeof body.fin === 'object') sharedState.fin = { ...sharedState.fin, ...body.fin };
      if (body.snapshot && typeof body.snapshot === 'object') {
        const cleanSnapshot = {};
        for (const [k, v] of Object.entries(body.snapshot)) {
          const key = safeText(k, 32);
          if (key) cleanSnapshot[key] = safeText(v, 80);
        }
        sharedState.snapshot = { ...sharedState.snapshot, ...cleanSnapshot };
      }
      if (body.clinical_kpi_entry) {
        const e = body.clinical_kpi_entry;
        const wk = safeWeekOf(e.week_of);
        if (wk) {
          const entry = {
            week_of: wk,
            plans_reviewed:    safeInt(e.plans_reviewed,    0, 1000) ?? 0,
            plans_sent_back:   safeInt(e.plans_sent_back,   0, 1000) ?? 0,
            plans_72hr:        safeInt(e.plans_72hr,        0, 100)  ?? 0,
            critical_incidents:safeInt(e.critical_incidents,0, 1000) ?? 0,
            supervision_hours: safeFloat(e.supervision_hours,0, 1000) ?? 0,
            submitted_by: safeText(e.submitted_by, 100) || 'unknown',
            submitted_at: Date.now()
          };
          sharedState.clinical_kpis = Array.isArray(sharedState.clinical_kpis) ? sharedState.clinical_kpis : [];
          const idx = sharedState.clinical_kpis.findIndex(x => x && x.week_of === wk);
          if (idx >= 0) sharedState.clinical_kpis[idx] = entry;
          else sharedState.clinical_kpis.push(entry);
          sharedState.clinical_kpis.sort((a, b) => (a.week_of || '').localeCompare(b.week_of || ''));
          if (sharedState.clinical_kpis.length > 52) sharedState.clinical_kpis = sharedState.clinical_kpis.slice(-52);
        }
      }
      if (body.operations_kpi_entry) {
        const e = body.operations_kpi_entry;
        const wk = safeWeekOf(e.week_of);
        if (wk) {
          const entry = {
            week_of: wk,
            avg_census: safeFloat(e.avg_census, 0, 50) ?? 0,
            admits:     safeInt(e.admits,       0, 1000) ?? 0,
            discharges: safeInt(e.discharges,   0, 1000) ?? 0,
            submitted_by: safeText(e.submitted_by, 100) || 'unknown',
            submitted_at: Date.now()
          };
          sharedState.operations_kpis = Array.isArray(sharedState.operations_kpis) ? sharedState.operations_kpis : [];
          const idx = sharedState.operations_kpis.findIndex(x => x && x.week_of === wk);
          if (idx >= 0) sharedState.operations_kpis[idx] = entry;
          else sharedState.operations_kpis.push(entry);
          sharedState.operations_kpis.sort((a, b) => (a.week_of || '').localeCompare(b.week_of || ''));
          if (sharedState.operations_kpis.length > 52) sharedState.operations_kpis = sharedState.operations_kpis.slice(-52);
        }
      }
      if (body.billing_kpi_entry) {
        const e = body.billing_kpi_entry;
        const mo = safeMonthOf(e.month_of);
        if (mo) {
          const entry = {
            month_of: mo,
            total_billed:    safeFloat(e.total_billed,    0, 10000000) ?? 0,
            total_collected: safeFloat(e.total_collected, 0, 10000000) ?? 0,
            denial_rate:     safeFloat(e.denial_rate,     0, 100)      ?? 0,
            claims_count:    safeInt(e.claims_count,      0, 100000)   ?? 0,
            total_ar:        safeFloat(e.total_ar,        0, 10000000) ?? 0,
            pdf_url:      safeText(e.pdf_url, 500) || null,
            pdf_task_url: safeText(e.pdf_task_url, 500) || null,
            submitted_by: safeText(e.submitted_by, 100) || 'unknown',
            submitted_at: Date.now()
          };
          sharedState.billing_kpis = Array.isArray(sharedState.billing_kpis) ? sharedState.billing_kpis : [];
          const idx = sharedState.billing_kpis.findIndex(x => x && x.month_of === mo);
          if (idx >= 0) sharedState.billing_kpis[idx] = entry;
          else sharedState.billing_kpis.push(entry);
          sharedState.billing_kpis.sort((a, b) => (a.month_of || '').localeCompare(b.month_of || ''));
          if (sharedState.billing_kpis.length > 36) sharedState.billing_kpis = sharedState.billing_kpis.slice(-36);
        }
      }
      if (body.marketing_kpi_entry) {
        const e = body.marketing_kpi_entry;
        const wk = safeWeekOf(e.week_of);
        if (wk) {
          const entry = {
            week_of: wk,
            social_posts:    safeInt(e.social_posts,    0, 10000)   ?? 0,
            inquiries:       safeInt(e.inquiries,       0, 10000)   ?? 0,
            marketing_hours: safeFloat(e.marketing_hours,0, 168)    ?? 0,
            ad_spend:        safeFloat(e.ad_spend,      0, 1000000) ?? 0,
            submitted_by: safeText(e.submitted_by, 100) || 'unknown',
            submitted_at: Date.now()
          };
          sharedState.marketing_kpis = Array.isArray(sharedState.marketing_kpis) ? sharedState.marketing_kpis : [];
          const idx = sharedState.marketing_kpis.findIndex(x => x && x.week_of === wk);
          if (idx >= 0) sharedState.marketing_kpis[idx] = entry;
          else sharedState.marketing_kpis.push(entry);
          sharedState.marketing_kpis.sort((a, b) => (a.week_of || '').localeCompare(b.week_of || ''));
          if (sharedState.marketing_kpis.length > 52) sharedState.marketing_kpis = sharedState.marketing_kpis.slice(-52);
        }
      }
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

  if (req.method === 'POST' && url === '/assign') {
    try {
      const body = await parseBody(req);
      const task_id     = safeText(body.task_id, 50);
      const assignee_id = safeInt(body.assignee_id, 1, 999999999);
      if (!task_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'task_id required' }));
        return;
      }
      const payload = assignee_id !== null ? { assignees: [assignee_id] } : { assignees: [] };
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

  if (req.method === 'POST' && url === '/status') {
    try {
      const body = await parseBody(req);
      const task_id = safeText(body.task_id, 50);
      const status  = safeText(body.status, 50);
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

  // POST outreach — create new partner outreach task. Phase 4.6: if the
  // request includes next_action_date (and optionally meeting_with), we also
  // create a subtask under the new partner task with that due date. When
  // meeting_with maps to a known team member in TEAM_MEMBER_IDS, the subtask
  // is assigned to them (triggers a ClickUp notification).
  if (req.method === 'POST' && url === '/outreach') {
    try {
      const body = await parseBody(req);

      const partner_name = safeText(body.partner_name, 200);
      if (!partner_name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'partner_name is required' }));
        return;
      }
      const contact_name = safeText(body.contact_name, 200);
      const contact_info = safeText(body.contact_info, 200);
      const next_action  = safeText(body.next_action,  500);
      const notes        = safeText(body.notes,        2000);
      const partner_type = safeText(body.partner_type, 100);
      const last_touch   = safeInt(body.last_touch, 0, 9999999999999);
      const status       = safeEnum(body.status, ['Cold','Scheduled','Active','Dormant','Closed']);
      // Phase 4.6 fields — both optional. If next_action_date is set we'll
      // create a follow-up subtask after the partner task is created.
      const next_action_date = safeInt(body.next_action_date, 0, 9999999999999);
      const meeting_with     = safeText(body.meeting_with, 100);

      const custom_fields = [];
      if (contact_name) custom_fields.push({ id: PARTNER_FIELDS.contact_name, value: contact_name });
      if (contact_info) custom_fields.push({ id: PARTNER_FIELDS.contact_info, value: contact_info });
      if (partner_type) custom_fields.push({ id: PARTNER_FIELDS.partner_type, value: partner_type });
      if (last_touch !== null) custom_fields.push({ id: PARTNER_FIELDS.last_touch, value: last_touch });
      if (next_action)  custom_fields.push({ id: PARTNER_FIELDS.next_action,  value: next_action });

      const payload = {
        name: partner_name,
        description: notes,
        ...(status ? { status } : {}),
        ...(custom_fields.length > 0 ? { custom_fields } : {})
      };

      const result = await clickupRequest('POST', `/list/${PARTNER_LIST_ID}/task`, payload);

      if (result.err || result.errors) {
        console.error('ClickUp rejected outreach create:', JSON.stringify(result));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: result.err || JSON.stringify(result.errors) }));
        return;
      }

      // Phase 4.6 — auto-create follow-up subtask if a date was picked.
      // Failures here are logged but DON'T fail the parent create — the
      // partner record is more important than the convenience subtask.
      let followupResult = null;
      if (next_action_date && result.id) {
        try {
          const assigneeId = (meeting_with && TEAM_MEMBER_IDS[meeting_with]) || null;
          console.log(`Creating follow-up subtask: meeting_with=${meeting_with || '(none)'} assigneeId=${assigneeId || '(none)'} dueDate=${next_action_date}`);
          followupResult = await createOutreachFollowupSubtask(result.id, {
            actionLabel: next_action,
            dueDateMs: next_action_date,
            meetingWith: meeting_with || null,
            partnerName: partner_name,
            assigneeId: assigneeId
          });
          if (followupResult && (followupResult.err || followupResult.errors)) {
            console.error('Follow-up subtask rejected:', JSON.stringify(followupResult).slice(0, 200));
            followupResult = { error: followupResult.err || JSON.stringify(followupResult.errors) };
          } else if (followupResult && followupResult.id) {
            console.log(`Follow-up subtask created: ${followupResult.id} under ${result.id}`);
          }
        } catch(subErr) {
          console.error('Follow-up subtask error:', subErr.message);
          followupResult = { error: subErr.message };
        }
      }

      outreachCache = null;
      outreachCacheTime = 0;

      console.log(`Outreach created: ${result.id} — ${result.name}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        task: { id: result.id, name: result.name, url: result.url, status: result.status?.status },
        followup: followupResult ? {
          id: followupResult.id || null,
          url: followupResult.url || null,
          error: followupResult.error || null
        } : null
      }));
    } catch(e) {
      console.error('Outreach create error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

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

  if (req.method === 'POST' && url === '/referrals') {
    try {
      const body = await parseBody(req);

      const initials = safeText(body.initials, 50);
      if (!initials) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'initials is required' }));
        return;
      }
      const source_name    = safeText(body.source_name,    200);
      const source_type    = safeText(body.source_type,    100);
      const source_contact = safeText(body.source_contact, 200);
      const asam_level     = safeText(body.asam_level,     20);
      const notes_outcome  = safeText(body.notes_outcome,  2000);
      const date_received  = safeInt(body.date_received, 0, 9999999999999);
      const status         = safeEnum(body.status, ['New','Assessment','Admitted','Declined']);

      const custom_fields = [];
      if (source_name)    custom_fields.push({ id: REFERRAL_FIELDS.source_name,    value: source_name });
      if (source_type)    custom_fields.push({ id: REFERRAL_FIELDS.source_type,    value: source_type });
      if (source_contact) custom_fields.push({ id: REFERRAL_FIELDS.source_contact, value: source_contact });
      if (date_received !== null) custom_fields.push({ id: REFERRAL_FIELDS.date_received, value: date_received });
      if (asam_level)     custom_fields.push({ id: REFERRAL_FIELDS.asam_level,     value: asam_level });
      if (notes_outcome)  custom_fields.push({ id: REFERRAL_FIELDS.notes_outcome,  value: notes_outcome });

      const payload = {
        name: initials,
        description: notes_outcome,
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

  if (req.method === 'POST' && url === '/ar') {
    try {
      const body = await parseBody(req);

      const initials = safeText(body.initials, 50);
      if (!initials) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'initials is required' }));
        return;
      }
      const amount             = safeFloat(body.amount, 0, 10000000);
      const date_of_service    = safeInt(body.date_of_service, 0, 9999999999999);
      const reason_status_note = safeText(body.reason_status_note, 1000);
      const payer              = safeText(body.payer, 200);
      const status             = safeEnum(body.status, ['Open','Working','Resolved']);

      const custom_fields = [];
      if (amount !== null) custom_fields.push({ id: AR_FIELDS.amount, value: amount });
      if (date_of_service !== null) custom_fields.push({ id: AR_FIELDS.date_of_service, value: date_of_service });
      if (reason_status_note) custom_fields.push({ id: AR_FIELDS.reason_status_note, value: reason_status_note });
      if (payer) custom_fields.push({ id: AR_FIELDS.payer, value: payer });

      const payload = {
        name: initials,
        description: reason_status_note,
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

  if (req.method === 'POST' && url === '/billing-report-upload') {
    try {
      const body = await parseBody(req);
      const month_of = safeMonthOf(body.month_of);
      if (!month_of) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'month_of (YYYY-MM) is required' }));
        return;
      }
      let filename = safeText(body.filename, 200) || 'billing.pdf';
      if (!/\.pdf$/i.test(filename)) filename += '.pdf';
      const base64 = body.base64;
      if (!base64 || typeof base64 !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'base64 is required (string)' }));
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

  if (req.method === 'POST' && url === '/billing-extract') {
    try {
      if (!ANTHROPIC_API_KEY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'ANTHROPIC_API_KEY not configured on server' }));
        return;
      }
      const body = await parseBody(req);
      const base64 = body.base64;
      if (!base64 || typeof base64 !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'base64 is required (string)' }));
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

      const extracted = await extractBillingFields(base64);
      console.log('Billing extract result:', JSON.stringify(extracted));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, extracted }));
    } catch(e) {
      console.error('Billing extract error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Bright Horizons Command Center API',
      token_set: !!API_TOKEN,
      anthropic_set: !!ANTHROPIC_API_KEY,
      version: 'v13'
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Bright Horizons API v13 running on port ${PORT}`);
  if (!API_TOKEN) console.warn('WARNING: CLICKUP_API_TOKEN not set');
  if (!DASHBOARD_TOKEN) console.warn('WARNING: DASHBOARD_TOKEN not set — auth enforcement DISABLED');
  else console.log('Auth enabled — DASHBOARD_TOKEN required on all routes except /health');
  if (!ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY not set — /billing-extract will return 503');
  else console.log('Anthropic API key detected — /billing-extract enabled');
  hydrateState();
});
