/** npm run car:contacts -- [--browser] [--broken] */
import { runContactStand } from './car-contact-stand.ts';

async function inBrowser(broken) {
  const { chromium } = await import('playwright');
  const { createServer } = await import('vite');
  const route = '/__car_contacts';
  const server = await createServer({
    configFile: false,
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: ['jolt-physics'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [{
      name: 'car-contact-stand',
      configureServer({ middlewares }) {
        middlewares.use(route, (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end('<!doctype html><title>Стенд контактов Viper</title>');
        });
      },
    }],
  });
  try {
    await server.listen();
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}${route}`);
      const report = await page.evaluate(async broken => {
        const { runContactStand } = await import('/tools/car-contact-stand.ts');
        return runContactStand(broken);
      }, broken);
      return { ...report, passed: report.passed && errors.length === 0, chromium: browser.version(), pageErrors: errors };
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

const broken = process.argv.includes('--broken');
const report = process.argv.includes('--browser') ? await inBrowser(broken) : await runContactStand(broken);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
