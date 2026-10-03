import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  PORT = 3000
} = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing Supabase env vars. Check your .env file.');
  process.exit(1);
}

const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

// ============================================================
// STATIC FILE SERVING (works with OR without a public/ folder)
// ============================================================
const PUBLIC_DIR = path.join(__dirname, 'public');
const HAS_PUBLIC = fs.existsSync(PUBLIC_DIR);

if (HAS_PUBLIC) {
  app.use(express.static(PUBLIC_DIR));
  console.log(`📁 Serving static files from: ${PUBLIC_DIR}`);
} else {
  console.log(`📁 No public/ folder — serving from project root: ${__dirname}`);
}
app.use(express.static(__dirname));

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }
    const token = header.slice(7).trim();
    const { data, error } = await supabaseAnon.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = data.user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      const { data: profile } = await db
        .from('profiles').select('role').eq('id', req.user.id).single();
      if (!profile || !roles.includes(profile.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      req.profile = profile;
      next();
    } catch (err) {
      console.error('requireRole error:', err);
      res.status(500).json({ error: 'Role check failed' });
    }
  };
}

// ============================================================
// HEALTH
// ============================================================
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// AUTH
// ============================================================
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, fullName } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const { data, error } = await supabaseAnon.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName || email } }
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ user: data.user, session: data.session });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });

  const { data: profile } = await db
    .from('profiles').select('*').eq('id', data.user.id).single();

  res.json({
    user: data.user,
    session: data.session,
    profile: profile || { id: data.user.id, full_name: data.user.email, role: 'operator' }
  });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { data: profile } = await db
    .from('profiles').select('*').eq('id', req.user.id).single();
  res.json({ user: req.user, profile });
});

