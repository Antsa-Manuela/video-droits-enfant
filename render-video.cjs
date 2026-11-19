
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const DURATION = 60;
const TOTAL_FRAMES = FPS * DURATION;
const PORT = 8000;

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, 'output');
const OUTPUT_FILE = path.join(
  OUTPUT_DIR,
  'journee-droits-enfant.mp4'
);

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

        const relative = pathname === '/'
          ? 'index.html'
          : pathname.replace(/^\/+/, '');

        const file = path.resolve(ROOT, relative);

        if (
          file !== ROOT &&
          !file.startsWith(ROOT + path.sep)
        ) {
          res.writeHead(403);
          return res.end('Forbidden');
        }

        fs.readFile(file, (error, data) => {
          if (error) {
            res.writeHead(404);
            return res.end('File not found: ' + relative);
          }

          const type = MIME_TYPES[path.extname(file).toLowerCase()]
            || 'application/octet-stream';

          res.writeHead(200, {
            'Content-Type': type,
            'Cache-Control': 'no-cache'
          });

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

function waitForProcess(proc) {
  return new Promise((resolve, reject) => {
    proc.once('error', reject);

    proc.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error('FFmpeg terminé avec le code ' + code));
    });
  });
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    throw new Error('index.html est introuvable à la racine du projet.');
  }

  if (!fs.existsSync(path.join(ROOT, 'Audio.mp3'))) {
    throw new Error('Audio.mp3 est introuvable.');
  }

  console.log('====================================');
  console.log('GÉNÉRATION VIDÉO FULL HD');
  console.log('1080 x 1920 | 30 FPS | 60 secondes');
  console.log('====================================');

  const server = await startServer();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required'
      ]
    });

    const page = await browser.newPage({
      viewport: {
        width: WIDTH,
        height: HEIGHT
      },
      deviceScaleFactor: 1
    });

    page.on('pageerror', error => {
      console.error('Erreur JavaScript :', error.message);
    });

    console.log('Chargement du projet HTML...');

    // Ne pas attendre networkidle : cela provoquait le timeout.
    await page.goto(
      `http://127.0.0.1:${PORT}/?record=1`,
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }
    );

    console.log('Attente des scènes et des images...');

    await page.waitForFunction(() => {
      return (
        typeof render === 'function' &&
        typeof t !== 'undefined' &&
        document.querySelectorAll('#stage .scene').length === 8
      );
    }, { timeout: 30000 });

    await page.evaluate(async () => {
      await document.fonts.ready;

      await Promise.all(
        Array.from(document.images).map(img =>
          img.decode().catch(() => {})
        )
      );
    });

    const dimensions = await page.locator('#stage').evaluate(el => {
      const r = el.getBoundingClientRect();

      return {
        width: Math.round(r.width),
        height: Math.round(r.height)
      };
    });

    console.log('Dimensions du stage :', dimensions);

    if (
      dimensions.width !== WIDTH ||
      dimensions.height !== HEIGHT
    ) {
      throw new Error(
        'Dimensions incorrectes : ' +
        JSON.stringify(dimensions)
      );
    }

    // Démarrage de la musique après une interaction.
    console.log('Initialisation de la musique...');

    await page.mouse.click(540, 960);

    await page.evaluate(async () => {
      playing = false;
      t = 0;
      cur = -1;
      last = performance.now();
      isLoopReset = true;

      if (bgAudio) {
        bgAudio.currentTime = 0;
        bgAudio.volume = 0;

        await bgAudio.play();
        audioReady = true;
      }

      render();
    });

    await page.waitForTimeout(300);

    // Vérification du périphérique audio virtuel.
    const pulse = spawn('pactl', [
      'list',
      'short',
      'sources'
    ]);

    let pulseOutput = '';

    pulse.stdout.on('data', data => {
      pulseOutput += data.toString();
    });

    await waitForProcess(pulse);

    if (!pulseOutput.includes('virtual_speaker.monitor')) {
      throw new Error(
        'Source audio virtual_speaker.monitor introuvable. ' +
        'Vérifie la configuration PulseAudio du workflow.'
      );
    }

    console.log('Périphérique audio détecté.');

    // Lancement de FFmpeg.
    const ffmpeg = spawn('ffmpeg', [
      '-y',

      '-f', 'image2pipe',
      '-framerate', String(FPS),
      '-vcodec', 'mjpeg',
      '-i', 'pipe:0',

      '-thread_queue_size', '1024',
      '-f', 'pulse',
      '-i', 'virtual_speaker.monitor',

      '-map', '0:v:0',
      '-map', '1:a:0',

      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-r', String(FPS),

      '-c:a', 'aac',
      '-b:a', '192k',

      '-t', String(DURATION),
      '-shortest',
      '-movflags', '+faststart',

      OUTPUT_FILE
    ], {
      stdio: ['pipe', 'inherit', 'inherit']
    });

    ffmpeg.stdin.on('error', error => {
      if (error.code !== 'EPIPE') {
        console.error('Erreur FFmpeg stdin :', error.message);
      }
    });

    const ffmpegDone = waitForProcess(ffmpeg);

    console.log('Début du rendu Full HD...');

    const interval = 1000 / FPS;
    const startTime = Date.now();

    for (let i = 0; i < TOTAL_FRAMES; i++) {
      // Pilotage précis du temps de la vidéo.
      await page.evaluate(frame => {
        t = frame / 30;
        render();
        music();
      }, i);

      const frame = await page.locator('#stage').screenshot({
        type: 'jpeg',
        quality: 95,
        animations: 'allow',
        caret: 'hide'
      });

      if (!ffmpeg.stdin.write(frame)) {
        await new Promise(resolve => {
          ffmpeg.stdin.once('drain', resolve);
        });
      }

      // Respect des 30 images par seconde.
      const targetTime = startTime + (i + 1) * interval;
      const remaining = targetTime - Date.now();

      if (remaining > 0) {
        await new Promise(resolve =>
          setTimeout(resolve, remaining)
        );
      }

      if ((i + 1) % 150 === 0) {
        const percent = Math.round(
          ((i + 1) / TOTAL_FRAMES) * 100
        );

        console.log(
          `Progression : ${percent}% (${i + 1}/${TOTAL_FRAMES})`
        );
      }
    }

    console.log('Toutes les images ont été envoyées.');

    ffmpeg.stdin.end();

    await ffmpegDone;

    if (!fs.existsSync(OUTPUT_FILE)) {
      throw new Error('La vidéo finale est introuvable.');
    }

    const stats = fs.statSync(OUTPUT_FILE);

    if (stats.size === 0) {
      throw new Error('La vidéo générée est vide.');
    }

    console.log('====================================');
    console.log('VIDÉO CRÉÉE AVEC SUCCÈS !');
    console.log('Fichier : ' + OUTPUT_FILE);
    console.log(
      'Taille : ' +
      (stats.size / (1024 * 1024)).toFixed(2) +
      ' MB'
    );
    console.log('====================================');

  } finally {
    if (browser) {
      await browser.close();
    }

    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error('ÉCHEC DU RENDU :');
  console.error(error);
  process.exit(1);
});
