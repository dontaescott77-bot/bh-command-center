const https = require('https');
const http = require('http');

const API_TOKEN = process.env.CLICKUP_API_TOKEN;
const PORT = process.env.PORT || 3000;

const LIST_IDS = [
  '901712935558',
  '901712935562',
  '901712935566',
  '901712935573',
  '901712935575',
  '901712935581',
  '901708395565',
];

const PILLAR_MAP = {
  '901712935558': 'sops',
  '901712935562': 'onboard',
  '901712935566': 'referral',
  '901712935573': 'kpi',
  '901712935575': 'hr',
  '901712935581': 'fin',
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

async function getAllTasks() {
  const pillars = { sops: [], onboard: [], referral: [], kpi: [], hr: [], fin: [] };
  for (const listId of LIST_IDS) {
    try {
      const data = await clickupRequest('GET', `/list/${listId}/task?include_closed=true&subtasks=true`);
      const tasks = (data.tasks || []).map(t => ({
        id: t.id,
        name: t.name,
        status: t.status?.status || 'to do',
        assignees: (t.assignees || []).map(a => ({ id: a.id, username: a.username, email: a.email })),
        priority: t.priority?.priority || null,
        url: t.url,
        due_date: t.due_date,
        list: t.list?.name
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

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { resolve({}); }
    });
  });
}

// Apply CORS headers to every single response
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Origin');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const server = http.createServer(async (req, res) => {
  // Always set CORS first — before anything else
  setCORS(res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];
  const query = req.url.includes('?') ? req.url.split('?')[1] : '';
  const force = query.includes('refresh=true');

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
});
