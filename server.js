const https = require('https');
const http = require('http');

const API_TOKEN = process.env.CLICKUP_API_TOKEN;
const PORT = process.env.PORT || 3000;

const LIST_IDS = [
  '901712935558', // Clinical SOPs
  '901712935562', // Staff Onboarding
  '901712935566', // Referral Pipeline
  '901712935573', // KPI Tracking
  '901712935575', // HR & Performance
  '901712935581', // Financial Model
  '901708395565', // Operations (main ops list)
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
  if (['google','facebook','outreach','field outreach','matt dedicated','referral','pipeline','waitlist','hospital','therapist'].some(k => n.includes(k))) return 'referral';
  if (['kpi','revenue','financial dashboard','billing','collections','ar aging','payroll','payer'].some(k => n.includes(k))) return 'kpi';
  if (['financial dashboard','credentialing'].some(k => n.includes(k))) return 'fin';
  return 'hr';
}

function fetchClickUp(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.clickup.com',
      path: `/api/v2${path}`,
      method: 'GET',
      headers: { 'Authorization': API_TOKEN, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getAllTasks() {
  const pillars = { sops: [], onboard: [], referral: [], kpi: [], hr: [], fin: [] };

  for (const listId of LIST_IDS) {
    try {
      const data = await fetchClickUp(`/list/${listId}/task?include_closed=true&subtasks=true`);
      const tasks = (data.tasks || []).map(t => ({
        id: t.id,
        name: t.name,
        status: t.status?.status || 'to do',
        assignees: (t.assignees || []).map(a => a.username || a.email || 'Unknown'),
        priority: t.priority?.priority || null,
        url: t.url,
        due_date: t.due_date,
        list: t.list?.name
      }));

      if (PILLAR_MAP[listId]) {
        pillars[PILLAR_MAP[listId]].push(...tasks);
      } else {
        // Ops list — classify each task
        tasks.forEach(t => {
          const pillar = classifyOpsTask(t.name);
          pillars[pillar].push(t);
        });
      }
    } catch(e) {
      console.error(`Error fetching list ${listId}:`, e.message);
    }
  }

  return pillars;
}

// Simple in-memory cache — refresh every 5 minutes
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getCachedTasks() {
  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_TTL) return cache;
  console.log('Fetching fresh data from ClickUp...');
  cache = await getAllTasks();
  cacheTime = now;
  return cache;
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/tasks' || req.url === '/tasks?refresh=true') {
    try {
      if (req.url.includes('refresh=true')) {
        cache = null; // force refresh
      }
      const tasks = await getCachedTasks();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: tasks, cached_at: new Date(cacheTime).toISOString() }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'Bright Horizons Command Center API' }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Bright Horizons API running on port ${PORT}`);
  if (!API_TOKEN) console.warn('WARNING: CLICKUP_API_TOKEN not set');
});
