import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,ids} from '../helpers/database.mjs';
import {installClock,clock} from '../helpers/step3.mjs';
import {installService,login} from './service.mjs';
let db,team;
test.beforeAll(async()=>{await mkdir('.cache',{recursive:true});db=await createDatabase();await installClock(db);});test.afterAll(async()=>db.close());
test.beforeEach(async()=>{team=await seedDatabase(db);await clock(db);await db.exec("update public.team_members set joined_at='2026-11-02T07:00:00+03:00'");});
async function ready(page,user='employee1'){const service=await installService(page,db);await login(page,user);await expect(page.locator('.daily-member')).toHaveCount(user==='manager'?3:1);return service;}
async function task(){const r=await rpc(db,ids.manager,'mutate_task',[team,'create',null,{title:'План для поддержки',assignee_id:ids.employee1},null,randomUUID()]);expect(r.ok).toBe(true);return r.data.entity;}

test('personal charts show seven days, self to employee, all members and employee result to manager',async({page,browser})=>{
 await task();await clock(db,'2026-11-02T18:00:00+03:00');await ready(page);await expect(page.locator('.daily-day')).toHaveCount(7);await expect(page.locator('.daily-member')).toContainText('Сотрудник 1');await expect(page.locator('.daily-support')).toContainText('Не вешай нос.');
 const context=await browser.newContext();try{const second=await context.newPage();await ready(second,'manager');const employee=second.locator(`[data-progress-user="${ids.employee1}"]`);await expect(employee).toContainText('Не вешай нос.');await expect(second.locator('.daily-support')).toContainText('Сегодня не было запланированных задач.');expect((await db.query("select count(*)::int n from public.notifications where type='daily_support' and payload->>'subject_id'=$1 and recipient_id::text in($1,$2)",[ids.employee1,ids.manager])).rows[0].n).toBe(2);}finally{await context.close();}
});
test('before 17:45 no banner, at cutoff one banner, late completion updates text and reload never repeats it',async({page})=>{
 await task();await clock(db,'2026-11-02T17:44:59+03:00');await ready(page);await expect(page.locator('.daily-support')).toHaveCount(0);await clock(db,'2026-11-02T17:45:00+03:00');await page.getByRole('button',{name:'Обновить динамику',exact:true}).click();await expect(page.locator('.daily-support')).toContainText('Не вешай нос.');
 await clock(db,'2026-11-02T18:30:00+03:00');await page.getByRole('button',{name:'Завершить: План для поддержки',exact:true}).click();await expect(page.locator('.daily-support')).toContainText('Все задачи выполнены!');await page.getByRole('button',{name:'Закрыть сообщение поддержки',exact:true}).click();await expect(page.locator('.daily-support')).toHaveCount(0);await page.getByRole('button',{name:'Обновить динамику',exact:true}).click();await expect(page.locator('.daily-member-support')).toContainText('Все задачи выполнены!');await page.reload();await expect(page.locator('.daily-member-support')).toContainText('Все задачи выполнены!');await expect(page.locator('.daily-support')).toHaveCount(0);
});
test('same user in independent sessions gets at most one confirmed popup and a persistent message in both cards',async({page,browser})=>{
 await clock(db,'2026-11-02T18:00:00+03:00');await ready(page);await expect(page.locator('.daily-support')).toBeVisible();const context=await browser.newContext();try{const second=await context.newPage();await ready(second);await expect(second.locator('.daily-support')).toHaveCount(0);await expect(second.locator('.daily-member-support')).toContainText('из маленьких дел складывается большой успех!');}finally{await context.close();}
});
test('an open task dialog never consumes the unseen banner',async({page})=>{
 await clock(db,'2026-11-02T17:44:59+03:00');await ready(page);await page.getByRole('button',{name:'＋ Добавить задачу',exact:true}).click();await expect(page.locator('#task-dialog')).toBeVisible();await clock(db,'2026-11-02T18:00:00+03:00');const r=await rpc(db,ids.employee1,'get_weekly_progress',[team]);expect(r.ok).toBe(true);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.getByRole('button',{name:'Закрыть задачу',exact:true}).click();await page.getByRole('button',{name:'Обновить динамику',exact:true}).click();await expect(page.locator('.daily-support')).toBeVisible();
});
test('weekly service failure leaves the core planner usable and a manual retry restores real server data',async({page})=>{
 const service=await installService(page,db);service.failedWeekly=true;await login(page);await expect(page.locator('#quick-title')).toBeVisible();await expect(page.locator('.daily-progress')).toContainText('Динамика временно недоступна.');await page.locator('#quick-title').fill('Задача при недоступной динамике');await page.locator('#quick-title').press('Enter');await expect(page.locator('.day-tasks')).toContainText('Задача при недоступной динамике');service.failedWeekly=false;await page.getByRole('button',{name:'Обновить динамику',exact:true}).click();await expect(page.locator('.daily-member')).toHaveCount(1);expect(service.rpcRequests.filter(x=>x.name==='get_weekly_progress').length).toBeLessThan(6);
});
test('simulated hidden document preserves unread support until returning to the visible planner',async({page})=>{
 await page.addInitScript(()=>{window.supportTestHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.supportTestHidden});});
 await clock(db,'2026-11-02T18:00:00+03:00');const service=await ready(page);
 await expect(page.locator('.daily-support')).toHaveCount(0);expect(service.rpcRequests.filter(r=>r.name==='claim_daily_support')).toHaveLength(0);
 expect((await db.query("select read_at from public.notifications where recipient_id=$1 and type='daily_support' and payload->>'subject_id'=$1::text",[ids.employee1])).rows[0].read_at).toBeNull();
 await page.evaluate(()=>{window.supportTestHidden=false;document.dispatchEvent(new Event('visibilitychange'));});await expect(page.locator('.daily-support')).toBeVisible();
 expect(service.rpcRequests.filter(r=>r.name==='claim_daily_support')).toHaveLength(1);
});
test('member names remain literal text in chart, banner and notification labels',async({page})=>{
 const name='<img src=x onerror="window.supportXss=1">';await db.query('update public.team_members set display_name=$1 where user_id=$2',[name,ids.employee1]);await clock(db,'2026-11-02T18:00:00+03:00');await ready(page);await expect(page.locator('.daily-member')).toContainText(name);await expect(page.locator('.daily-support')).toContainText(name);await page.getByRole('button',{name:/Уведомления:/}).click();await expect(page.locator('.notification-list')).toContainText(name);await expect(page.locator('.daily-progress img,.daily-support img,.notification-list img')).toHaveCount(0);expect(await page.evaluate(()=>window.supportXss)).toBeUndefined();
});
test('weekly charts and long empty-plan support fit phone, tablet and desktop without page overflow',async({page})=>{
 await clock(db,'2026-11-02T18:00:00+03:00');await ready(page,'manager');await expect(page.locator('.daily-support')).toBeVisible();for(const width of [360,390,768,1440]){await page.setViewportSize({width,height:900});const overflow=await page.evaluate(()=>({viewport:innerWidth,scrollX:scrollX,width:document.documentElement.scrollWidth,items:[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1||el.scrollWidth>el.clientWidth+2).map(el=>({tag:el.tagName,css:el.className,right:el.getBoundingClientRect().right,left:el.getBoundingClientRect().left,width:el.clientWidth,scrollWidth:el.scrollWidth})).slice(0,12)}));if(overflow.width>overflow.viewport+1)await page.screenshot({path:'.cache/step6-overflow.png',fullPage:true});expect(overflow.width<=overflow.viewport+1,JSON.stringify(overflow)).toBe(true);await expect(page.getByRole('button',{name:'Закрыть сообщение поддержки',exact:true})).toBeVisible();await page.screenshot({path:`.cache/step6-${width}.png`,fullPage:true});}
});
