const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { runFFmpeg, getDuration } = require('../utils/ffmpeg');
const { generateASS } = require('../utils/subtitles');
const { uploadToStorage, updateRenderJob } = require('../utils/supabaseAdmin');

const jobs = new Map();

setInterval(() => { const now = Date.now(); for (const [id, j] of jobs) { if (now - j.created_at > 3600000) jobs.delete(id); } }, 300000);

router.post('/', async (req, res) => {
  try {
    const { job_id, user_id, source_url, settings, supabase_url, service_key } = req.body;
    if (!job_id || !source_url || !supabase_url || !service_key) return res.status(400).json({ error: 'Missing required fields' });
    console.log(`[convert][${job_id}] New job received`);
    jobs.set(job_id, { status: 'processing', progress: 0, stage: 'Принято...', url: null, error_message: null, created_at: Date.now() });
    res.json({ status: 'accepted', job_id });
    processJob({ job_id, user_id, source_url, settings: settings || {}, supabase_url, service_key });
  } catch (err) {
    console.error('[convert] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.json({ status: 'unknown' });
  res.json({ status: job.status, progress: job.progress, stage: job.stage, url: job.url, error_message: job.error_message });
});

async function processJob({ job_id, user_id, source_url, settings, supabase_url, service_key }) {
  const tmpDir = path.join('/tmp', 'jobs', job_id);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const inputPath = path.join(tmpDir, 'input.webm');
    let currentInput = inputPath;

    // 1. Скачивание
    upd(job_id, 5, 'Скачиваю видео...');
    const videoRes = await fetch(source_url);
    if (!videoRes.ok) throw new Error('Download failed: ' + videoRes.status);
    const buf = Buffer.from(await videoRes.arrayBuffer());
    if (buf.length > 500 * 1024 * 1024) throw new Error('File too large (max 500MB)');
    fs.writeFileSync(inputPath, buf);
    console.log(`[convert][${job_id}] Downloaded: ${(buf.length/1024/1024).toFixed(1)} MB`);
    upd(job_id, 15, 'Видео скачано');

    // 2. Обрезка
    if (settings.trim_start != null || settings.trim_end != null) {
      upd(job_id, 20, 'Обрезаю видео...');
      const trimmed = path.join(tmpDir, 'trimmed.webm');
      const args = ['-i', currentInput];
      if (settings.trim_start != null) args.push('-ss', String(settings.trim_start));
      if (settings.trim_end != null) args.push('-to', String(settings.trim_end));
      args.push('-c', 'copy', '-y', trimmed);
      await runFFmpeg(args, job_id);
      currentInput = trimmed;
    }

    const duration = await getDuration(currentInput, job_id);
    upd(job_id, 25, 'Подготавливаю...');

    // 3. Субтитры
    let assPath = null;
    if (settings.subtitle_style === 'bottom_burn') {
      if (settings.transcribe && !settings.subtitles_text) {
        upd(job_id, 30, 'Распознаю речь...');
        const audioPath = path.join(tmpDir, 'audio.wav');
        await runFFmpeg(['-i', currentInput, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', audioPath], job_id);
        let words = [];
        try {
          const formData = new FormData();
          const blob = new Blob([fs.readFileSync(audioPath)], { type: 'audio/wav' });
          formData.append('audio', blob, 'audio.wav');
          const tRes = await fetch('http://localhost:' + (process.env.PORT || 8080) + '/transcribe', { method: 'POST', body: formData });
          if (tRes.ok) { const d = await tRes.json(); words = d.words || []; console.log(`[convert][${job_id}] Transcribed: ${words.length} words`); }
          else console.warn(`[convert][${job_id}] Transcribe failed, skipping subs`);
        } catch (e) { console.warn(`[convert][${job_id}] Transcribe error: ${e.message}`); }
        if (words.length > 0) {
          assPath = path.join(tmpDir, 'subs.ass');
          generateASS({ words, duration, accentColor: settings.accent_color, outputPath: assPath });
        }
        upd(job_id, 50, 'Речь распознана');
      } else if (settings.subtitles_text) {
        upd(job_id, 35, 'Подготавливаю субтитры...');
        assPath = path.join(tmpDir, 'subs.ass');
        generateASS({ plainText: settings.subtitles_text, duration, accentColor: settings.accent_color, outputPath: assPath });
        upd(job_id, 50, 'Субтитры готовы');
      }
    }

    // 4. Музыка
    let musicPath = null;
    if (settings.music_url) {
      upd(job_id, 55, 'Скачиваю музыку...');
      const mRes = await fetch(settings.music_url);
      if (mRes.ok) { musicPath = path.join(tmpDir, 'music.mp3'); fs.writeFileSync(musicPath, Buffer.from(await mRes.arrayBuffer())); }
    }

    // 5. Финальная конвертация
    upd(job_id, 60, 'Конвертирую видео...');
    const outputPath = path.join(tmpDir, 'output.mp4');
    const ffArgs = ['-i', currentInput];
    if (musicPath) ffArgs.push('-i', musicPath);
    if (assPath) ffArgs.push('-vf', `ass=${assPath.replace(/\\/g, '/').replace(/:/g, '\\:')}`);
    if (musicPath) {
      const vol = settings.music_volume || 0.3;
      ffArgs.push('-filter_complex', `[0:a]volume=1[a];[1:a]volume=${vol},aloop=loop=-1:size=2e+09[b];[a][b]amix=inputs=2:duration=first[outa]`, '-map', '0:v', '-map', '[outa]');
    }
    ffArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', outputPath);
    await runFFmpeg(ffArgs, job_id);
    console.log(`[convert][${job_id}] Conversion complete`);

    // 6. Загрузка в Storage
    upd(job_id, 85, 'Загружаю результат...');
    const storagePath = `${user_id}/converted-${job_id}.mp4`;
    const publicUrl = await uploadToStorage(supabase_url, service_key, 'video-exports', outputPath, storagePath);
    console.log(`[convert][${job_id}] Uploaded: ${publicUrl}`);

    // 7. Обновить render_jobs
    upd(job_id, 95, 'Обновляю статус...');
    await updateRenderJob(supabase_url, service_key, job_id, { status: 'done', result_url: publicUrl, output_url: publicUrl, progress: 100, completed_at: new Date().toISOString() });
    jobs.set(job_id, { ...jobs.get(job_id), status: 'done', progress: 100, stage: 'Готово!', url: publicUrl });
    console.log(`[convert][${job_id}] ✅ Done`);

  } catch (err) {
    console.error(`[convert][${job_id}] ❌ ${err.message}`);
    jobs.set(job_id, { ...jobs.get(job_id), status: 'failed', progress: 0, stage: 'Ошибка', error_message: err.message });
    try { await updateRenderJob(supabase_url, service_key, job_id, { status: 'failed', error_message: err.message, progress: 0 }); } catch (e) {}
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

function upd(id, progress, stage) { const j = jobs.get(id); if (j) { j.progress = progress; j.stage = stage; } }

module.exports = router;
