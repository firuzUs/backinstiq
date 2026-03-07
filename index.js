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
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder'
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
    const { scenes, assets, settings, user_id, transcripts } = req.body;
    const totalDuration = scenes?.reduce((a,s) => a + ((s.trim_end||0)-(s.trim_start||0)), 0);
    console.log('
╔════════════════════════════════════════╗');
    console.log('║         📥 НОВЫЙ ЗАПРОС РЕНДЕРА         ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('👤 user_id:        ', user_id || 'anonymous');
    console.log('🎬 Сцен:           ', scenes?.length);
    console.log('📁 Ассетов:        ', assets?.length);
    console.log('⏱️  Длина видео:    ', totalDuration?.toFixed(1), 'сек →', (totalDuration/60).toFixed(1), 'мин');
    console.log('────────────────────────────────────────');
    console.log('🎨 Цветокоррекция: ', settings?.color_grade || '❌ не задана');
    console.log('💬 Субтитры:       ', settings?.subtitle_style || '❌ не заданы');
    console.log('🎵 Музыка:         ', settings?.music_url ? '✅ есть' : '❌ нет');
    console.log('📐 Формат:         ', settings?.aspect_ratio || '9:16');
    console.log('⚡ Энергия:        ', settings?.energy_preset || 'не задана');
    console.log('🏷️  Бренд:          ', settings?.brand_name || 'нет');
    console.log('────────────────────────────────────────');
    console.log('📝 Транскриптов:   ', transcripts?.length || 0, 'файлов');
    console.log('📝 Всего слов:     ', transcripts?.reduce((a,t)=>a+(t.words?.length||0),0) || 0);
    console.log('────────────────────────────────────────');
    scenes?.forEach((s,i) => console.log(`   Сцена ${i+1}: файл=${s.source_file_index} [${s.trim_start?.toFixed(1)}s→${s.trim_end?.toFixed(1)}s] speed=${s.speed||1} transition=${s.transition||'cut'}`));
    console.log('════════════════════════════════════════
');
    console.log('================================');
    console.log('📦 scenes:', scenes?.length);
    console.log('📦 assets:', assets?.length);
    console.log('📦 transcripts:', transcripts?.length, 'words:', transcripts?.reduce((a,t)=>a+(t.words?.length||0),0));
    console.log('📦 subtitle_style:', settings?.subtitle_style);
    console.log('📦 color_grade:', settings?.color_grade);
    console.log('📦 asset[0] url:', assets?.[0]?.storage_url?.slice(0,60));
    console.log('📦 transcript[0] words:', transcripts?.[0]?.words?.slice(0,2));
    console.log('================================');
    console.log("📦 ПОЛНЫЙ PAYLOAD:", JSON.stringify({ scenes_count: scenes.length, assets_count: assets.length, transcripts_count: transcripts?.length, subtitle_style: settings?.subtitle_style, color_grade: settings?.color_grade, first_transcript_words: transcripts?.[0]?.words?.length }, null, 2));
    console.log("📝 Получено транскриптов:", transcripts?.length, "слов:", transcripts?.reduce((a,t) => a+(t.words?.length||0),0));

    if (!scenes || !assets || !settings) {
      return res.status(400).json({ error: 'Need scenes, assets and settings' });
    }

    const job_id = uuidv4();

    await supabase.from('render_jobs').insert({
      id: job_id,
      user_id: user_id || null,
      status: 'queued',
      progress: 0,
      input_data: { scenes, assets, settings },
      created_at: new Date().toISOString()
    });

    renderer.processJob(job_id, { scenes, assets, settings, transcripts }, supabase)
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
