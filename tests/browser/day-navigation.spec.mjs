import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,ids} from '../helpers/database.mjs';
import {installClock,clock} from '../helpers/step3.mjs';
import {installService,login} from './service.mjs';

let db,team;
const picker=page=>page.getByLabel('Выбрать дату',{exact:true});
const previous=page=>page.getByRole('button',{name:'Предыдущий рабочий день',exact:true});
const next=page=>page.getByRole('button',{name:'Следующий рабочий день',exact:true});
async function setDay(date){await clock(db,date+'T09:00:00+03:00');await db.exec('update public.team_members set joined_at=private.task_now()');}
async function task(title,date){const r=await rpc(db,ids.manager,'mutate_task',[team,'create',null,{title,plan_start:date,deadline:date,assignee_id:ids.employee1,direction:'sto'},null,randomUUID()]);expect(r.ok,JSON.stringify(r)).toBe(true);}
async function ready(page){const service=await installService(page,db);await login(page);await expect(picker(page)).toBeVisible();await expect(page.locator('.daily-member')).toHaveCount(1);return service;}
async function selected(page,date){await expect(page.locator('.day-panel')).toHaveAttribute('data-drop-date',date);await expect(picker(page)).toHaveValue(date);await expect(picker(page)).toBeEnabled();await expect(page.locator('.month-day.selected')).toHaveAttribute('data-date',date);}
async function choose(page,date){await picker(page).fill(date);await picker(page).press('Tab');await selected(page,date);}

test.beforeAll(async()=>{await mkdir('.cache',{recursive:true});db=await createDatabase();await installClock(db);});
test.beforeEach(async()=>{team=await seedDatabase(db);await setDay('2026-11-03');});
test.afterAll(()=>db.close());

test('date picker synchronizes day week month and progress while preserving filters and quick draft',async({page})=>{
 await task('Данные за сегодня','2026-11-03');await task('Данные следующей недели','2026-11-12');await task('Данные декабря','2026-12-05');
 const before=(await db.query('select jsonb_agg(t order by id) as state from public.tasks t')).rows[0].state;
 await ready(page);await selected(page,'2026-11-03');await expect(page.getByRole('button',{name:'Сегодня',exact:true})).toHaveCount(0);
 await page.locator('#planner-direction').selectOption('sto');await expect(page.locator('.day-tasks')).toContainText('Данные за сегодня');
 await page.getByLabel('Название быстрой задачи').fill('Не потерять черновик');
 for(const [date,title,week] of [['2026-11-12','Данные следующей недели','9 ноября — 15 ноября'],['2026-12-05','Данные декабря','30 ноября — 6 декабря']]){
  await choose(page,date);await expect(page.locator('.day-tasks')).toContainText(title);await expect(page.locator('.week-range')).toHaveText(week);await expect(page.locator('.week-day.selected')).toHaveAttribute('data-drop-date',date);
  await expect(page.locator('#planner-direction')).toHaveValue('sto');await expect(page.getByLabel('Название быстрой задачи')).toHaveValue('Не потерять черновик');
  const r=await rpc(db,ids.employee1,'get_planner',[team,date,{employee_id:ids.employee1,direction:'sto',statuses:['planned','in_progress','waiting'],priorities:[],deadline_filter:'all',query:'',group_by:'list'},null]);expect(r.ok).toBe(true);
  for(const [period,metric] of Object.entries(r.data.progress))await expect(page.locator(`.progress-${period} strong`)).toHaveText(metric.progress_percent===null?'—':new Intl.NumberFormat('ru-RU').format(metric.progress_percent)+'%');
 }
 expect((await db.query('select jsonb_agg(t order by id) as state from public.tasks t')).rows[0].state).toEqual(before);
});

test('five working day arrows stop at boundaries and skip Friday to Monday',async({page})=>{
 await ready(page);await expect(previous(page)).toBeDisabled();await expect(next(page)).toBeEnabled();await expect(page.locator('#quick-days-hint')).toContainText('3 ноября — 9 ноября');await expect(page.locator('#quick-days-hint')).toContainText('Если дата вне быстрого диапазона — выберите дату вверху.');
 for(const date of ['2026-11-04','2026-11-05','2026-11-06','2026-11-09']){await next(page).click();await selected(page,date);}
 await expect(next(page)).toBeDisabled();await expect(page.locator('.week-range')).toHaveText('9 ноября — 15 ноября');await expect(picker(page)).toBeFocused();
 for(const date of ['2026-11-06','2026-11-05','2026-11-04','2026-11-03']){await previous(page).click();await selected(page,date);}
 await expect(previous(page)).toBeDisabled();await expect(picker(page)).toBeFocused();
 for(const date of ['2026-11-07','2026-11-10','2026-11-02']){await choose(page,date);await expect(previous(page)).toBeDisabled();await expect(next(page)).toBeDisabled();await expect(page.locator('#quick-days-hint')).toContainText('вне быстрого диапазона');}
});

