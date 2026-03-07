const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const { execSync } = require('child_process');
let ffmpegPath = ffmpegStatic;
try {
  const sysPath = execSync('which ffmpeg').toString().trim();
  if (sysPath) { ffmpegPath = sysPath; console.log('✅ Системный FFmpeg:', sysPath); }
} catch(e) { console.log('⚠️ Используем ffmpeg-static'); }
ffmpeg.setFfmpegPath(ffmpegPath);

// ═══════════════════════════════════════════════════════════
// ГЛАВНАЯ ФУНКЦИЯ
// ═══════════════════════════════════════════════════════════

async function processJob(job_id, { scenes, assets, settings, transcripts }, supabase) {
  const tmpDir = path.join(os.tmpdir(), `instiq_${job_id}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  console.log(`\n🎬 Job: ${job_id} | Сцен: ${scenes.length}`);

  try {
    await updateJob(supabase, job_id, { status: 'processing', progress: 5 });

    // 1. Скачиваем все ассеты
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

      const outputPath = path.join(tmpDir, `scene_${i}.mp4`);
      console.log(`   [${i+1}/${scenes.length}] ${asset.type} speed=${scene.speed || 1}`);

      if (asset.type === 'photo') {
        await renderPhoto(asset.local_path, outputPath, scene, settings);
      } else {
        await renderVideo(asset.local_path, outputPath, scene, settings);
      }

      sceneFiles.push({ path: outputPath, scene });
      await updateJob(supabase, job_id, { progress: 15 + Math.round((i+1) / scenes.length * 45) });
    }

    // 3. Склейка
    console.log('🔗 Склеиваю сцены...');
    const merged = path.join(tmpDir, 'merged.mp4');
    await mergeScenes(sceneFiles, merged);
    await updateJob(supabase, job_id, { progress: 65 });

    // 4. Субтитры
    console.log("📝 Транскрипты:", JSON.stringify(transcripts?.length), "слов:", transcripts?.reduce((a,t) => a + (t.words?.length||0), 0));
  const allWords = buildWordTimeline(scenes, transcripts);
    console.log("💬 Слов для субтитров:", allWords.length);
    let withSubs = merged;

    if (allWords.length > 0 && settings.subtitle_style) {
      console.log(`💬 Субтитры: ${settings.subtitle_style}...`);
      const assFile = path.join(tmpDir, 'subs.ass');
      const accent = settings.accent_color || '#FF8C00';
      const style = settings.subtitle_style || 'bottom_burn';

      generateASS(allWords, assFile, style, accent);

      withSubs = path.join(tmpDir, 'subtitled.mp4');
      console.log("🔥 Запускаю burnSubtitles, ass=", assFile);
      await burnSubtitles(merged, withSubs, allWords, style, accent);
      console.log("✅ burnSubtitles завершён");
    }
    await updateJob(supabase, job_id, { progress: 82 });

    // 5. Цветокоррекция + музыка
    console.log('🎨 Цвет + музыка...');
    const final = path.join(tmpDir, 'final.mp4');
    await applyColorAndMusic(withSubs, final, settings);
    await updateJob(supabase, job_id, { progress: 95 });

    // 6. Загрузка в Supabase
    console.log('☁️  Загружаю результат...');
    const result_url = await uploadResult(supabase, final, job_id);
    await updateJob(supabase, job_id, { status: 'done', progress: 100, result_url });
    console.log(`✅ Готово! ${result_url}`);

  } catch (err) {
    console.error(`❌ Ошибка job ${job_id}:`, err.message);
    await updateJob(supabase, job_id, { status: 'error', error_message: err.message });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════
// СКАЧИВАНИЕ АССЕТОВ
// ═══════════════════════════════════════════════════════════

async function downloadAssets(assets, tmpDir) {
  const result = [];
  for (const asset of assets) {
    const ext = asset.type === 'photo' ? '.jpg' : '.mp4';
    const localPath = path.join(tmpDir, `asset_${asset.file_index}${ext}`);
    console.log(`   ↓ ${asset.storage_url.split('/').pop()}`);
    const response = await axios.get(asset.storage_url, {
      responseType: 'arraybuffer',
      timeout: 120000,
    });
    fs.writeFileSync(localPath, response.data);
    result.push({ ...asset, local_path: localPath });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════
// РЕНДЕР ВИДЕО-СЦЕНЫ
// ═══════════════════════════════════════════════════════════

function renderVideo(inputPath, outputPath, scene, settings) {
  return new Promise((resolve, reject) => {
    const duration = scene.trim_end - scene.trim_start;
    const speed = scene.speed || 1.0;
    const [w, h] = getRes(settings.aspect_ratio);

    // Cover-crop: масштаб с сохранением пропорций + кроп по центру
    const scaleFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
    const speedFilter = speed !== 1.0 ? `,setpts=${1/speed}*PTS` : '';

    const cmd = ffmpeg(inputPath)
      .seekInput(scene.trim_start)
      .duration(duration / speed)
      .videoFilter(`${scaleFilter}${speedFilter}`)
      .outputOptions([
        '-c:v libx264',
        '-preset medium',
        '-crf 18',
        '-pix_fmt yuv420p',
        '-r 30',
        '-movflags +faststart',
      ]);

    // Аудио
    if (speed !== 1.0) {
      cmd.audioFilter(`atempo=${Math.min(Math.max(speed, 0.5), 2.0)}`);
    }

    cmd
      .outputOptions(['-c:a aac', '-b:a 192k', '-ar', '44100', '-ac', '2'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error(`Сцена ${scene.scene_index}: ${err.message}`)))
      .run();
  });
}

// ═══════════════════════════════════════════════════════════
// РЕНДЕР ФОТО-СЦЕНЫ
// ═══════════════════════════════════════════════════════════

function renderPhoto(inputPath, outputPath, scene, settings) {
  return new Promise((resolve, reject) => {
    const duration = scene.trim_end - scene.trim_start;
    const [w, h] = getRes(settings.aspect_ratio);

    ffmpeg(inputPath)
      .loop(duration)
      .videoFilter(
        `scale=${w}:${h}:force_original_aspect_ratio=increase,` +
        `crop=${w}:${h},setsar=1`
      )
      .outputOptions([
        '-c:v libx264',
        '-preset medium',
        '-crf 18',
        '-pix_fmt yuv420p',
        '-r 30',
        '-an',
        '-t', String(duration),
        '-movflags +faststart',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error(`Фото сцена ${scene.scene_index}: ${err.message}`)))
      .run();
  });
}

// ═══════════════════════════════════════════════════════════
// СКЛЕЙКА СЦЕН
// ═══════════════════════════════════════════════════════════

function mergeScenes(sceneFiles, outputPath) {
  if (sceneFiles.length === 0) throw new Error('Нет сцен для склейки');
  if (sceneFiles.length === 1) {
    fs.copyFileSync(sceneFiles[0].path, outputPath);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const concatFile = outputPath + '_concat.txt';
    fs.writeFileSync(concatFile, sceneFiles.map(s => `file '${s.path}'`).join('\n'));

    ffmpeg()
      .input(concatFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions([
        '-c:v libx264',
        '-preset medium',
        '-crf 18',
        '-c:a aac',
        '-b:a 192k',
        '-ar 44100',
        '-ac 2',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
      ])
      .output(outputPath)
      .on('end', () => { try { fs.unlinkSync(concatFile); } catch {} resolve(); })
      .on('error', reject)
      .run();
  });
}

// ═══════════════════════════════════════════════════════════
// СУБТИТРЫ — ТАЙМЛАЙН СЛОВ
// ═══════════════════════════════════════════════════════════

function buildWordTimeline(scenes, transcripts) {
  if (!transcripts || transcripts.length === 0) return [];

  const allWords = [];
  let offset = 0;

  for (const scene of scenes) {
    const duration = (scene.trim_end - scene.trim_start) / (scene.speed || 1);
    const t = transcripts.find(t => t.file_index === scene.source_file_index);

    if (t && t.words) {
      const words = t.words.filter(w =>
        w.start >= scene.trim_start && w.end <= scene.trim_end
      );
      for (const w of words) {
        allWords.push({
          text: w.text,
          start: offset + (w.start - scene.trim_start) / (scene.speed || 1),
          end:   offset + (w.end   - scene.trim_start) / (scene.speed || 1),
        });
      }
    }

    offset += duration;
  }

  return allWords;
}

// ═══════════════════════════════════════════════════════════
// ГЕНЕРАЦИЯ ASS ФАЙЛА
// ═══════════════════════════════════════════════════════════

function generateASS(words, assFile, style, accentHex) {
  const accent = hexToASS(accentHex);
  let content = '';

  switch (style) {
    case 'viral_pop':
      content = generateViralPop(words, accent);
      break;
    case 'outlined':
      content = generateOutlined(words);
      break;
    case 'highlight_roll':
      content = generateHighlightRoll(words, accent);
      break;
    case 'word_storm':
      content = generateWordStorm(words);
      break;
    case 'emoji_enhanced':
      content = generateEmojiEnhanced(words);
      break;
    case 'bottom_burn':
    default:
      content = generateBottomBurn(words);
      break;
  }

  // UTF-8 BOM нужен для кириллицы в ASS
  fs.writeFileSync(assFile, '\uFEFF' + content, 'utf8');
}

// ─── bottom_burn ─────────────────────────────────────────

function generateBottomBurn(words) {
  const phrases = groupIntoPhrases(words, 5, 0.5);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&HC0000000,1,0,0,0,100,100,0,0,3,0,0,2,40,40,180,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text`;

  const lines = phrases.map(p =>
    `Dialogue: 0,${toTime(p.start)},${toTime(p.end)},Default,,0,0,0,,${p.text}`
  );

  return header + '\n' + lines.join('\n');
}

// ─── viral_pop ───────────────────────────────────────────

function generateViralPop(words, accent) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Active,Arial Black,90,${accent},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,5,40,40,350,1
Style: Inactive,Arial Black,90,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,5,40,40,350,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text`;

  const lines = words.map((w, i) => {
    const style = i % 3 === 1 ? 'Active' : 'Inactive';
    const pop = `{\\fscx80\\fscy80\\t(0,100,\\fscx100\\fscy100)}`;
    return `Dialogue: 0,${toTime(w.start)},${toTime(w.end)},${style},,0,0,0,,${pop}${w.text}`;
  });

  return header + '\n' + lines.join('\n');
}

// ─── outlined ────────────────────────────────────────────

function generateOutlined(words) {
  const phrases = groupIntoPhrases(words, 3, 0.4);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Arial Black,96,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,2,0,1,6,0,5,40,40,350,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text`;

  const lines = phrases.map(p =>
    `Dialogue: 0,${toTime(p.start)},${toTime(p.end)},Default,,0,0,0,,${p.text.toUpperCase()}`
  );

  return header + '\n' + lines.join('\n');
}

