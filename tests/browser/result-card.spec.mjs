import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,ids} from '../helpers/database.mjs';
import {installClock,clock} from '../helpers/step3.mjs';
import {installService,login} from './service.mjs';
let db,team;
test.beforeAll(async()=>{await mkdir('.cache',{recursive:true});db=await createDatabase();await installClock(db);});test.afterAll(()=>db.close());
test.beforeEach(async()=>{team=await seedDatabase(db);await clock(db);await db.exec("update public.team_members set joined_at='2026-11-02T07:00:00+03:00'");});
async function task(done=false,patch={}){let r=await rpc(db,ids.manager,'mutate_task',[team,'create',null,{title:'Контрольная задача',assignee_id:ids.employee1,...patch},null,randomUUID()]);expect(r.ok).toBe(true);if(done)r=await rpc(db,ids.employee1,'mutate_task',[team,'status',r.data.entity.id,{status:'done'},r.data.entity.version,randomUUID()]);expect(r.ok).toBe(true);return r.data.entity;}
async function ready(page){const service=await installService(page,db);await login(page);await expect(page.locator('.daily-member')).toHaveCount(1);return service;}

test('task form explains result date; Nov 2–3 deadline tomorrow leaves today at 100 percent after saving and reload',async({page})=>{
 await task(true,{deadline:'2026-11-02'});await ready(page);await page.getByRole('button',{name:'＋ Добавить задачу',exact:true}).click();await page.locator('#task-title').fill('Результат нужен завтра');await page.locator('#task-plan_end').fill('2026-11-03');await page.locator('#task-deadline').fill('2026-11-03');await page.locator('#task-deadline').press('Tab');await expect(page.locator('.result-date-hint')).toContainText('3 ноября');await page.getByRole('button',{name:'Сохранить задачу',exact:true}).click();await expect(page.locator('.progress-day')).toContainText('100%');await expect(page.locator('.day-tasks')).toContainText('Результат нужен завтра');await page.reload();await expect(page.locator('.progress-day')).toContainText('1 из 1');
});

for(const [category,total,done,color,text] of [['complete',1,1,'rgb(182, 243, 109)','Все задачи выполнены!'],['progress',2,1,'rgb(255, 184, 212)','Отличный результат!'],['encouragement',1,0,'rgb(255, 208, 144)','Не вешай нос.'],['empty',0,0,'rgb(215, 190, 255)','Сегодня не было запланированных задач.']]){
 test(`large centered ${category} card has correct result, readable contrast and responsive layout`,async({page})=>{
  for(let i=0;i<total;i++)await task(i<done);await clock(db,'2026-11-02T18:00:00+03:00');await ready(page);const card=page.getByRole('dialog',{name:'Сотрудник 1',exact:true});await expect(card).toBeVisible();await expect(card).toContainText(text);await expect(card).toHaveCSS('background-color',color);await expect.poll(()=>page.evaluate(()=>document.getElementById('daily-support-dialog')?.matches(':modal')||false)).toBe(true);
  for(const width of [390,1440]){await page.setViewportSize({width,height:900});await expect(card).toHaveCSS('opacity','1');await expect(page.locator('.support-message')).toHaveCSS('font-size',width<600?'20px':'24px');const layout=await page.evaluate(()=>{const r=document.querySelector('#daily-support-dialog').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,top:r.top,w:innerWidth,h:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};});expect(layout.left).toBeGreaterThanOrEqual(0);expect(layout.right).toBeLessThanOrEqual(layout.w);expect(layout.top).toBeGreaterThanOrEqual(0);expect(layout.bottom).toBeLessThanOrEqual(layout.h);expect(layout.overflow).toBe(false);await page.screenshot({path:`.cache/step7-card-${category}-${width}.png`});}
  await expect.poll(()=>page.evaluate(()=>{const el=document.getElementById('daily-support-dialog');if(!el?.matches(':modal'))return 0;const rgb=v=>v.match(/[\d.]+/g)?.slice(0,3).map(Number);const light=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);const s=getComputedStyle(el),bg=rgb(s.backgroundColor),fg=rgb(s.color);if(!bg||!fg)return 0;const a=light(bg),b=light(fg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);})).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator('.support-close')).toBeFocused();await page.keyboard.press('Escape');await expect(card).toHaveCount(0);await expect(page.locator('#quick-title')).toBeFocused();await page.reload();await expect(page.locator('.daily-member-support')).toContainText(text);await expect(page.locator('.daily-support')).toHaveCount(0);
 });
}

test('confetti ends within three seconds despite refresh, stays closed after late updates and never traps a draft',async({page})=>{
 await task(true);await clock(db,'2026-11-02T18:00:00+03:00');const service=await ready(page);await expect(page.locator('.support-confetti i')).toHaveCount(28);await service.emitRealtime();await expect(page.locator('.support-confetti')).toHaveCount(0,{timeout:4500});await expect(page.locator('.daily-support')).toBeVisible();await page.getByRole('button',{name:'Закрыть сообщение поддержки',exact:true}).click();await page.locator('#quick-title').fill('Несохранённая мысль');await service.emitRealtime();await expect(page.locator('#quick-title')).toHaveValue('Несохранённая мысль');await expect(page.locator('.daily-support')).toHaveCount(0);
});
test('reduced motion disables confetti and entrance animation',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await task(true);await clock(db,'2026-11-02T18:00:00+03:00');await ready(page);await expect(page.locator('.daily-support')).toHaveCSS('animation-name','none');await expect(page.locator('.support-confetti')).toHaveCount(0);
});
test('early work is visible separately in progress, chart, support and report drilldown',async({page})=>{
 await task(true,{deadline:'2026-11-03',plan_end:'2026-11-03'});await clock(db,'2026-11-02T18:00:00+03:00');await ready(page);await expect(page.locator('.support-early')).toHaveText('Сделано заранее: 1');await expect(page.locator('.support-percent')).toHaveText('✦');await page.keyboard.press('Escape');await expect(page.locator('.progress-day .early-result')).toHaveText('Сделано заранее: 1');await expect(page.locator('.daily-day').first()).toContainText('+1 заранее');await page.getByRole('button',{name:'Итоги',exact:true}).click();await expect(page.locator('[data-metric="early_done_count"]')).toBeVisible();await page.locator('[data-metric="early_done_count"]').click();await expect(page.locator('.report-fact')).toHaveCount(1);
});