for(const today of ['2026-11-07','2026-11-08'])test(`weekend ${today} starts quick window on Monday without hiding weekend plan`,async({page})=>{
 await setDay(today);await ready(page);await selected(page,today);await expect(previous(page)).toBeDisabled();await expect(next(page)).toBeDisabled();await expect(page.locator('#quick-days-hint')).toContainText('9 ноября — 13 ноября');
 await choose(page,'2026-11-09');await expect(previous(page)).toBeDisabled();await next(page).click();await selected(page,'2026-11-10');
});

test('working day navigation crosses month and year using weekdays without a holiday calendar',async({page})=>{
 await setDay('2026-12-31');await ready(page);await next(page).click();await selected(page,'2027-01-01');await expect(page.locator('.period-nav h2')).toContainText('январь 2027');
 await next(page).click();await selected(page,'2027-01-04');await expect(page.locator('.week-range')).toHaveText('4 января — 10 января');
 await choose(page,'2000-02-29');await expect(page.locator('#day-heading')).toHaveText('29 февраля');await expect(next(page)).toBeDisabled();
});

test('date loading locks navigation and network failure retains previous plan filters and quick draft',async({page})=>{
 await task('Не подменять план','2026-11-03');const service=await ready(page);await page.getByLabel('Название быстрой задачи').fill('Черновик перехода');
 let release;service.plannerGate=new Promise(resolve=>release=resolve);
 await picker(page).fill('2026-11-04');await picker(page).press('Tab');await expect(picker(page)).toBeDisabled();await expect(next(page)).toBeDisabled();await expect(previous(page)).toBeDisabled();
 await expect(page.locator('.day-panel')).toHaveAttribute('data-drop-date','2026-11-03');await expect(page.locator('.day-tasks')).toContainText('Не подменять план');await expect(page.locator('#quick-days-hint')).toHaveText('Загружаем выбранный день…');
 await expect(page.getByRole('button',{name:'Добавить быструю задачу',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'＋ Добавить задачу',exact:true})).toBeDisabled();await page.getByLabel('Название быстрой задачи').press('Enter');expect(service.taskRequests).toHaveLength(0);
 service.plannerGate=null;release();await selected(page,'2026-11-04');
 service.failedPlanner=true;await picker(page).fill('2026-11-05');await picker(page).press('Tab');await expect(page.locator('.notice-error')).toBeVisible();await selected(page,'2026-11-04');await expect(page.getByLabel('Название быстрой задачи')).toHaveValue('Черновик перехода');
 service.failedPlanner=false;await next(page).click();await selected(page,'2026-11-05');
});

test('foreground day selection supersedes a background refresh and ignores its stale response',async({page})=>{
 const service=await ready(page),before=service.rpcRequests.filter(r=>r.name==='get_planner').length;let release;service.plannerGate=new Promise(resolve=>release=resolve);
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect.poll(()=>service.rpcRequests.filter(r=>r.name==='get_planner').length).toBeGreaterThan(before);
 await next(page).click();await expect.poll(()=>service.rpcRequests.some(r=>r.name==='get_planner'&&r.body.p_selected_date==='2026-11-04')).toBe(true);
 service.plannerGate=null;release();await selected(page,'2026-11-04');
});

test('empty and out of range dates never load a different plan and keyboard/mobile navigation remains usable',async({page})=>{
 const service=await ready(page);const calls=()=>service.rpcRequests.filter(r=>r.name==='get_planner');
 for(const date of ['','1999-12-31','2101-01-01']){const before=calls().length;await picker(page).fill(date);await picker(page).press('Tab');await expect(page.locator('#planner-date-error')).toContainText('Выберите корректную дату');expect(calls().slice(before).every(r=>r.body.p_selected_date==='2026-11-03')).toBe(true);await expect(page.locator('.day-panel')).toHaveAttribute('data-drop-date','2026-11-03');}
 await choose(page,'2026-11-03');await expect(page.locator('#planner-date-error')).toBeEmpty();
 for(const width of [360,390,768,1440]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(picker(page)).toBeVisible();await expect(next(page)).toBeVisible();}
 await next(page).focus();await page.keyboard.press('Enter');await selected(page,'2026-11-04');await expect(next(page)).toBeFocused();
 await page.setViewportSize({width:1440,height:1100});await page.screenshot({path:'.cache/step9-desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.cache/step9-mobile-date.png'});await page.locator('.day-panel').screenshot({path:'.cache/step9-mobile-day.png'});
 await page.reload();await selected(page,'2026-11-03');
});

test('Moscow date rollover refreshes five day window without moving a separately selected day',async({page})=>{
 await ready(page);await choose(page,'2026-11-06');await clock(db,'2026-11-04T00:01:00+03:00');await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await expect(page.locator('#quick-days-hint')).toContainText('4 ноября — 10 ноября');await expect(page.getByRole('button',{name:'Закрыть сообщение поддержки',exact:true})).toBeVisible();await page.getByRole('button',{name:'Закрыть сообщение поддержки',exact:true}).click();
 await selected(page,'2026-11-06');await next(page).click();await selected(page,'2026-11-09');
});
