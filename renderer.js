var ffmpeg = require('fluent-ffmpeg');
var ffmpegStatic = require('ffmpeg-static');
var fs = require('fs');
var path = require('path');
var os = require('os');
var axios = require('axios');

ffmpeg.setFfmpegPath(ffmpegStatic);

async function processJob(job_id, jobData, supabase) {
  var scenes = jobData.scenes;
  var assets = jobData.assets;
  var settings = jobData.settings;

  var tmpDir = path.join(os.tmpdir(), 'instiq_' + job_id);
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log('Starting render job: ' + job_id);
  console.log('Scenes: ' + scenes.length + ', Assets: ' + assets.length);

  try {
    await updateJob(supabase, job_id, { status: 'processing', progress: 5 });

    // Step 1: Download assets
    console.log('Downloading assets...');
    var localAssets = await downloadAssets(assets, tmpDir);
    await updateJob(supabase, job_id, { progress: 20 });

    // Step 2: Render each scene
    console.log('Rendering scenes...');
    var sceneFiles = await renderScenes(scenes, localAssets, tmpDir, settings, supabase, job_id);
    await updateJob(supabase, job_id, { progress: 60 });

    // Step 3: Merge scenes
    console.log('Merging scenes...');
    var mergedVideo = path.join(tmpDir, 'merged.mp4');
    await mergeScenes(sceneFiles, mergedVideo);
    await updateJob(supabase, job_id, { progress: 75 });

    // Step 4: Apply color grade + audio
    console.log('Applying effects...');
    var finalVideo = path.join(tmpDir, 'final.mp4');
    await applyFinalEffects(mergedVideo, finalVideo, settings);
    await updateJob(supabase, job_id, { progress: 90 });

    // Step 5: Upload to Supabase Storage
    console.log('Uploading result...');
    var result_url = await uploadResult(supabase, finalVideo, job_id);
    await updateJob(supabase, job_id, { status: 'done', progress: 100, result_url: result_url });

    console.log('Job done: ' + job_id + ' -> ' + result_url);

  } catch (err) {
    console.error('Job error ' + job_id + ': ' + err.message);
    await updateJob(supabase, job_id, { status: 'error', error_message: err.message });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function downloadAssets(assets, tmpDir) {
  var localAssets = [];

  for (var i = 0; i < assets.length; i++) {
    var asset = assets[i];
    var ext = asset.type === 'photo' ? '.jpg' : '.mp4';
    var localPath = path.join(tmpDir, 'asset_' + asset.file_index + ext);

    console.log('Downloading: ' + asset.storage_url);
    var response = await axios.get(asset.storage_url, { responseType: 'arraybuffer' });
    fs.writeFileSync(localPath, response.data);

    localAssets.push({
      file_index: asset.file_index,
      type: asset.type,
      storage_url: asset.storage_url,
      local_path: localPath
    });
  }

  return localAssets;
}

async function renderScenes(scenes, localAssets, tmpDir, settings, supabase, job_id) {
  var sceneFiles = [];
  var total = scenes.length;

  for (var i = 0; i < scenes.length; i++) {
    var scene = scenes[i];
    var asset = null;

    for (var j = 0; j < localAssets.length; j++) {
      if (localAssets[j].file_index === scene.source_file_index) {
        asset = localAssets[j];
        break;
      }
    }

    if (!asset) {
      console.log('Asset not found for scene ' + i + ', skipping');
      continue;
    }

    var outputPath = path.join(tmpDir, 'scene_' + i + '.mp4');
    console.log('Scene ' + (i + 1) + '/' + total + ': ' + asset.type + ' [' + scene.trim_start + 's -> ' + scene.trim_end + 's]');

    if (asset.type === 'photo') {
      await renderPhotoScene(asset.local_path, outputPath, scene, settings);
    } else {
      await renderVideoScene(asset.local_path, outputPath, scene, settings);
    }

    var progress = 20 + Math.round((i + 1) / total * 40);
    await updateJob(supabase, job_id, { progress: progress });

    sceneFiles.push(outputPath);
  }

  return sceneFiles;
}

function renderVideoScene(inputPath, outputPath, scene, settings) {
  return new Promise(function(resolve, reject) {
    var duration = scene.trim_end - scene.trim_start;
    var speed = scene.speed || 1.0;
    var res = getResolution(settings.aspect_ratio);
    var width = res[0];
    var height = res[1];

    var scaleFilter = 'scale=' + width + ':' + height + ':force_original_aspect_ratio=increase,crop=' + width + ':' + height;

    var filters = [scaleFilter];

    if (speed !== 1.0) {
      filters.push('setpts=' + (1.0 / speed) + '*PTS');
    }

    if (scene.zoom_face) {
      var frames = Math.round(duration * 25);
      filters.push('zoompan=z=\'min(zoom+0.001,1.3)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=' + frames + ':s=' + width + 'x' + height);
    }

    var cmd = ffmpeg(inputPath)
      .seekInput(scene.trim_start)
      .duration(duration / speed)
      .videoFilter(filters.join(','))
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-pix_fmt yuv420p',
        '-r 30'
      ]);

    if (speed !== 1.0) {
      var tempo = Math.min(Math.max(speed, 0.5), 2.0);
      cmd = cmd.audioFilter('atempo=' + tempo);
    }

    cmd.output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function renderPhotoScene(inputPath, outputPath, scene, settings) {
  return new Promise(function(resolve, reject) {
    var duration = scene.trim_end - scene.trim_start;
    var fps = 30;
    var frames = Math.round(duration * fps);
    var res = getResolution(settings.aspect_ratio);
    var width = res[0];
    var height = res[1];

    var zoomFilter = [
      'scale=' + (width * 2) + ':' + (height * 2),
      'zoompan=z=\'min(zoom+0.0008,1.2)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=' + frames + ':s=' + width + 'x' + height + ':fps=' + fps
    ].join(',');

    ffmpeg(inputPath)
      .loop(duration)
      .videoFilter(zoomFilter)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-pix_fmt yuv420p',
        '-r 30',
        '-an'
      ])
      .duration(duration)
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function mergeScenes(sceneFiles, outputPath) {
  return new Promise(function(resolve, reject) {
    if (sceneFiles.length === 0) {
      reject(new Error('No scenes to merge'));
      return;
    }

    if (sceneFiles.length === 1) {
      fs.copyFileSync(sceneFiles[0], outputPath);
      resolve();
      return;
    }

    var concatPath = outputPath.replace('.mp4', '_list.txt');
    var lines = sceneFiles.map(function(f) { return "file '" + f + "'"; });
    fs.writeFileSync(concatPath, lines.join('\n'));

    ffmpeg()
      .input(concatPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 22',
        '-pix_fmt yuv420p',
        '-movflags +faststart'
      ])
      .output(outputPath)
      .on('end', function() {
        fs.unlinkSync(concatPath);
        resolve();
      })
      .on('error', reject)
      .run();
  });
}

function applyFinalEffects(inputPath, outputPath, settings) {
  return new Promise(function(resolve, reject) {
    var colorFilter = getColorGradeFilter(settings.color_grade || 'viral');
    var allFilters = colorFilter + ',vignette=PI/5';

    ffmpeg(inputPath)
      .videoFilter(allFilters)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 21',
        '-c:a aac',
        '-b:a 192k',
        '-pix_fmt yuv420p',
        '-movflags +faststart'
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function uploadResult(supabase, filePath, job_id) {
  var fileBuffer = fs.readFileSync(filePath);
  var fileName = 'renders/' + job_id + '/final.mp4';

  var uploadResult = await supabase.storage
    .from('video-exports')
    .upload(fileName, fileBuffer, {
      contentType: 'video/mp4',
      upsert: true
    });

  if (uploadResult.error) {
    throw uploadResult.error;
  }

  var urlResult = supabase.storage
    .from('video-exports')
    .getPublicUrl(fileName);

  return urlResult.data.publicUrl;
}

function getResolution(aspect_ratio) {
  var resolutions = {
    '9:16': [1080, 1920],
    '16:9': [1920, 1080],
    '1:1':  [1080, 1080],
    '4:5':  [1080, 1350]
  };
  return resolutions[aspect_ratio] || [1080, 1920];
}

function getColorGradeFilter(preset) {
  var grades = {
    cinema: 'eq=contrast=1.15:saturation=0.85:brightness=-0.04',
    golden_hour: 'eq=contrast=1.08:saturation=1.2:brightness=0.03',
    clean_white: 'eq=contrast=1.05:saturation=0.9:brightness=0.06',
    neon_night: 'eq=contrast=1.25:saturation=1.4:brightness=-0.08',
    matte_film: 'eq=contrast=0.92:saturation=0.8:brightness=0.02',
    viral: 'eq=contrast=1.3:saturation=1.35:brightness=-0.04'
  };
  return grades[preset] || grades.viral;
}

async function updateJob(supabase, job_id, updates) {
  updates.updated_at = new Date().toISOString();
  var result = await supabase
    .from('render_jobs')
    .update(updates)
    .eq('id', job_id);

  if (result.error) {
    console.error('DB update error:', result.error.message);
  }
}

module.exports = { processJob: processJob };
