const fs = require('fs');

async function uploadToStorage(supabaseUrl, serviceKey, bucket, filePath, storagePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const url = `${supabaseUrl}/storage/v1/object/${bucket}/${storagePath}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
      'Content-Type': 'video/mp4',
    },
    body: fileBuffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage upload failed (${res.status}): ${text}`);
  }
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${storagePath}`;
}

async function updateRenderJob(supabaseUrl, serviceKey, jobId, data) {
  const url = `${supabaseUrl}/rest/v1/render_jobs?id=eq.${jobId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) console.error(`[supabase] Failed to update job ${jobId}: ${await res.text()}`);
}

module.exports = { uploadToStorage, updateRenderJob };