// ─── highlight_roll (karaoke) ─────────────────────────────

function generateHighlightRoll(words, accent) {
  const phrases = groupIntoPhrases(words, 5, 0.5);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Karaoke,Arial Black,80,${accent},&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,40,40,200,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text`;

  const lines = phrases.map(p => {
    const karaokeText = p.words.map(w => {
      const durationCs = Math.round((w.end - w.start) * 100);
      return `{\\kf${durationCs}}${w.text}`;
    }).join(' ');
    return `Dialogue: 0,${toTime(p.start)},${toTime(p.end)},Karaoke,,0,0,0,,${karaokeText}`;
  });

  return header + '\n' + lines.join('\n');
}

// ─── word_storm ───────────────────────────────────────────

function generateWordStorm(words) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Storm,Arial Black,120,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,5,0,5,40,40,0,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text`;

  const lines = words.map(w => {
    const pop = `{\\fad(50,50)\\fscx120\\fscy120\\t(0,80,\\fscx100\\fscy100)}`;
    return `Dialogue: 0,${toTime(w.start)},${toTime(w.end)},Storm,,0,0,0,,${pop}${w.text.toUpperCase()}`;
  });

  return header + '\n' + lines.join('\n');
}

// ─── emoji_enhanced ──────────────────────────────────────

