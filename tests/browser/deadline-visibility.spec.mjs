import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {createDatabase,seedDatabase,rpc,ids} from '../helpers/database.mjs';
import {installClock,clock} from '../helpers/step3.mjs';
import {installService,login} from './service.mjs';
let db,team;
const cards=page=>page.locator('.day-tasks .task-card');
async function choose(page,date){const picker=page.getByLabel('Выбрать дату',{exact:true});await picker.fill(date);await picker.press('Tab');await expect(page.locator('.day-panel')).toHaveAttribute('data-drop-date',date);await expect(picker).toBeEnabled();}
async function ready(page,user='employee1'){const service=await installService(page,db);await login(page,user);await expect(page.locator('#quick-title')).toBeVisible();await expect(page.locator('.daily-member')).toHaveCount(user==='manager'?3:1);const support=page.getByRole('button',{name:'Закрыть сообщение поддержки',exact:true});if((await db.query('select private.today()::text as today')).rows[0].today>'2026-11-05'){await expect(support).toBeVisible();await support.click();}return service;}
async function create(payload={}){const r=await rpc(db,ids.manager,'mutate_task',[team,'create',null,{title:'Задача до субботы',assignee_id:ids.employee1,deadline:'2026-11-07',...payload},null,randomUUID()]);expect(r.ok,JSON.stringify(r)).toBe(true);return r.data.entity;}
test.beforeAll(async()=>{await mkdir('.cache',{recursive:true});db=await createDatabase();await installClock(db);});
test.beforeEach(async()=>{team=await seedDatabase(db);await clock(db,'2026-11-05T10:00:00+03:00');await db.exec('update public.team_members set joined_at=private.task_now()');});
test.afterAll(()=>db.close());
test('deadline form projects the same task into Thursday Friday and Saturday, retaining text and synchronized calendar counts',async({page})=>{
 await ready(page);await page.getByRole('button',{name:'＋ Добавить задачу',exact:true}).click();await page.getByLabel('Название',{exact:true}).fill('Задача до субботы');
 await expect(page.locator('.task-visibility-hint')).toContainText('Без срока сдачи');await page.getByLabel('Срок сдачи',{exact:true}).fill('2026-11-07');await page.getByLabel('Срок сдачи',{exact:true}).press('Tab');
 await expect(page.locator('.task-visibility-hint')).toContainText('каждый календарный день');await expect(page.getByLabel('Название',{exact:true})).toHaveValue('Задача до субботы');
 await page.getByRole('button',{name:'Сохранить задачу',exact:true}).click();await expect(cards(page)).toHaveCount(1);const id=await cards(page).getAttribute('data-task-id');
 for(const date of ['2026-11-06','2026-11-07']){await choose(page,date);await expect(cards(page)).toHaveCount(1);await expect(cards(page)).toHaveAttribute('data-task-id',id);await expect(page.locator('.month-day[data-date="'+date+'"]').first()).toContainText('1 задач');}
 await expect(page.locator('.week-list')).toContainText('Задача до субботы');expect((await db.query('select count(*)::int n from public.tasks')).rows[0].n).toBe(1);
 await page.screenshot({path:'.cache/step10-'+(process.env.RITM_BROWSER_ENGINE||'chromium')+'-saturday.png',fullPage:true});
});
test('early completion removes the future card in both roles through realtime and retains the deadline result and history',async({page,browser})=>{
 const t=await create();await clock(db,'2026-11-06T10:00:00+03:00');const service=await ready(page);
 const context=await browser.newContext({baseURL:new URL(page.url()).origin}),manager=await context.newPage();
 try{
  await ready(manager,'manager');await choose(manager,'2026-11-07');await expect(cards(manager)).toHaveAttribute('data-task-id',t.id);
  await page.getByRole('button',{name:'Завершить: Задача до субботы',exact:true}).click();await service.emitRealtime();await expect(cards(manager)).toHaveCount(0);
  await expect(manager.locator('.progress-day')).toContainText('100%');await expect(manager.locator('.day-tasks')).toContainText('Выполненные ранее задачи сохранены в итогах');
  await expect(page.locator('.terminal-group')).toContainText('Выполнено');await choose(page,'2026-11-07');await expect(cards(page)).toHaveCount(0);
  await choose(page,'2026-11-05');await expect(cards(page)).toContainText('История дня');await expect(cards(page)).toContainText('В плане');
 }finally{await context.close();}
});
test('overdue deadline stays visible on Saturday and Sunday and keeps the original deadline',async({page})=>{
 const t=await create({deadline:'2026-11-06'});await clock(db,'2026-11-07T10:00:00+03:00');await ready(page);await expect(cards(page)).toHaveAttribute('data-task-id',t.id);await expect(cards(page)).toContainText('Просрочено');
 await clock(db,'2026-11-08T10:00:00+03:00');await page.getByRole('button',{name:'Обновить',exact:true}).click();await choose(page,'2026-11-08');await expect(cards(page)).toHaveAttribute('data-task-id',t.id);
 await expect(cards(page)).toContainText('Срок · 6 ноября');await expect(cards(page)).toContainText('Просрочено');await choose(page,'2026-11-09');await expect(cards(page)).toHaveCount(0);
});
test('Saturday deadline is usable on a phone without horizontal overflow',async({page})=>{
 await page.setViewportSize({width:390,height:844});await create();await ready(page);await choose(page,'2026-11-07');await expect(cards(page)).toContainText('Задача до субботы');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await cards(page).getByRole('button',{name:'Задача до субботы',exact:true}).click();await expect(page.locator('#task-dialog')).toContainText('7 ноября');
});
