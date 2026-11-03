import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,ids} from '../helpers/database.mjs';
import {installService,login} from './service.mjs';
let db,team;
const cards=page=>page.locator('.day-tasks .task-card');
async function ready(page,user='employee1') {await login(page,user);await expect(page.locator('#quick-title')).toBeVisible();}
async function quick(page,title) {await page.getByLabel('Название быстрой задачи').fill(title);await page.getByRole('button',{name:'Добавить быструю задачу',exact:true}).click();await expect(cards(page).getByRole('button',{name:title,exact:true})).toBeVisible();}
async function create(payload={},user='employee1') {const r=await rpc(db,ids[user],'mutate_task',[team,'create',null,{title:'Тестовая задача',...payload},null,randomUUID()]);expect(r.ok,JSON.stringify(r)).toBe(true);return r.data.entity;}
test.beforeAll(async()=>{db=await createDatabase();await db.exec(`create or replace function private.task_now() returns timestamptz language sql stable set search_path='' as $$select coalesce(nullif(current_setting('ritm.test_now',true),'')::timestamptz,now())$$;`);});
test.beforeEach(async()=>{team=await seedDatabase(db);await db.query(`select set_config('ritm.test_now','2026-11-02T09:00:00+03:00',false)`);});
test.afterAll(async()=>{await db.close();});
test('quick add stores a single real task, updates progress and survives browser reload',async({page})=>{
 await installService(page,db);await ready(page);await page.getByLabel('Название быстрой задачи').fill('Подготовить отчёт');await page.getByLabel('Название быстрой задачи').press('Enter');await expect(cards(page)).toContainText('Подготовить отчёт');
 expect((await db.query('select title,status from public.tasks')).rows).toEqual([{title:'Подготовить отчёт',status:'planned'}]);
 await expect(page.locator('.progress-card').first()).toContainText('0 из 1');
 await page.reload();await expect(cards(page).getByRole('button',{name:'Подготовить отчёт',exact:true})).toBeVisible();
});
test('full form creates task with direction/priority/deadline/description and preserves quick draft',async({page})=>{
 await installService(page,db);await ready(page);await page.getByLabel('Название быстрой задачи').fill('Бюджет');await page.getByRole('button',{name:'＋ Добавить задачу',exact:true}).click();
 await expect(page.getByLabel('Название',{exact:true})).toHaveValue('Бюджет');
 await page.getByLabel('Направление',{exact:true}).selectOption('sto');await page.getByLabel('Приоритет',{exact:true}).selectOption('important_urgent');
 await page.getByLabel('Срок сдачи',{exact:true}).fill('2026-11-06');await page.getByLabel('Описание',{exact:true}).fill('Собрать данные\nhttps://example.test/report');
 await page.getByRole('button',{name:'Сохранить задачу',exact:true}).click();await expect(cards(page)).toContainText('Важная и срочная');
 const t=(await db.query('select direction,important,urgent,deadline,description from public.tasks')).rows[0];expect(t).toMatchObject({direction:'sto',important:true,urgent:true});expect(t.description).toContain('\n');
 await expect(page.getByLabel('Название быстрой задачи')).toHaveValue('');
});
test('manager assigns a task to filtered employee and both independent sessions see stored changes',async({page,browser})=>{
 await installService(page,db);await ready(page,'manager');await page.locator('#planner-employee').selectOption(ids.employee2);
 await quick(page,'Задача сотруднику');
 const secondContext=await browser.newContext({baseURL:new URL(page.url()).origin}),second=await secondContext.newPage();
 try{await installService(second,db);await ready(second,'employee2');await expect(cards(second)).toContainText('Задача сотруднику');
 await cards(second).getByRole('button',{name:'Задача сотруднику',exact:true}).click();await page.waitForTimeout(20);
 await second.getByLabel('Изменить статус',{exact:false}).selectOption('in_progress');await expect(second.locator('#task-dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'Обновить',exact:true}).click();await expect(cards(page)).toContainText('В работе');}finally{await secondContext.close();}
});
test('assigned employee sees protected fields disabled and can edit description only',async({page})=>{
 await create({title:'Назначенная',assignee_id:ids.employee1,deadline:'2026-11-06'},'manager');
 await installService(page,db);await ready(page);await cards(page).getByRole('button',{name:'Назначенная',exact:true}).click();await page.getByRole('button',{name:'Изменить',exact:true}).click();
 await expect(page.locator('#task-title')).toBeDisabled();await expect(page.locator('#task-deadline')).toBeDisabled();await expect(page.locator('#task-priority')).toBeDisabled();
 await page.getByLabel('Описание',{exact:true}).fill('Уточнение');await page.getByRole('button',{name:'Сохранить задачу',exact:true}).click();
 await expect(page.locator('#task-dialog')).toHaveCount(0);expect((await db.query('select description from public.tasks')).rows[0].description).toBe('Уточнение');
});
test('complete and undo update server result and leave no duplicate task',async({page})=>{
 await installService(page,db);await ready(page);await quick(page,'Завершить сегодня');await page.getByRole('button',{name:'Завершить: Завершить сегодня',exact:true}).click();
 await expect(page.locator('.progress-card').first()).toContainText('100%');await expect(page.locator('.terminal-group summary')).toContainText('Выполнено');
 await page.getByRole('button',{name:'Отменить действие',exact:true}).click();await expect(cards(page)).toContainText('В работе');
 expect((await db.query('select count(*)::int as n from public.tasks')).rows[0].n).toBe(1);
});
test('moving long task to next week moves the card, preserves deadline and duration',async({page})=>{
 await create({title:'Длительная',plan_end:'2026-11-06',deadline:'2026-11-06'});
 await installService(page,db);await ready(page);await page.getByRole('button',{name:'Перенести: Длительная',exact:true}).click();
 await page.getByLabel('Новая дата работы',{exact:true}).fill('2026-11-09');await page.getByRole('button',{name:'Перенести',exact:true}).click();
 await expect(cards(page)).toHaveCount(0);await page.getByRole('button',{name:'Следующая неделя'}).click();await expect(cards(page)).toContainText('Длительная');
 const t=(await db.query('select plan_start::text,plan_end::text,deadline::text from public.tasks')).rows[0];expect(t.plan_end).toBe('2026-11-13');expect(t.deadline).toBe('2026-11-06');
});
test('drag and drop uses actual server move and respects calendar target',async({page})=>{
 await page.setViewportSize({width:1440,height:2200});
 await installService(page,db);await ready(page);await quick(page,'Передвинуть');
 await expect(cards(page).first()).toHaveAttribute('draggable','true');
 await expect(page.getByRole('button',{name:'Добавить быструю задачу',exact:true})).toBeEnabled();
 await cards(page).first().hover({position:{x:8,y:8}});await page.mouse.down();
 const target=page.locator('.month-day[data-date="2026-11-04"]');
 await target.hover();await target.hover();await page.mouse.up();
 await expect.poll(async()=>(await db.query('select plan_start::text from public.tasks')).rows[0].plan_start).toBe('2026-11-04');
 await expect(cards(page)).toHaveCount(0);await page.locator('.month-day[data-date="2026-11-04"]').click();await expect(cards(page)).toContainText('Передвинуть');
});
test('cancellation requires reason, can be reopened and does not count as completed',async({page})=>{
 await installService(page,db);await ready(page);await quick(page,'Отменяемая');await cards(page).getByRole('button',{name:'Отменяемая',exact:true}).click();
 await page.getByRole('button',{name:'Отменить задачу',exact:true}).click();await page.getByRole('button',{name:'Отменить задачу',exact:true}).click();
 await expect(page.getByText('Укажите причину от 1 до 1000 символов.')).toBeVisible();await page.getByLabel('Причина отмены').fill('Больше не требуется');await page.getByRole('button',{name:'Отменить задачу',exact:true}).click();
 await expect(page.locator('.progress-card').first()).toContainText('Нет запланированных задач');
 await page.locator('.terminal-group').getByText('Отменено · 1',{exact:true}).click();await page.locator('.terminal-group').getByRole('button',{name:'Отменяемая',exact:true}).click();
 await page.getByRole('button',{name:'Вернуть в работу',exact:true}).click();await expect(cards(page)).toContainText('В работе');
});
test('delete and bin restore keep identity and historical denominator',async({page})=>{
 await installService(page,db);await ready(page);await quick(page,'В корзину');const id=(await db.query('select id from public.tasks')).rows[0].id;
 await cards(page).getByRole('button',{name:'В корзину',exact:true}).click();await page.getByRole('button',{name:'Удалить',exact:true}).click();await page.getByRole('button',{name:'Удалить',exact:true}).click();
 await expect(cards(page)).toHaveCount(0);await expect(page.locator('.progress-card').first()).toContainText('0 из 1');
 await page.getByRole('button',{name:'Корзина',exact:true}).click();await page.locator('#task-dialog').getByRole('button',{name:'В корзину',exact:true}).click();await page.getByRole('button',{name:'Восстановить',exact:true}).click();
 await expect(page.locator(`.day-tasks [data-task-id="${id}"]`)).toBeVisible();expect((await db.query('select count(*)::int n from public.tasks')).rows[0].n).toBe(1);
});
test('filters/search/grouping keep progress denominator and persist settings after reload',async({page})=>{
 let t=await create({title:'Бюджет СТО',direction:'sto',important:true,urgent:false});await rpc(db,ids.employee1,'mutate_task',[team,'status',t.id,{status:'done'},t.version,randomUUID()]);await create({title:'Другая задача',direction:'dbk'});
 await installService(page,db);await ready(page);await page.locator('.filter-popover').first().locator('summary').click();await page.locator('[data-filter-multi="statuses"][value="done"]').check();
 await page.getByLabel('Поиск задач',{exact:true}).fill('бюджет');await expect(cards(page)).toHaveCount(1);await expect(cards(page)).toContainText('Бюджет СТО');await expect(page.locator('.progress-card').first()).toContainText('50%');
 await page.locator('#planner-direction').selectOption('sto');await expect(page.locator('.progress-card').first()).toContainText('100%');
 await page.getByLabel('Группировка задач',{exact:true}).selectOption('priority');await expect(page.locator('.task-group h3')).toContainText('Важная и несрочная');
 await page.reload();await expect(page.locator('#planner-direction')).toHaveValue('sto');await expect(page.getByLabel('Группировка задач',{exact:true})).toHaveValue('priority');
});
test('history shows author and original/changed values',async({page})=>{
 const t=await create({title:'Исходное'});await rpc(db,ids.employee1,'mutate_task',[team,'update',t.id,{title:'Исправленное'},t.version,randomUUID()]);
 await installService(page,db);await ready(page);await cards(page).getByRole('button',{name:'Исправленное',exact:true}).click();await page.getByRole('button',{name:'История',exact:true}).click();
 await expect(page.locator('.history-entry').first()).toContainText('Исходное → Исправленное');await expect(page.locator('.history-entry').first()).toContainText('Сотрудник 1');
});
test('unknown result after SQL commit retries same operation without duplication',async({page})=>{
 const service=await installService(page,db);await ready(page);service.dropTaskResponse=true;
 await page.getByLabel('Название быстрой задачи').fill('Не дублировать');await page.getByRole('button',{name:'Добавить быструю задачу',exact:true}).click();
 await expect(page.getByLabel('Название быстрой задачи')).toHaveValue('Не дублировать');await expect(page.locator('.notice-error')).toBeVisible();
 expect((await db.query('select count(*)::int n from public.tasks')).rows[0].n).toBe(1);
 await page.getByRole('button',{name:'Добавить быструю задачу',exact:true}).click();await expect(cards(page)).toContainText('Не дублировать');
 expect(service.taskRequests[0].p_operation_id).toBe(service.taskRequests[1].p_operation_id);expect((await db.query('select count(*)::int n from public.tasks')).rows[0].n).toBe(1);
});
test('form network error preserves draft; discard dialog and Escape respect unsaved changes',async({page})=>{
 const service=await installService(page,db);await ready(page);await page.getByRole('button',{name:'＋ Добавить задачу',exact:true}).click();await page.getByLabel('Название',{exact:true}).fill('Черновик');
 service.failedTask=true;await page.getByRole('button',{name:'Сохранить задачу',exact:true}).click();await expect(page.getByLabel('Название',{exact:true})).toHaveValue('Черновик');
 await expect(page.locator('#task-dialog .notice-error')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('#discard-dialog')).toBeVisible();await page.getByRole('button',{name:'Остаться',exact:true}).click();
 await expect(page.getByLabel('Название',{exact:true})).toHaveValue('Черновик');service.failedTask=false;await page.getByRole('button',{name:'Сохранить задачу',exact:true}).click();await expect(cards(page)).toContainText('Черновик');
});
test('conflicting task edit preserves original draft and permits explicit review',async({page})=>{
 const t=await create({title:'Общая'});await installService(page,db);await ready(page);await cards(page).getByRole('button',{name:'Общая',exact:true}).click();await page.getByRole('button',{name:'Изменить',exact:true}).click();await page.getByLabel('Название',{exact:true}).fill('Мой вариант');
 await rpc(db,ids.manager,'mutate_task',[team,'update',t.id,{title:'Вариант руководителя'},t.version,randomUUID()]);await page.getByRole('button',{name:'Сохранить задачу',exact:true}).click();
 await expect(page.getByText('Задача изменилась у коллеги. Проверьте актуальные данные.')).toBeVisible();await expect(page.getByLabel('Название',{exact:true})).toHaveValue('Мой вариант');
 await page.getByRole('button',{name:'Загрузить актуальную задачу',exact:true}).click();await expect(page.getByLabel('Название · только просмотр',{exact:true})).toHaveValue('Вариант руководителя');
});
test('overdue collection includes a task planned outside the current month',async({page})=>{
 await create({title:'Давний срок',plan_start:'2026-12-01',deadline:'2026-10-31'});await installService(page,db);await ready(page);
 await page.getByRole('button',{name:'Все просроченные: 1',exact:true}).click();await expect(page.locator('#task-dialog')).toContainText('Давний срок');
});
test('past navigation cannot backdate new task; date picker returns to server day',async({page})=>{
 await installService(page,db);await ready(page);await page.locator('.month-day[data-date="2026-11-01"]').click();await expect(page.locator('.quick-hint')).toContainText('создание на сегодня');
 await page.getByLabel('Название быстрой задачи').fill('Сегодняшняя');await page.getByRole('button',{name:'Добавить быструю задачу',exact:true}).click();await expect(page.locator('.notice-success')).toBeVisible();
 await page.getByLabel('Выбрать дату',{exact:true}).fill('2026-11-02');await page.getByLabel('Выбрать дату',{exact:true}).press('Tab');await expect(cards(page)).toContainText('Сегодняшняя');expect((await db.query('select plan_start::text from public.tasks')).rows[0].plan_start).toBe('2026-11-02');
});
test('calendar and modal fit all target widths; screenshots contain only test data',async({page})=>{
 await create({title:'Подготовить управленческий отчёт',direction:'sto',important:true,urgent:true,deadline:'2026-11-02'});await create({title:'Согласовать бюджет на ноябрь',direction:'uk',deadline:'2026-11-06'});await create({title:'Проверить данные по прокату',direction:'rental',plan_start:'2026-11-04'});await create({title:'Обновить план работы команды',direction:'dbk',plan_end:'2026-11-06'});
 await installService(page,db);await ready(page);
 for(const width of [360,390,768,1024,1440]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await expect(page.getByRole('button',{name:'＋ Добавить задачу',exact:true})).toBeVisible();}
 await page.setViewportSize({width:1440,height:1100});await page.screenshot({path:'.cache/preview-planner-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.cache/preview-planner-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'＋ Добавить задачу',exact:true}).click();await expect(page.getByLabel('Название',{exact:true})).toBeFocused();
 expect(await page.locator('#task-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBeTruthy();await page.screenshot({path:'.cache/preview-task-mobile.png'});
});
test('employee looking at colleague creates only own task and can reveal it',async({page})=>{
 await installService(page,db);await ready(page);await page.locator('#planner-employee').selectOption(ids.employee2);
 await page.getByLabel('Название быстрой задачи').fill('Моя внезапная');await page.getByRole('button',{name:'Добавить быструю задачу',exact:true}).click();
 await expect(page.getByRole('button',{name:'Показать мои',exact:true})).toBeVisible();await page.getByRole('button',{name:'Показать мои',exact:true}).click();
 await expect(cards(page)).toContainText('Моя внезапная');expect((await db.query('select assignee_id from public.tasks')).rows[0].assignee_id).toBe(ids.employee1);
});
