import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import archiver from "archiver";
import { restoreSiteToFolder, pickTimestampFromInputs } from "./wb_restore_core.js";

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Wayback Site Restore</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,sans-serif;margin:0;padding:40px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;color:#333}
    .container{max-width:900px;margin:0 auto;background:#fff;border-radius:20px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,.1)}
    h2{text-align:center;color:#4a5568;margin-bottom:30px;font-size:2.5em;font-weight:700}
    .hint{background:linear-gradient(135deg,#e6fffa 0%,#b2f5ea 100%);border-left:5px solid #38b2ac;padding:20px;margin:20px 0;border-radius:10px;color:#2d3748}
    .hint b{color:#319795}
    form{margin-top:30px}
    label{display:block;margin-top:20px;font-weight:600;color:#4a5568;font-size:1.1em}
    input{width:100%;padding:15px;border:2px solid #e2e8f0;border-radius:12px;font-size:1em;transition:border-color 0.3s}
    input:focus{border-color:#667eea;outline:none;box-shadow:0 0 0 3px rgba(102,126,234,0.1)}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:20px}
    button{margin-top:30px;padding:15px 30px;border:0;border-radius:12px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;font-weight:700;font-size:1.1em;cursor:pointer;transition:transform 0.2s,box-shadow 0.2s;width:100%}
    button:hover{transform:translateY(-2px);box-shadow:0 10px 25px rgba(102,126,234,0.3)}
    small{color:#718096;margin-top:5px;display:block}
    .overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(5px)}
    .box{background:#fff;border-radius:20px;padding:30px;width:min(600px,90vw);box-shadow:0 25px 50px rgba(0,0,0,.25);text-align:center}
    .spinner{width:50px;height:50px;border:5px solid #e2e8f0;border-top-color:#667eea;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .muted{color:#718096;font-size:1em;margin-bottom:20px}
    .logs{margin-top:20px;font-family:'SF Mono',Monaco,Inconsolata,'Roboto Mono',monospace;font-size:0.9em;background:#f7fafc;padding:20px;border-radius:12px;max-height:300px;overflow:auto;border:1px solid #e2e8f0}
    .step{display:flex;align-items:center;margin-bottom:10px;padding:10px;border-radius:8px;background:#edf2f7}
    .step::before{content:'⏳';margin-right:10px;font-size:1.2em}
    .step.done::before{content:'✅';color:#38a169}
    .step.done{background:#c6f6d5}
  </style>
</head>
<body>
  <div class="container">
    <h2>🌐 Wayback Site Restore</h2>
    <div class="hint">
      <div><b>Input:</b> Domain URL (only) OR Domain + Date (YYYY-MM-DD) OR Wayback URL</div>
      <div><b>Output:</b> Same-domain pages + assets ZIP download</div>
    </div>

    <form method="POST" action="/restore" id="restoreForm">
      <label>Domain URL</label>
      <input name="url" placeholder="https://example.com/" required />

      <div class="row">
        <div>
          <label>Date (YYYY-MM-DD) (optional)</label>
          <input name="date" placeholder="2025-02-28" />
          <small>If given, picks closest capture to noon.</small>
        </div>
        <div>
          <label>Wayback URL (optional)</label>
          <input name="wayback" placeholder="https://web.archive.org/web/20250228153124/https://example.com/" />
          <small>If given, timestamp is extracted.</small>
        </div>
      </div>

      <label>Max Pages (recommended)</label>
      <input name="maxPages" placeholder="200" />
      <small>If huge website, please enter like 400,500.</small>

      <button type="submit">🚀 Restore & Download ZIP</button>
    </form>
  </div>

  <div class="overlay" id="overlay">
    <div class="box">
      <div class="spinner"></div>
      <div><b>Restoring from Wayback…</b></div>
      <div class="muted">ZIP will download once ready.</div>
      <div class="logs">
        <div class="step" id="step1">Pick timestamp (auto if only URL)</div>
        <div class="step" id="step2">Crawl pages (same domain)</div>
        <div class="step" id="step3">Download assets (CSS imports, url() images/fonts)</div>
        <div class="step" id="step4">Rewrite links</div>
        <div class="step" id="step5">Zip…</div>
      </div>
    </div>
  </div>

<script>
  const form = document.getElementById("restoreForm");
  const overlay = document.getElementById("overlay");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    overlay.style.display = "flex";
    const formData = new FormData(form);
    const data = new URLSearchParams();
    for (let [key, value] of formData) {
      data.append(key, value);
    }
    try {
      const response = await fetch('/restore', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, 
        body: data 
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText);
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition');
      const filename = disposition ? disposition.split('filename=')[1].replace(/"/g, '') : 'site.zip';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      document.querySelector('.box b').textContent = 'Done!';
      setTimeout(() => overlay.style.display = 'none', 2000);
    } catch (e) {
      alert(e.message);
      overlay.style.display = 'none';
    }
  });
</script>
</body>
</html>`);
});

app.post("/restore", async (req, res) => {
  try {
    const url = (req.body.url || "").trim();
    const date = (req.body.date || "").trim();
    const wayback = (req.body.wayback || "").trim();
    const maxPages = Math.max(1, Math.min(5000, parseInt(req.body.maxPages || "200", 10)));

    if (!url.startsWith("http")) throw new Error("Please provide a valid URL (http/https).");

    const { timestamp, baseUrl, pickReason } =
      await pickTimestampFromInputs({ url, date, wayback });

    console.log("---- RESTORE REQUEST ----");
    console.log("Base URL:", baseUrl);
    console.log("Timestamp:", timestamp);
    console.log("Pick reason:", pickReason);
    console.log("Max Pages:", maxPages);

    const jobId = crypto.randomBytes(6).toString("hex");
    const outDir = path.join(os.tmpdir(), `wb-site-${jobId}`);
    fs.mkdirSync(outDir, { recursive: true });

    await restoreSiteToFolder({ baseUrl, timestamp, outDir, maxPages, pickReason });

    const zipName = `site_${new URL(baseUrl).host}_${timestamp}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    console.log("Zipping & streaming…", zipName);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => { throw err; });
    archive.pipe(res);

    archive.directory(outDir, false);
    await archive.finalize();

    console.log("Done ✅", zipName);
  } catch (e) {
    res.status(400).send(`<pre style="font-family:ui-monospace,Consolas">${String(e?.message || e)}</pre>`);
  }
});

app.listen(3000, () => console.log("✅ Open http://localhost:3000"));
