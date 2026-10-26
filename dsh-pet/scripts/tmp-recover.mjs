/** 临时诊断（用完即删）：关闭 idleOnly 后点击是否恢复播放 */
import { _electron as electron } from 'playwright';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const root = resolve(process.cwd());
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: join(homedir(), '.dsh', 'electron', 'electron.exe'),
  args: [join(root, 'lib', 'app.js')],
  cwd: root,
  env,
});
try {
  const pet = await app.firstWindow();
  await pet.waitForLoadState('domcontentloaded');
  await pet.waitForTimeout(3500);
  const videoOf = () =>
    pet.evaluate(() => {
      const v = document.querySelector('.pet-video.is-front');
      return v && v.src ? decodeURIComponent(v.src.split('/').pop()) : null;
    });
  const before = await videoOf();
  const flag = await pet.evaluate(() => (typeof config !== 'undefined' ? config.idleOnly : '(no config)'));
  await pet.evaluate(() => {
    const hit = document.querySelector('.pet-hit');
    for (let i = 0; i < 5; i += 1) {
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
    }
  });
  await pet.waitForTimeout(1200);
  const after = await videoOf();
  const bubble = await pet.evaluate(() => document.querySelector('.pet-bubble')?.textContent?.trim() ?? null);
  console.log(JSON.stringify({ flag, before, after, changed: before !== after, bubble }, null, 2));
} finally {
  await app.close();
}
