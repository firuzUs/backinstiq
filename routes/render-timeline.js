const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { runFFmpeg, getDuration } = require('../utils/ffmpeg');
const { uploadToStorage, updateRenderJob } = require('../utils/supabaseAdmin');

const jobs = new Map();

setInterval(() => { const now = Date.now(); for (const [id, j] of jobs) { if (now - j.created_at > 3600000) jobs.delete(id); } }, 300000);

router.post('/', async (req, res) => {
  try {
    const { job_id, user_id, timeline, supabase_url, service_key } = req.body;
    if (!job_id || !timeline || !supabase_url || !service_key) {
      return res.status(400).json({ error: 'Missing: job_id, timeline, supabase_url, service_key' });
    }
    console.log(`[render-timeline][${job_id}] New job: ${timeline.tracks?.length} tracks, ${timeline.duration}s`);
    jobs.set(job_id, { status: 'processing', progress: 0, stage: 'Принято...', url: null, error: null, created_at: Date.now() });
    res.json({ jobId: job_id, status: 'queued' });
    processTimeline({ job_id, user_id, timeline, supabase_url, service_key });
  } catch (err) {
    console.error('[render-timeline] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.json({ status: 'unknown' });
  res.json({ status: job.status, progress: job.progress, stage: job.stage, resultUrl: job.url, error: job.error });
});

async function processTimeline({ job_id, user_id, timeline, supabase_url, service_key }) {
  const tmpDir = path.join('/tmp', 'timeline-jobs', job_id);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const resolution = timeline.resolution === '720p' ? '720x1280' : '1080x1920';
    const videoTrack = timeline.tracks?.find(t => t.type === 'video');
    const audioTrack = timeline.tracks?.find(t => t.type === 'audio');
    const musicTrack = timeline.tracks?.find(t => t.type === 'music');
    const textTrack = timeline.tracks?.find(t => t.type === 'text');

    if (!videoTrack?.items?.length) throw new Error('No video clips');

    // === 1. Download all source files ===
    upd(job_id, 5, 'Скачиваю файлы...');
    const downloads = {};

    for (let i = 0; i < videoTrack.items.length; i++) {
      const item = videoTrack.items[i];
      const ext = item.sourceType === 'image' ? '.jpg' : '.mp4';
      const filePath = path.join(tmpDir, `video_${i}${ext}`);
      await downloadFile(item.sourceUrl, filePath);
      downloads[item.id || `v${i}`] = filePath;
      console.log(`[render-timeline][${job_id}] Downloaded video ${i}: ${filePath}`);
    }

    if (audioTrack?.items?.length) {
      for (let i = 0; i < audioTrack.items.length; i++) {
        const filePath = path.join(tmpDir, `audio_${i}.mp3`);
        await downloadFile(audioTrack.items[i].sourceUrl, filePath);
        downloads[`a${i}`] = filePath;
      }
    }

    if (musicTrack?.items?.length) {
      for (let i = 0; i < musicTrack.items.length; i++) {
        const filePath = path.join(tmpDir, `music_${i}.mp3`);
        await downloadFile(musicTrack.items[i].sourceUrl, filePath);
        downloads[`m${i}`] = filePath;
      }
    }

    upd(job_id, 20, 'Обрабатываю клипы...');

    // === 2. Process each video clip: trim + speed ===
    const processedClips = [];
    for (let i = 0; i < videoTrack.items.length; i++) {
      const item = videoTrack.items[i];
      const srcPath = downloads[item.id || `v${i}`];
      const outPath = path.join(tmpDir, `processed_${i}.mp4`);

      if (item.sourceType === 'image') {
        // Image → 5sec video
        const dur = (item.endTime - item.startTime) || 5;
        await runFFmpeg([
          '-loop', '1', '-i', srcPath, '-t', String(dur),
          '-vf', `scale=${resolution.replace('x', ':')}:force_original_aspect_ratio=decrease,pad=${resolution.replace('x', ':')}:(ow-iw)/2:(oh-ih)/2:black`,
          '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
          '-r', '30', '-y', outPath
        ], job_id);
      } else {
        const args = ['-i', srcPath];
        if (item.trimStart != null) args.push('-ss', String(item.trimStart));
        if (item.trimEnd != null) args.push('-to', String(item.trimEnd));

        const speed = item.speed || 1.0;
        const vf = [`scale=${resolution.replace('x', ':')}:force_original_aspect_ratio=decrease,pad=${resolution.replace('x', ':')}:(ow-iw)/2:(oh-ih)/2:black`];
        const af = [];

        if (speed !== 1.0) {
          vf.push(`setpts=PTS/${speed}`);
          if (speed >= 0.5 && speed <= 2.0) {
            af.push(`atempo=${speed}`);
          } else if (speed > 2.0) {
            af.push(`atempo=2.0,atempo=${speed / 2.0}`);
          } else {
            af.push(`atempo=${speed}`);
          }
        }

        args.push('-vf', vf.join(','));
        if (af.length) args.push('-af', af.join(','));
        args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23');
        args.push('-c:a', 'aac', '-b:a', '128k');
        args.push('-r', '30', '-y', outPath);
        await runFFmpeg(args, job_id);
      }

      processedClips.push(outPath);
      console.log(`[render-timeline][${job_id}] Processed clip ${i}`);
    }

    upd(job_id, 45, 'Склеиваю клипы...');

    // === 3. Concatenate video clips ===
    let concatPath;
    if (processedClips.length === 1) {
      concatPath = processedClips[0];
    } else {
      concatPath = path.join(tmpDir, 'concat.mp4');
      const listPath = path.join(tmpDir, 'concat_list.txt');
      const listContent = processedClips.map(p => `file '${p}'`).join('\n');
      fs.writeFileSync(listPath, listContent);
      await runFFmpeg([
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-r', '30', '-y', concatPath
      ], job_id);
    }

    upd(job_id, 60, 'Добавляю текст...');

    // === 4. Add text overlays ===
    let withTextPath = concatPath;
    if (textTrack?.items?.length) {
      withTextPath = path.join(tmpDir, 'with_text.mp4');
      const drawTexts = textTrack.items.map(item => {
        const text = (item.text || '').replace(/'/g, "\\'").replace(/:/g, "\\:");
        const size = item.textOptions?.fontSize || 32;
        const color = (item.textOptions?.fontColor || '#ffffff').replace('#', '');
        const pos = item.textOptions?.position || 'center';
        let y = '(h-text_h)/2';
        if (pos === 'top') y = 'h*0.1';
        if (pos === 'bottom') y = 'h*0.85-text_h';
        const enable = `between(t,${item.startTime},${item.endTime})`;
        return `drawtext=text='${text}':fontsize=${size * 2}:fontcolor=0x${color}:x=(w-text_w)/2:y=${y}:enable='${enable}':borderw=3:bordercolor=black`;
      });
      await runFFmpeg([
        '-i', concatPath,
        '-vf', drawTexts.join(','),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'copy', '-y', withTextPath
      ], job_id);
    }

    upd(job_id, 75, 'Микширую аудио...');

    // === 5. Mix audio tracks ===
    let finalPath = withTextPath;
    const audioInputs = [];
    const audioFilters = [];
    let inputIdx = 1; // 0 = video

    if (audioTrack?.items?.length && downloads['a0']) {
      audioInputs.push('-i', downloads['a0']);
      const vol = audioTrack.items[0].volume ?? 1.0;
      audioFilters.push({ idx: inputIdx, vol, label: `a${inputIdx}` });
      inputIdx++;
    }

    if (musicTrack?.items?.length && downloads['m0']) {
      audioInputs.push('-i', downloads['m0']);
      const vol = musicTrack.items[0].volume ?? 0.3;
      audioFilters.push({ idx: inputIdx, vol, label: `a${inputIdx}` });
      inputIdx++;
    }

    if (audioFilters.length > 0) {
      finalPath = path.join(tmpDir, 'final.mp4');
      const filterParts = [];
      const mixInputs = ['[0:a]volume=1[a0]'];
      const amixLabels = ['[a0]'];

      for (const af of audioFilters) {
        mixInputs.push(`[${af.idx}:a]volume=${af.vol}[${af.label}]`);
        amixLabels.push(`[${af.label}]`);
      }

      const filterComplex = mixInputs.join(';') + ';' + amixLabels.join('') + `amix=inputs=${amixLabels.length}:duration=first[outa]`;

      await runFFmpeg([
        '-i', withTextPath, ...audioInputs,
        '-filter_complex', filterComplex,
        '-map', '0:v', '-map', '[outa]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-y', finalPath
      ], job_id);
    }

    upd(job_id, 90, 'Загружаю результат...');

    // === 6. Upload to Supabase Storage ===
    const storagePath = `${user_id}/timeline-${job_id}.mp4`;
    const publicUrl = await uploadToStorage(supabase_url, service_key, 'video-exports', finalPath, storagePath);
    console.log(`[render-timeline][${job_id}] Uploaded: ${publicUrl}`);

    // === 7. Update render_jobs ===
    await updateRenderJob(supabase_url, service_key, job_id, {
      status: 'done', result_url: publicUrl, output_url: publicUrl,
      progress: 100, completed_at: new Date().toISOString()
    });

    jobs.set(job_id, { ...jobs.get(job_id), status: 'done', progress: 100, stage: 'Готово!', url: publicUrl });
    console.log(`[render-timeline][${job_id}] ✅ Done`);

  } catch (err) {
    console.error(`[render-timeline][${job_id}] ❌ ${err.message}`);
    jobs.set(job_id, { ...jobs.get(job_id), status: 'error', progress: 0, stage: 'Ошибка', error: err.message });
    try { await updateRenderJob(supabase_url, service_key, job_id, { status: 'failed', error_message: err.message, progress: 0 }); } catch (e) {}
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 500 * 1024 * 1024) throw new Error('File too large (max 500MB)');
  fs.writeFileSync(dest, buf);
}

function upd(id, progress, stage) { const j = jobs.get(id); if (j) { j.progress = progress; j.stage = stage; } }

module.exports = router;
