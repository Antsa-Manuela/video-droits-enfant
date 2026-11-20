const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

// Une boucle = 25 s de séquence + 5 s de pause = 30 s.
// DURATION = 30 → une boucle (recommandé, rendu 2x plus court).
// DURATION = 60 → deux boucles.
const SEQ_END = 25;
const LOOP = 30;
const DURATION = 30;
const TOTAL_FRAMES = FPS * DURATION;
const PORT = 8000;

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'journee-droits-enfant.mp4');
const AUDIO_SRC = path.join(ROOT, 'Audio.mp3');
const AUDIO_SEG = path.join(OUTPUT_DIR, 'audio-boucle.wav');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.jfif': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const pathname = decodeURIComponent(
          new URL(req.url, 'http://localhost').pathname
        );
        const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const file = path.resolve(ROOT, relative);

        if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }

        fs.readFile(file, (error, data) => {
          if (error) {
            res.writeHead(404);
            return res.end('File not found: ' + relative);
          }
          const type = MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
          res.end(data);
        });
      } catch (error) {
        res.writeHead(400);
        res.end('Bad request');
      }
    });

    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      console.log('Serveur local démarré sur le port ' + PORT);
      resolve(server);
    });
  });
}

function waitForProcess(proc, name) {
  return new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error((name || 'Processus') + ' terminé avec le code ' + code));
    });
  });
}

function run(cmd, args) {
  const proc = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  return waitForProcess(proc, cmd);
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    throw new Error('index.html est introuvable à la racine du projet.');
  }
  if (!fs.existsSync(AUDIO_SRC)) {
    throw new Error('Audio.mp3 est introuvable.');
  }

  console.log('====================================');
  console.log('GÉNÉRATION VIDÉO FULL HD');
  console.log(`${WIDTH} x ${HEIGHT} | ${FPS} FPS | ${DURATION} secondes`);
  console.log('====================================');

  /* --------------------------------------------------------
     1) Audio préparé hors-ligne (aucune capture en direct)
        Même enveloppe que la page : fondu entrée 1 s,
        fondu sortie sur les 1,2 dernières secondes avant 25 s,
        volume 0.85, puis silence jusqu'à 30 s.
     -------------------------------------------------------- */
  console.log("Préparation de l'audio...");
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-stream_loop', '-1',
    '-t', String(SEQ_END),
    '-i', AUDIO_SRC,
    '-vn',
    '-af',
    `afade=t=in:st=0:d=1,afade=t=out:st=${SEQ_END - 1.2}:d=1.2,volume=0.85,apad=whole_dur=${LOOP}`,
    '-ar', '44100', '-ac', '2',
    AUDIO_SEG
  ]);

  const server = await startServer();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1
    });
    page.setDefaultTimeout(60000);

    page.on('pageerror', error => console.error('Erreur JavaScript :', error.message));

    // Le son est ajouté après : on n'a pas besoin que la page le charge.
    await page.route('**/Audio.mp3', route => route.abort());

    console.log('Chargement du projet HTML...');
    await page.goto(`http://127.0.0.1:${PORT}/?record=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('Attente des scènes, des polices et des images...');
    await page.waitForFunction(
      () => typeof render === 'function' &&
            typeof t !== 'undefined' &&
            document.querySelectorAll('#stage .scene').length === 8,
      { timeout: 30000 }
    );

    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(img => img.decode().catch(() => {})));
    });

    /* --------------------------------------------------------
       2) Horloge virtuelle : on fige toutes les animations CSS
          et on les place à l'instant exact de chaque image.
          Le rendu n'a plus besoin d'aller en temps réel.
       -------------------------------------------------------- */
    await page.evaluate(() => {
      playing = false;
      window.__born = new WeakMap();
      window.__step = (time, reset) => {
        if (reset) { cur = -1; isLoopReset = true; }
        t = time;
        render();
        void document.body.offsetHeight; // force le calcul des styles
        for (const a of document.getAnimations()) {
          if (!window.__born.has(a)) window.__born.set(a, time);
          a.pause();
          a.currentTime = (time - window.__born.get(a)) * 1000;
        }
      };
    });

    const dimensions = await page.evaluate(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    });
    console.log('Dimensions du stage :', dimensions);

    if (dimensions.width !== WIDTH || dimensions.height !== HEIGHT) {
      throw new Error('Dimensions incorrectes : ' + JSON.stringify(dimensions));
    }

    /* --------------------------------------------------------
       3) FFmpeg : images + audio préparé
       -------------------------------------------------------- */
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 'image2pipe',
      '-framerate', String(FPS),
      '-vcodec', 'mjpeg',
      '-i', 'pipe:0',

      '-stream_loop', '-1',
      '-i', AUDIO_SEG,

      '-map', '0:v:0',
      '-map', '1:a:0',

      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-r', String(FPS),

      '-c:a', 'aac',
      '-b:a', '192k',

      '-t', String(DURATION),
      '-shortest',
      '-movflags', '+faststart',
      OUTPUT_FILE
    ], { stdio: ['pipe', 'inherit', 'inherit'] });

    ffmpeg.stdin.on('error', error => {
      if (error.code !== 'EPIPE') console.error('Erreur FFmpeg stdin :', error.message);
    });
    const ffmpegDone = waitForProcess(ffmpeg, 'FFmpeg');

    console.log('Début du rendu Full HD...');
    const startTime = Date.now();
    let prevTime = 0;

    for (let i = 0; i < TOTAL_FRAMES; i++) {
      const time = (i / FPS) % LOOP;
      const wrapped = i > 0 && time < prevTime;
      prevTime = time;

      await page.evaluate(([tt, w]) => window.__step(tt, w), [time, wrapped]);

      const frame = await page.screenshot({
        type: 'jpeg',
        quality: 92,
        animations: 'allow',
        caret: 'hide'
      });

      if (!ffmpeg.stdin.write(frame)) {
        await new Promise(resolve => ffmpeg.stdin.once('drain', resolve));
      }

      if ((i + 1) % 60 === 0) {
        const done = i + 1;
        const elapsed = (Date.now() - startTime) / 1000;
        const perFrame = elapsed / done;
        const eta = Math.round(perFrame * (TOTAL_FRAMES - done) / 60);
        console.log(
          `Progression : ${Math.round(done / TOTAL_FRAMES * 100)}% ` +
          `(${done}/${TOTAL_FRAMES}) | ${perFrame.toFixed(2)} s/image | reste ~${eta} min`
        );
      }
    }

    console.log('Toutes les images ont été envoyées.');
    ffmpeg.stdin.end();
    await ffmpegDone;

    if (!fs.existsSync(OUTPUT_FILE)) throw new Error('La vidéo finale est introuvable.');
    const stats = fs.statSync(OUTPUT_FILE);
    if (stats.size === 0) throw new Error('La vidéo générée est vide.');

    console.log('====================================');
    console.log('VIDÉO CRÉÉE AVEC SUCCÈS !');
    console.log('Fichier : ' + OUTPUT_FILE);
    console.log('Taille : ' + (stats.size / (1024 * 1024)).toFixed(2) + ' MB');
    console.log('====================================');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error('ÉCHEC DU RENDU :');
  console.error(error);
  process.exit(1);
});