// ============================================================
// SAMPLES
// ============================================================
app.get('/api/samples', requireAuth, async (_req, res) => {
  const { data, error } = await db
    .from('samples').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/samples', requireAuth, async (req, res) => {
  const { sample_code, material_grade, client_name, project_ref, received_date } = req.body;
  if (!sample_code) return res.status(400).json({ error: 'sample_code is required' });

  const { data, error } = await db
    .from('samples')
    .insert({
      sample_code,
      material_grade: material_grade || null,
      client_name: client_name || null,
      project_ref: project_ref || null,
      received_date: received_date || new Date().toISOString().slice(0, 10),
      created_by: req.user.id
    })
    .select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.get('/api/samples/:id', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('samples').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// ============================================================
// HARDNESS TESTS
// ============================================================
app.post('/api/tests/hardness', requireAuth, async (req, res) => {
  const { readings = [], ...test } = req.body;
  if (!test.sample_id) return res.status(400).json({ error: 'sample_id is required' });

  const { data: row, error } = await db
    .from('hardness_tests')
    .insert({
      sample_id: test.sample_id,
      method: test.method,
      standard_ref: test.standard_ref,
      scale: test.scale,
      operator_id: req.user.id,
      test_date: test.test_date || new Date().toISOString().slice(0, 10),
      spec_min: test.spec_min,
      spec_max: test.spec_max,
      average_result: test.average_result,
      overall_status: test.overall_status || 'PENDING',
      checklist_progress: test.checklist_progress || 0,
      notes: test.notes
    })
    .select().single();

  if (error) return res.status(400).json({ error: error.message });

  if (Array.isArray(readings) && readings.length) {
    const rows = readings
      .filter(r => r.reading_value !== null && r.reading_value !== undefined && r.reading_value !== '')
      .map(r => ({
        test_id: row.id,
        location_label: r.location_label || null,
        reading_value: Number(r.reading_value),
        status: r.status || 'PENDING'
      }));
    if (rows.length) {
      const { error: rErr } = await db.from('hardness_readings').insert(rows);
      if (rErr) console.error('Readings insert error:', rErr);
    }
  }

  res.json(row);
});

app.get('/api/tests/hardness', requireAuth, async (_req, res) => {
  const { data, error } = await db
    .from('hardness_tests')
    .select(`*, hardness_readings (*), samples (sample_code, material_grade)`)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ============================================================
// MICROSTRUCTURE TESTS
// ============================================================
app.post('/api/tests/microstructure', requireAuth, async (req, res) => {
  const t = req.body;
  if (!t.sample_id) return res.status(400).json({ error: 'sample_id is required' });

  const { data, error } = await db
    .from('microstructure_tests')
    .insert({
      sample_id: t.sample_id,
      etchant: t.etchant,
      microscope: t.microscope,
      magnification: t.magnification,
      operator_id: req.user.id,
      test_date: t.test_date || new Date().toISOString().slice(0, 10),
      grain_size: t.grain_size,
      phase_constituents: t.phase_constituents,
      defects: t.defects,
      inclusion_rating: t.inclusion_rating,
      observation_notes: t.observation_notes,
      checklist_progress: t.checklist_progress || 0
    })
    .select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.get('/api/tests/microstructure', requireAuth, async (_req, res) => {
  const { data, error } = await db
    .from('microstructure_tests')
    .select(`*, samples (sample_code, material_grade)`)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ============================================================
// COMPOSITION TESTS
// ============================================================
app.post('/api/tests/composition', requireAuth, async (req, res) => {
  const { elements = [], ...test } = req.body;
  if (!test.sample_id) return res.status(400).json({ error: 'sample_id is required' });

  const { data: row, error } = await db
    .from('composition_tests')
    .insert({
      sample_id: test.sample_id,
      method: test.method,
      equipment: test.equipment,
      calibration_standard: test.calibration_standard,
      operator_id: req.user.id,
      test_date: test.test_date || new Date().toISOString().slice(0, 10),
      overall_status: test.overall_status || 'PENDING',
      checklist_progress: test.checklist_progress || 0
    })
    .select().single();

  if (error) return res.status(400).json({ error: error.message });

  if (Array.isArray(elements) && elements.length) {
    const rows = elements
      .filter(e => e.element_symbol)
      .map(e => ({
        test_id: row.id,
        element_symbol: e.element_symbol,
        spec_min: e.spec_min ?? null,
        spec_max: e.spec_max ?? null,
        result_value: e.result_value ?? null,
        status: e.status || 'PENDING'
      }));
    if (rows.length) {
      const { error: eErr } = await db.from('composition_elements').insert(rows);
      if (eErr) console.error('Elements insert error:', eErr);
    }
  }

  res.json(row);
});

app.get('/api/tests/composition', requireAuth, async (_req, res) => {
  const { data, error } = await db
    .from('composition_tests')
    .select(`*, composition_elements (*), samples (sample_code, material_grade)`)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ============================================================
// UTM TESTS
// ============================================================
app.post('/api/tests/utm', requireAuth, async (req, res) => {
  const t = req.body;
  if (!t.sample_id) return res.status(400).json({ error: 'sample_id is required' });

  const { data, error } = await db
    .from('utm_tests')
    .insert({
      sample_id: t.sample_id,
      test_type: t.test_type,
      standard_ref: t.standard_ref,
      crosshead_speed: t.crosshead_speed,
      gauge_length: t.gauge_length,
      initial_diameter: t.initial_diameter,
      thickness: t.thickness,
      operator_id: req.user.id,
      test_date: t.test_date || new Date().toISOString().slice(0, 10),
      yield_strength: t.yield_strength,
      tensile_strength: t.tensile_strength,
      elongation: t.elongation,
      reduction_of_area: t.reduction_of_area,
      modulus: t.modulus,
      fracture_location: t.fracture_location,
      spec_ys_min: t.spec_ys_min,
      spec_uts_min: t.spec_uts_min,
      spec_elong_min: t.spec_elong_min,
      overall_status: t.overall_status || 'PENDING',
      checklist_progress: t.checklist_progress || 0
    })
    .select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.get('/api/tests/utm', requireAuth, async (_req, res) => {
  const { data, error } = await db
    .from('utm_tests')
    .select(`*, samples (sample_code, material_grade)`)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ============================================================
// AUDIT LOG
// ============================================================
app.get('/api/audit',
  requireAuth,
  requireRole('reviewer', 'approver', 'admin'),
  async (_req, res) => {
    const { data, error } = await db
      .from('audit_log').select('*')
      .order('changed_at', { ascending: false }).limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  }
);

// ============================================================
// CONSOLIDATED REPORT
// ============================================================
app.get('/api/reports/:sampleId', requireAuth, async (req, res) => {
  const { sampleId } = req.params;

  const [sample, hardness, micro, comp, utm] = await Promise.all([
    db.from('samples').select('*').eq('id', sampleId).single(),
    db.from('hardness_tests').select('*, hardness_readings(*)').eq('sample_id', sampleId),
    db.from('microstructure_tests').select('*').eq('sample_id', sampleId),
    db.from('composition_tests').select('*, composition_elements(*)').eq('sample_id', sampleId),
    db.from('utm_tests').select('*').eq('sample_id', sampleId)
  ]);

  if (sample.error) return res.status(404).json({ error: 'Sample not found' });

  res.json({
    sample: sample.data,
    hardness: hardness.data || [],
    microstructure: micro.data || [],
    composition: comp.data || [],
    utm: utm.data || [],
    generated_at: new Date().toISOString()
  });
});

// ============================================================
// FALLBACK: SPA — serve index.html from wherever it lives
// ============================================================
app.use((_req, res) => {
  const candidates = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'index.html')
  ];
  const target = candidates.find(p => fs.existsSync(p));
  if (target) return res.sendFile(target);
  res.status(404).send('index.html not found. Place it at the project root next to server.js.');
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🚀 Materials Lab server running`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   Supabase URL: ${SUPABASE_URL}\n`);
});
