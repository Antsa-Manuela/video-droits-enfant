
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const DURATION = 60;
const TOTAL_FRAMES = FPS * DURATION;

async function main() {
  fs.mkdirSync('output', { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage'
    ]
  });

  try {
    const page = await browser.newPage({
      viewport: {
        width: WIDTH,
        height: HEIGHT
      },
      deviceScaleFactor: 1
    });

    console.log('Chargement du projet...');

    await page.goto('http://127.0.0.1:8000/?record=1', {
      waitUntil: 'networkidle',
      timeout: 120000
    });

    await page.evaluate(async () => {
      await document.fonts.ready;

      await Promise.all(
        Array.from(document.images).map(img =>
          img.decode().catch(() => {})
        )
      );
    });

    await page.waitForFunction(() =>
      typeof render === 'function' &&
      typeof t !== 'undefined'
    );

    const stage = page.locator('#stage');

    const dimensions = await stage.evaluate(el => {
      const r = el.getBoundingClientRect();
      return {
        width: r.width,
        height: r.height
      };
    });

    if (
      Math.round(dimensions.width) !== WIDTH ||
      Math.round(dimensions.height) !== HEIGHT
    ) {
      throw new Error(
        'Dimensions incorrectes du stage : ' +
        JSON.stringify(dimensions)
      );
    }

    // Déclencher la musique avec une interaction réelle.
    await page.mouse.click(540, 960);
    await page.waitForTimeout(300);

    // Remise à zéro de la séquence.
    await page.evaluate(async () => {
      playing = true;
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

    await page.waitForTimeout(100);

    console.log('Démarrage du rendu Full HD...');

    const ffmpeg = spawn('ffmpeg', [
      '-y',

      '-f', 'image2pipe',
      '-framerate', String(FPS),
      '-vcodec', 'png',
      '-i', 'pipe:0',

      '-thread_queue_size', '512',
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

      '-shortest',
      '-movflags', '+faststart',

      'output/journee-droits-enfant.mp4'
    ], {
      stdio: ['pipe', 'inherit', 'inherit']
    });

    ffmpeg.stdin.on('error', err => {
      console.error('Erreur entrée FFmpeg:', err.message);
    });

    for (let i = 0; i < TOTAL_FRAMES; i++) {
      const frame = await stage.screenshot({
        type: 'png',
        animations: 'allow',
        caret: 'hide'
      });

      if (!ffmpeg.stdin.write(frame)) {
        await new Promise(resolve =>
          ffmpeg.stdin.once('drain', resolve)
        );
      }

      if (i % 300 === 0) {
        console.log(
          `Progression : ${Math.round(i / TOTAL_FRAMES * 100)}%`
        );
      }
    }

    ffmpeg.stdin.end();

    const exitCode = await new Promise((resolve, reject) => {
      ffmpeg.once('error', reject);
      ffmpeg.once('close', resolve);
    });

    if (exitCode !== 0) {
      throw new Error(`FFmpeg erreur : ${exitCode}`);
    }

    console.log('Vidéo Full HD créée !');

  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
