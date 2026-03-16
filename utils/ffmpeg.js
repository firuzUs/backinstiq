const { spawn } = require('child_process');

function runFFmpeg(args, jobId) {
  return new Promise((resolve, reject) => {
    console.log(`[convert][${jobId}] ffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else { console.error(`[convert][${jobId}] ffmpeg stderr:\n${stderr.slice(-2000)}`); reject(new Error(`FFmpeg exited with code ${code}`)); }
    });
    proc.on('error', (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
    const timeout = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('FFmpeg timeout (10 min)')); }, 600000);
    proc.on('close', () => clearTimeout(timeout));
  });
}

function getDuration(filePath, jobId) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => { if (code === 0) { resolve(parseFloat(out.trim())); } else reject(new Error('ffprobe failed')); });
    proc.on('error', (err) => reject(err));
  });
}

module.exports = { runFFmpeg, getDuration };
