import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const chrome=process.env.RITM_BROWSER_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined);
const engine=process.env.RITM_BROWSER_ENGINE||'chromium';
if(!['chromium','firefox','webkit'].includes(engine))throw new Error('RITM_BROWSER_ENGINE должен быть chromium, firefox или webkit.');
export default defineConfig({
  testDir:'tests/browser', fullyParallel:false, workers:1, timeout:30000,
  expect:{timeout:7000}, reporter:'list',
  use:{baseURL:'http://127.0.0.1:3000',headless:true,locale:'ru-RU',timezoneId:'Europe/Moscow',browserName:engine,
    launchOptions:engine==='chromium'&&chrome&&existsSync(chrome)?{executablePath:chrome}:{},screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'node scripts/serve.mjs',url:'http://127.0.0.1:3000',reuseExistingServer:true,timeout:15000}
});
