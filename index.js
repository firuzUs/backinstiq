require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const renderer = require('./renderer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'instiq-renderer',
    version: '1.0.0',
    supabase: process.env.SUPABASE_URL ? 'connected' : 'no key'
  });
});

app.post('/render', async (req, res) => {
  try {
    const { scenes, assets, settings, user_id } = req.body;

    if (!scenes || !assets || !settings) {
      return res.status(400).json({ error: 'Need scenes, assets and settings' });
    }

    const job_id = uuidv4();

    await supabase.from('render_jobs').insert({
      id: job_id,
      user_id: user_id || null,
      status: 'queued',
      progress: 0,
      scenes: scenes,
      assets: assets,
      settings: settings,
      created_at: new Date().toISOString()
    });

    renderer.processJob(job_id, { scenes, assets, settings }, supabase)
      .catch(function(err) {
        console.error('Job failed:', err);
      });

    res.json({
      job_id: job_id,
      status: 'queued',
      message: 'Рендер запущен'
    });

  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/status/:job_id', async (req, res) => {
  try {
    var result = await supabase
      .from('render_jobs')
      .select('id, status, progress, result_url, error_message, created_at')
      .eq('id', req.params.job_id)
      .maybeSingle();

    if (result.error) throw result.error;
    if (!result.data) return res.status(404).json({ error: 'Job not found' });

    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/jobs/:user_id', async (req, res) => {
  try {
    var result = await supabase
      .from('render_jobs')
      .select('id, status, progress, result_url, created_at')
      .eq('user_id', req.params.user_id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (result.error) throw result.error;
    res.json(result.data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('Instiq Renderer running on port ' + PORT);
  console.log('Supabase: ' + (process.env.SUPABASE_URL ? 'connected' : 'NO KEY - add to .env'));
});
