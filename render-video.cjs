
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');

const DURATION = 60;
const WIDTH = 1080;
const HEIGHT = 1920;

async function main() {
  fs.mkdirSync('output', { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage'
    ]
  });

  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1
    });

    console.log('Ouverture de l’animation...');

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

    await page.addStyleTag({
      content: '#rec-ui { display: none !important; }'
    });

    await page.waitForTimeout(1000);

    // Remise à zéro de l'animation
    await page.evaluate(() => {
      t = 0;
      cur = -1;
      stepP = -1;
      stepO = -1;
      last = performance.now();
      isLoopReset = true;
    });

    console.log('Préparation de la capture vidéo...');

    const display = process.env.DISPLAY || ':99';

    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 'x11grab',
      '-framerate', '30',
      '-video_size', `${WIDTH}x${HEIGHT}`,
      '-i', `${display}+0,0`,
      '-f', 'pulse',
      '-i', 'virtual_speaker.monitor',
      '-t', String(DURATION),
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      'output/journee-droits-enfant.mp4'
    ], { stdio: 'inherit' });

    // Déclenche l'initialisation audio par un clic réel
    await page.waitForTimeout(500);
    await page.mouse.click(540, 960);

    console.log('Enregistrement en cours : 60 secondes...');

    const exitCode = await new Promise((resolve, reject) => {
      ffmpeg.on('error', reject);
      ffmpeg.on('close', resolve);
    });

    if (exitCode !== 0) {
      throw new Error(`FFmpeg a échoué : code ${exitCode}`);
    }

    console.log('Vidéo générée avec succès !');
    console.log('Fichier : output/journee-droits-enfant.mp4');

  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