const EMOJI_MAP = {
  'удивительно|вау|невероятно|вот это': ['🤯', '😱'],
  'смешно|ржу|хаха|смех': ['😂', '🤣'],
  'круто|огонь|топ|лучший': ['🔥', '💯'],
  'смотри|внимание|важно|слушай': ['👀', '⚠️'],
  'секрет|лайфхак|трюк|совет': ['💡', '🤫'],
  'результат|итог|вывод|получилось': ['🚀', '✅'],
  'деньги|заработок|бизнес|доход': ['💰', '📈'],
  'еда|рецепт|готов|вкусно': ['🍳', '😋'],
  'любовь|сердце|чувства': ['❤️', '🥰'],
};

function pickEmoji(text) {
  for (const [pattern, emojis] of Object.entries(EMOJI_MAP)) {
    if (new RegExp(pattern, 'i').test(text)) {
      return emojis[0];
    }
  }
  return '✨';
}

function generateEmojiEnhanced(words) {
  const phrases = groupIntoPhrases(words, 5, 0.5);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&HC0000000,1,0,0,0,100,100,0,0,3,0,0,2,40,40,180,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text`;

  const lines = phrases.map(p => {
    const emoji = pickEmoji(p.text);
    return `Dialogue: 0,${toTime(p.start)},${toTime(p.end)},Default,,0,0,0,,${emoji} ${p.text}`;
  });

  return header + '\n' + lines.join('\n');
}

// ═══════════════════════════════════════════════════════════
// НАЛОЖЕНИЕ СУБТИТРОВ
// ═══════════════════════════════════════════════════════════


function burnSubtitles(inputPath, outputPath, words, style, accentHex) {
  return new Promise((resolve, reject) => {
    const phrases = groupIntoPhrases(words, 5, 0.5);
    if (phrases.length === 0) {
      fs.copyFileSync(inputPath, outputPath);
      return resolve();
    }

    const accent = (accentHex || '#FF8C00').replace('#', '');
    const styleConfig = {
      bottom_burn:   { fontsize: 64, fontcolor: 'white', box: 1, boxcolor: 'black@0.75', boxborderw: 16, x: '(w-text_w)/2', y: 'h-180' },
      viral_pop:     { fontsize: 80, fontcolor: '0x'+accent, box: 1, boxcolor: 'black@0.6', boxborderw: 20, x: '(w-text_w)/2', y: '(h-text_h)/2' },
      outlined:      { fontsize: 88, fontcolor: 'white', box: 0, borderw: 6, bordercolor: 'black', x: '(w-text_w)/2', y: '(h-text_h)/2' },
      highlight_roll:{ fontsize: 68, fontcolor: 'white', box: 1, boxcolor: '0x'+accent+'@0.85', boxborderw: 14, x: '(w-text_w)/2', y: 'h-200' },
      word_storm:    { fontsize: 100, fontcolor: 'white', box: 0, borderw: 5, bordercolor: 'black', x: '(w-text_w)/2', y: '(h-text_h)/2' },
      emoji_enhanced:{ fontsize: 64, fontcolor: 'white', box: 1, boxcolor: 'black@0.75', boxborderw: 16, x: '(w-text_w)/2', y: 'h-180' },
    };
    const cfg = styleConfig[style] || styleConfig.bottom_burn;

    const filterParts = phrases.map(phrase => {
      const text = phrase.text.replace(/'/g, '’').replace(/:/g, ' ').replace(/,/g, ' ');
      const start = phrase.start.toFixed(3);
      const end = phrase.end.toFixed(3);
      let f = `drawtext=text='${text}':fontsize=${cfg.fontsize}:fontcolor=${cfg.fontcolor}:x=${cfg.x}:y=${cfg.y}`;
      if (cfg.box) f += `:box=1:boxcolor=${cfg.boxcolor}:boxborderw=${cfg.boxborderw}`;
      if (cfg.borderw) f += `:borderw=${cfg.borderw}:bordercolor=${cfg.bordercolor}`;
      f += `:enable='between(t,${start},${end})'`;
      return f;
    });

    console.log('   🔤', phrases.length, 'фраз, стиль:', style);

    ffmpeg(inputPath)
      .videoFilter(filterParts.join(','))
      .outputOptions(['-c:v libx264','-preset medium','-crf 18','-c:a copy','-pix_fmt yuv420p','-movflags +faststart'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => {
        console.error('❌ drawtext ошибка:', err.message);
        fs.copyFileSync(inputPath, outputPath);
        resolve();
      })
      .run();
  });
}


// ═══════════════════════════════════════════════════════════
// ЦВЕТОКОРРЕКЦИЯ + МУЗЫКА
// ═══════════════════════════════════════════════════════════

function applyColorAndMusic(inputPath, outputPath, settings) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath);

    if (false && settings.music_url) { // музыка временно отключена
      const vol = settings.music_volume || 0.12;
      cmd = cmd
        .input(settings.music_url)
        .complexFilter([
          `[0:a]volume=1.0[speech]`,
          `[1:a]volume=${vol}[music]`,
          `[speech][music]amix=inputs=2:duration=first:dropout_transition=2[a]`,
        ])
        .outputOptions(['-map 0:v', '-map [a]']);
    }

    cmd
      .outputOptions([
        '-c:v libx264',
        '-preset medium',
        '-crf 18',
        '-c:a aac',
        '-b:a 192k',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ═══════════════════════════════════════════════════════════
// ЗАГРУЗКА В SUPABASE
// ═══════════════════════════════════════════════════════════

async function uploadResult(supabase, filePath, job_id) {
  const buffer = fs.readFileSync(filePath);
  const fileName = `renders/${job_id}/final.mp4`;

  const { error } = await supabase.storage
    .from('video-exports')
    .upload(fileName, buffer, { contentType: 'video/mp4', upsert: true });

  if (error) throw new Error(`Supabase upload: ${error.message}`);

  const { data } = supabase.storage.from('video-exports').getPublicUrl(fileName);
  return data.publicUrl;
}

// ═══════════════════════════════════════════════════════════
// УТИЛИТЫ
// ═══════════════════════════════════════════════════════════

function groupIntoPhrases(words, maxWords = 5, maxGap = 0.5) {
  const phrases = [];
  let group = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const gap = group.length > 0 ? w.start - group[group.length - 1].end : 0;
    const isLast = i === words.length - 1;

    if (group.length >= maxWords || gap > maxGap) {
      if (group.length > 0) {
        phrases.push({
          words: group,
          start: group[0].start,
          end: group[group.length - 1].end,
          text: group.map(w => w.text).join(' '),
        });
      }
      group = [];
    }

    group.push(w);

    if (isLast && group.length > 0) {
      phrases.push({
        words: group,
        start: group[0].start,
        end: group[group.length - 1].end,
        text: group.map(w => w.text).join(' '),
      });
    }
  }

  return phrases;
}

function toTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function hexToASS(hex, alpha = '00') {
  const clean = (hex || '#FF8C00').replace('#', '');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

function getRes(ratio) {
  const map = {
    '9:16': [1080, 1920],
    '16:9': [1920, 1080],
    '1:1':  [1080, 1080],
    '4:5':  [1080, 1350],
  };
  return map[ratio] || [1080, 1920];
}

function getColorFilter(preset) {
  const grades = {
    cinema:      'eq=contrast=1.12:saturation=0.88:brightness=-0.03',
    golden_hour: 'eq=contrast=1.06:saturation=1.15:brightness=0.02',
    clean_white: 'eq=contrast=1.03:saturation=0.92:brightness=0.04',
    neon_night:  'eq=contrast=1.18:saturation=1.3:brightness=-0.05',
    matte_film:  'eq=contrast=0.94:saturation=0.82:brightness=0.01',
    viral:       'eq=contrast=1.15:saturation=1.2:brightness=-0.02',
  };
  return grades[preset] || grades.viral;
}

async function updateJob(supabase, job_id, updates) {
  const { error } = await supabase
    .from('render_jobs')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', job_id);
  if (error) console.error('DB update error:', error.message);
}

module.exports = { processJob };




