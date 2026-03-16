const fs = require('fs');

function generateASS(options) {
  const { words, plainText, duration, accentColor, outputPath } = options;
  const bgr = hexToBGR(accentColor || '#FF8C00');
  const header = `[Script Info]
Title: InstIQ Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,44,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,20,20,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  let events = '';
  if (words && words.length > 0) {
    for (let i = 0; i < words.length; i += 4) {
      const chunk = words.slice(i, i + 4);
      const start = fmtTime(chunk[0].start);
      const end = fmtTime(chunk[chunk.length - 1].end);
      let text = '';
      for (const w of chunk) {
        const dur = Math.round((w.end - w.start) * 100);
        text += `{\\kf${dur}}{\\c&H${bgr}&}${w.word}{\\c&HFFFFFF&} `;
      }
      events += `Dialogue: 0,${start},${end},Default,,0,0,0,,${text.trim()}\n`;
    }
  } else if (plainText) {
    const lines = plainText.split('\n').filter(l => l.trim());
    const tpl = (duration || 60) / Math.max(lines.length, 1);
    for (let i = 0; i < lines.length; i++) {
      const ws = lines[i].trim().split(/\s+/);
      const chunks = [];
      for (let j = 0; j < ws.length; j += 5) chunks.push(ws.slice(j, j + 5).join(' '));
      events += `Dialogue: 0,${fmtTime(i * tpl)},${fmtTime((i + 1) * tpl)},Default,,0,0,0,,${chunks.join('\\N')}\n`;
    }
  }
  fs.writeFileSync(outputPath, header + events, 'utf-8');
  return outputPath;
}

function fmtTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function hexToBGR(hex) {
  const c = hex.replace('#','');
  return c.substring(4,6) + c.substring(2,4) + c.substring(0,2);
}

module.exports = { generateASS };
