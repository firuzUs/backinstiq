const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

ffmpeg.setFfmpegPath(ffmpegStatic);

// ═══════════════════════════════════════════════════════════
// ГЛАВНАЯ ФУНКЦИЯ
// ═══════════════════════════════════════════════════════════
async function processJob(job_id, { scenes, assets, transcripts = [], settings }, supabase) {
  const tmpDir = path.join(os.tmpdir(), `instiq_${job_id}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  console.log(`\n🎬 Job ${job_id} | Сцен: ${scenes.length}`);

  try {
    await updateJob(supabase, job_id, { status: 'processing', progress: 5 });

    // 1. Скачиваем ассеты параллельно
    console.log('📥 Скачиваю ассеты...');
    const localAssets = await downloadAssets(assets, tmpDir);
    await updateJob(supabase, job_id, { progress: 15 });

    // 2. Рендерим каждую сцену
    console.log('✂️  Рендерю сцены...');
    const sceneFiles = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const asset = localAssets.find(a => a.file_index === scene.source_file_index);
      if (!asset) { console.warn(`⚠️ Ассет ${scene.source_file_index} не найден`); continue; }

      const sceneOut = path.join(tmpDir, `scene_${i}.mp4`);
      const transcript = transcripts.find(t => t.file_index === scene.source_file_index);

      console.log(`   [${i+1}/${scenes.length}] ${asset.type} speed=${scene.speed||1}`);
      await renderScene(asset, sceneOut, scene, settings, transcript, tmpDir, i);

      const progress = 15 + Math.round((i + 1) / scenes.length * 45);
      await updateJob(supabase, job_id, { progress });
      sceneFiles.push({ file: sceneOut, scene });
    }

    // 3. Склеиваем с переходами
    console.log('🔗 Склеиваю...');
    const merged = path.join(tmpDir, 'merged.mp4');
    await mergeWithTransitions(sceneFiles, merged, settings);
    await updateJob(supabase, job_id, { progress: 70 });

    // 4. Финальный микс: музыка + SFX
    console.log('🎵 Накладываю аудио...');
    const mixed = path.join(tmpDir, 'mixed.mp4');
    await applyMusicAndSFX(merged, mixed, scenes, settings, tmpDir);
    await updateJob(supabase, job_id, { progress: 85 });

    // 5. Финальный encode
    console.log('🎬 Финальный encode...');
    const final = path.join(tmpDir, 'final.mp4');
    await finalEncode(mixed, final);
    await updateJob(supabase, job_id, { progress: 95 });

    // 6. Загружаем
    console.log('☁️  Загружаю...');
    const result_url = await uploadResult(supabase, final, job_id);
    await updateJob(supabase, job_id, { status: 'done', progress: 100, result_url });
    console.log(`✅ Готово: ${result_url}`);

  } catch (err) {
    console.error(`❌ Ошибка:`, err.message);
    await updateJob(supabase, job_id, { status: 'error', error_message: err.message });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════
// РЕНДЕР ОДНОЙ СЦЕНЫ
// ═══════════════════════════════════════════════════════════
async function renderScene(asset, outputPath, scene, settings, transcript, tmpDir, sceneIndex) {
  const [W, H] = getResolution(settings.aspect_ratio || '9:16');
  const duration = scene.trim_end - scene.trim_start;
  const speed = scene.speed || 1.0;

  // Собираем video filtergraph
  const vFilters = [];

  // Масштаб + кроп (cover)
  vFilters.push(`scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`);

  // Ken Burns для фото и broll
  if (settings.enable_motion && (asset.type === 'photo' || scene.role === 'broll')) {
    const frames = Math.round((duration / speed) * 30);
    vFilters.push(`scale=iw*1.1:ih*1.1,crop=iw:ihih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=30`);
  }

  // Zoom to face
  if (scene.zoom_face) {
    const frames = Math.round((duration / speed) * 30);
    vFilters.push(`scale=iw*1.1:ih*1.1,crop=iw:ihih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=30`);
  }

  // Speed
  if (speed !== 1.0) {
    const pts = 1.0 / speed;
    vFilters.push(`setpts=${pts}*PTS`);
  }

  // Цветокоррекция
  const colorFilter = getColorGrade(settings.color_grade || 'viral');
  if (colorFilter) vFilters.push(colorFilter);

  // Shake
  if (scene.shake) {
    const px = scene.shake.intensity === 'heavy' ? 15 : scene.shake.intensity === 'medium' ? 8 : 3;
    const shakeDur = scene.shake.duration || 0.5;
    vFilters.push(`geq=lum='p(X+${px}*sin(2*PI*t/${shakeDur}),Y+${px}*cos(2*PI*t/${shakeDur}))':cb='p(X+${px}*sin(2*PI*t/${shakeDur}),Y+${px}*cos(2*PI*t/${shakeDur}))':cr='p(X+${px}*sin(2*PI*t/${shakeDur}),Y+${px}*cos(2*PI*t/${shakeDur}))'`);
  }

  // Glitch (RGB shift)
  if (scene.glitch) {
    const gStart = scene.glitch.at_second || 0;
    const gEnd = gStart + (scene.glitch.duration || 0.3);
    vFilters.push(`rgbashift=rh=4:bh=-4:enable='between(t,${gStart},${gEnd})'`);
  }

  // Glow (vignette reversed)
  if (settings.enable_glow && scene.face_visible) {
    vFilters.push(`vignette=PI/3:mode=backward`);
  }

  // Субтитры
  if (transcript && transcript.words && transcript.words.length > 0) {
    const assPath = path.join(tmpDir, `sub_${sceneIndex}.ass`);
    generateASS(transcript.words, assPath, settings, scene.trim_start, W, H);
    vFilters.push(`ass=${assPath}`);
  }

  // Hook text
  if (scene.hook_text && sceneIndex === 0) {
    const escaped = escapeDrawtext(scene.hook_text);
    vFilters.push(
      `drawtext=text='${escaped}':fontsize=${Math.round(H*0.055)}:fontcolor=white:` +
      `shadowcolor=black:shadowx=3:shadowy=3:x=(w-text_w)/2:y=h*0.25:` +
      `enable='between(t,0,3)':alpha='if(lt(t,0.3),t/0.3,if(gt(t,2.7),(3-t)/0.3,1))'`
    );
  }

  // Lower third (brand)
  if (settings.brand_name && sceneIndex === 0) {
    const escaped = escapeDrawtext(`${settings.brand_name}${settings.brand_title ? ' | ' + settings.brand_title : ''}`);
    const accent = (settings.accent_color || '#FF8C00').replace('#', '');
    vFilters.push(
      `drawbox=x=0:y=h-h/8:w=w:h=h/8:color=${accent}@0.85:t=fill:enable='between(t,0,3)'`,
      `drawtext=text='${escaped}':fontsize=${Math.round(H*0.032)}:fontcolor=white:` +
      `x=(w-text_w)/2:y=h-h/8+(h/8-text_h)/2:enable='between(t,0,3)'`
    );
  }

  // End card (последняя сцена)
  if (scene.role === 'cta' || scene.role === 'end') {
    const accent = (settings.accent_color || '#FF8C00').replace('#', '');
    const endStart = Math.max(0, duration - 3);
    vFilters.push(
      `drawbox=x=0:y=h*0.35:w=w:h=h*0.3:color=${accent}@0.9:t=fill:enable='gte(t,${endStart})'`,
      `drawtext=text='Подписывайся!':fontsize=${Math.round(H*0.06)}:fontcolor=white:` +
      `x=(w-text_w)/2:y=h*0.45:enable='gte(t,${endStart})'`
    );
  }

  // Stickers (callout + number_badge через drawtext)
  if (scene.stickers && scene.stickers.length > 0) {
    for (const sticker of scene.stickers) {
      const sx = Math.round((sticker.x / 100) * W);
      const sy = Math.round((sticker.y / 100) * H);
      const sColor = (sticker.color || settings.accent_color || '#FF8C00').replace('#', '');
      const appearAt = sticker.appear_at || 0;

      if (sticker.type === 'number_badge' || sticker.type === 'callout') {
        const txt = escapeDrawtext(sticker.text || '1');
        const fs = sticker.size === 'lg' ? Math.round(H*0.06) : sticker.size === 'sm' ? Math.round(H*0.03) : Math.round(H*0.045);
        vFilters.push(
          `drawbox=x=${sx-40}:y=${sy-40}:w=80:h=80:color=${sColor}@0.9:t=fill:enable='gte(t,${appearAt})'`,
          `drawtext=text='${txt}':fontsize=${fs}:fontcolor=white:x=${sx}-text_w/2:y=${sy}-text_h/2:enable='gte(t,${appearAt})'`
        );
      } else if (sticker.type === 'highlight') {
        vFilters.push(
          `drawbox=x=${sx-100}:y=${sy-25}:w=200:h=50:color=${sColor}@0.4:t=fill:enable='gte(t,${appearAt})'`
        );
      }
    }
  }

  // Строим команду
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg();

    if (asset.type === 'photo') {
      cmd = cmd.input(asset.local_path).inputOptions([`-loop 1`, `-t ${duration / speed}`]);
    } else {
      cmd = cmd.input(asset.local_path).seekInput(scene.trim_start).duration(duration / speed);
    }

    cmd = cmd.videoFilter(vFilters.join(','));

    // Audio
    if (asset.type === 'video' && speed !== 1.0) {
      const atempo = Math.min(Math.max(speed, 0.5), 2.0);
      cmd = cmd.audioFilter(`atempo=${atempo}`);
    }
    if (asset.type === 'photo') {
      cmd = cmd.outputOptions(['-an']);
    }

    cmd
      .outputOptions([
        '-c:v libx264', '-preset fast', '-crf 22',
        '-pix_fmt yuv420p', '-r 30',
        '-c:a aac', '-b:a 192k',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error(`Scene render failed: ${err.message}`)))
      .run();
  });
}

// ═══════════════════════════════════════════════════════════
// СКЛЕЙКА С ПЕРЕХОДАМИ
// ═══════════════════════════════════════════════════════════
async function mergeWithTransitions(sceneFiles, outputPath, settings) {
  if (sceneFiles.length === 0) throw new Error('Нет сцен');
  if (sceneFiles.length === 1) {
    fs.copyFileSync(sceneFiles[0].file, outputPath);
    return;
  }

  // Простая concat склейка (xfade требует точных длительностей — добавим в v2)
  return new Promise((resolve, reject) => {
    const concatPath = outputPath + '.txt';
    fs.writeFileSync(concatPath, sceneFiles.map(s => `file '${s.file}'`).join('\n'));

    ffmpeg()
      .input(concatPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions([
        '-c:v libx264', '-preset fast', '-crf 21',
        '-pix_fmt yuv420p', '-r 30',
        '-c:a aac', '-b:a 192k',
        '-movflags +faststart'
      ])
      .output(outputPath)
      .on('end', () => { fs.unlinkSync(concatPath); resolve(); })
      .on('error', reject)
      .run();
  });
}

// ═══════════════════════════════════════════════════════════
// МУЗЫКА + SFX
// ═══════════════════════════════════════════════════════════
async function applyMusicAndSFX(inputPath, outputPath, scenes, settings, tmpDir) {
  const hasMusicUrl = settings.music_url && settings.music_url.startsWith('http');

  if (!hasMusicUrl) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  // Скачиваем музыку
  const musicPath = path.join(tmpDir, 'music.mp3');
  const resp = await axios.get(settings.music_url, { responseType: 'arraybuffer' });
  fs.writeFileSync(musicPath, resp.data);

  const vol = settings.music_volume || 0.12;

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inputPath)
      .input(musicPath)
      .complexFilter([
        `[0:a]volume=1.0[speech]`,
        `[1:a]volume=${vol}[music]`,
        `[speech][music]amix=inputs=2:duration=first:dropout_transition=2[a]`
      ])
      .outputOptions([
        '-map 0:v', '-map [a]',
        '-c:v copy', '-c:a aac', '-b:a 192k',
        '-movflags +faststart'
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ═══════════════════════════════════════════════════════════
// ФИНАЛЬНЫЙ ENCODE
// ═══════════════════════════════════════════════════════════
function finalEncode(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264', '-preset medium', '-crf 20',
        '-pix_fmt yuv420p', '-r 30',
        '-c:a aac', '-b:a 192k',
        '-movflags +faststart'
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ═══════════════════════════════════════════════════════════
// ГЕНЕРАЦИЯ ASS СУБТИТРОВ
// ═══════════════════════════════════════════════════════════
function generateASS(words, assPath, settings, trimStart, W, H) {
  const style = settings.subtitle_style || 'bottom_burn';
  const accent = (settings.accent_color || '#FF8C00').replace('#', '');
  const accentASS = `&H00${accent.slice(4,6)}${accent.slice(2,4)}${accent.slice(0,2)}`;

  // Стили ASS
  const styles = {
    bottom_burn:    `Style: Default,Arial,${Math.round(H*0.042)},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,60,1`,
    viral_pop:      `Style: Default,Arial Bold,${Math.round(H*0.065)},&H00FFFFFF,&H000000FF,&H00000000,&H40000000,-1,0,0,0,100,100,0,0,1,3,0,5,10,10,${Math.round(H*0.1)},1`,
    outlined:       `Style: Default,Arial,${Math.round(H*0.045)},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,10,10,60,1`,
    highlight_roll: `Style: Default,Arial,${Math.round(H*0.042)},&H00FFFFFF,&H000000FF,${accentASS},&H00000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,60,1`,
    word_storm:     `Style: Default,Arial Bold,${Math.round(H*0.072)},&H00FFFFFF,&H000000FF,&H00000000,&H60000000,-1,0,0,0,100,100,0,0,1,4,0,5,10,10,${Math.round(H*0.4)},1`,
    emoji_enhanced: `Style: Default,Arial,${Math.round(H*0.042)},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,60,1`,
  };

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles[style] || styles.bottom_burn}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Группируем слова по 4 (или по одному для word_storm и viral_pop)
  let events = '';
  const perGroup = (style === 'word_storm' || style === 'viral_pop') ? 1 : 4;

  for (let i = 0; i < words.length; i += perGroup) {
    const group = words.slice(i, i + perGroup);
    const start = toASSTime(group[0].start - trimStart);
    const end = toASSTime(group[group.length - 1].end - trimStart + 0.05);
    const text = group.map(w => w.text).join(' ');

    // Эмодзи для emoji_enhanced
    const suffix = style === 'emoji_enhanced' ? getContextEmoji(text) : '';

    events += `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}${suffix}\n`;
  }

  fs.writeFileSync(assPath, header + events, 'utf8');
}

function toASSTime(sec) {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function getContextEmoji(text) {
  const map = {
    'деньги|доход|заработ|прибыль': ' 💰',
    'успех|победа|достиг': ' 🏆',
    'внимание|важно|ключевой': ' ⚡',
    'сердц|люб|чувств': ' ❤️',
    'огонь|горит|жар': ' 🔥',
    'идея|мысль|думать': ' 💡',
    'рост|растет|увеличива': ' 📈',
  };
  const lower = text.toLowerCase();
  for (const [pattern, emoji] of Object.entries(map)) {
    if (new RegExp(pattern).test(lower)) return emoji;
  }
  return '';
}

// ═══════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ
// ═══════════════════════════════════════════════════════════
function getResolution(ratio) {
  return {
    '9:16': [1080, 1920],
    '16:9': [1920, 1080],
    '1:1':  [1080, 1080],
    '4:5':  [1080, 1350],
  }[ratio] || [1080, 1920];
}

function getColorGrade(preset) {
  return {
    cinema:      'eq=contrast=1.15:saturation=0.85:brightness=-0.08,vignette=PI/4',
    golden_hour: 'eq=contrast=1.08:saturation=1.2:brightness=0.05,colorbalance=rs=0.1:gs=0.05:bs=-0.05',
    clean_white: 'eq=contrast=1.05:saturation=0.9:brightness=0.08',
    neon_night:  'eq=contrast=1.25:saturation=1.4:brightness=-0.12,vignette=PI/3',
    matte_film:  'eq=contrast=0.92:saturation=0.8:brightness=0.02,noise=alls=3:allf=t',
    viral:       'eq=contrast=1.3:saturation=1.35:brightness=-0.05,vignette=PI/4',
  }[preset] || 'eq=contrast=1.3:saturation=1.35:brightness=-0.05';
}

function escapeDrawtext(text) {
  return (text || '').replace(/'/g, "\u2019").replace(/:/g, '\\:').replace(/,/g, '\\,');
}

async function downloadAssets(assets, tmpDir) {
  return Promise.all(assets.map(async (asset) => {
    const ext = asset.type === 'photo' ? '.jpg' : '.mp4';
    const localPath = path.join(tmpDir, `asset_${asset.file_index}${ext}`);
    const resp = await axios.get(asset.storage_url, { responseType: 'arraybuffer' });
    fs.writeFileSync(localPath, resp.data);
    return { ...asset, local_path: localPath };
  }));
}

async function uploadResult(supabase, filePath, job_id) {
  const buffer = fs.readFileSync(filePath);
  const fileName = `renders/${job_id}/final.mp4`;
  const { error } = await supabase.storage.from('video-exports')
    .upload(fileName, buffer, { contentType: 'video/mp4', upsert: true });
  if (error) throw error;
  return supabase.storage.from('video-exports').getPublicUrl(fileName).data.publicUrl;
}

async function updateJob(supabase, job_id, updates) {
  await supabase.from('render_jobs')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', job_id);
}

module.exports = { processJob };