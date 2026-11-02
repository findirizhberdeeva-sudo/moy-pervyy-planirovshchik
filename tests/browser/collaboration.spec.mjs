import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,rpc,ids} from '../helpers/database.mjs';
import {installClock,clock} from '../helpers/step3.mjs';
import {installService,login} from './service.mjs';
let db,team;
test.beforeAll(async()=>{db=await createDatabase();await installClock(db);});test.afterAll(async()=>{await db.close();});
test.beforeEach(async()=>{team=await seedDatabase(db);await clock(db);});
const cards=page=>page.locator('.day-tasks .task-card');
async function ready(page,user='employee1'){const service=await installService(page,db);await login(page,user);await expect(page.locator('#quick-title')).toBeVisible();await expect.poll(()=>service.socketMessages.filter(m=>m.event==='phx_join').length).toBeGreaterThan(0);await expect(page.locator('.sync-note')).toHaveCount(0);return service;}
async function task(patch={},user='employee1'){const r=await rpc(db,ids[user],'mutate_task',[team,'create',null,{title:'Общая задача',...patch},null,randomUUID()]);expect(r.ok,JSON.stringify(r)).toBe(true);return r.data.entity;}
async function openTask(page,title='Общая задача'){await cards(page).getByRole('button',{name:title,exact:true}).click();await expect(page.locator('#task-dialog .detail-title')).toHaveText(title);}
async function comments(page){await page.getByRole('button',{name:/^Комментарии ·/}).click();await expect(page.locator('#comment-draft')).toBeVisible();}
async function series(patch={}){const r=await rpc(db,ids.employee1,'mutate_series',[team,'create',null,null,{title:'Регулярная проверка',frequency:'daily',end_date:'2026-11-06',...patch},null,randomUUID()]);expect(r.ok,JSON.stringify(r)).toBe(true);return r.data.entity;}

test('team is manager-only, invitation success binds employee and link activation finishes setup',async({page,browser})=>{
 const service=await ready(page,'manager');await page.getByRole('button',{name:'Команда',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Участники',exact:true})).toBeVisible();await page.getByLabel('Имя',{exact:true}).fill('Новый коллега');await page.getByLabel('Email',{exact:true}).fill('outsider@example.test');await page.getByRole('button',{name:'Отправить приглашение',exact:true}).click();
 await expect(page.locator('.invitation-card')).toContainText('Отправлено');expect(service.admin.mails.length).toBe(1);await expect(page.locator('.invitation-card')).toContainText('Почтовый сервис принял письмо');
 const context=await browser.newContext();try{const invitee=await context.newPage();await installService(invitee,db);await invitee.goto('/?token_hash=valid-invite&type=invite');await invitee.getByLabel('Новый пароль',{exact:true}).fill('New colleague password 123!');await invitee.getByLabel('Повторите пароль',{exact:true}).fill('New colleague password 123!');await invitee.getByRole('button',{name:'Сохранить пароль',exact:true}).click();await expect(invitee.locator('#quick-title')).toBeVisible();await expect(invitee.getByRole('button',{name:'Команда',exact:true})).toHaveCount(0);
  expect((await db.query('select state,role from public.team_members where user_id=$1',[ids.outsider])).rows[0]).toMatchObject({state:'active',role:'employee'});
 }finally{await context.close();}
});
test('failed invitation is visible, resend is throttled and cancellation is a real database change',async({page})=>{
 const service=await ready(page,'manager');service.admin.mailFailure=true;await page.getByRole('button',{name:'Команда',exact:true}).click();await page.getByLabel('Имя',{exact:true}).fill('Приглашённый');await page.getByLabel('Email',{exact:true}).fill('mail@example.test');await page.getByRole('button',{name:'Отправить приглашение',exact:true}).click();
 await expect(page.locator('.invitation-card')).toContainText('Не отправлено');await expect(page.locator('.invitation-card button[data-action="work-invite-resend"]')).toBeDisabled();
 await page.getByRole('button',{name:'Отменить приглашение',exact:true}).click();await expect(page.locator('.invitation-card')).toContainText('Отменено');expect((await db.query('select state from private.invitations')).rows[0].state).toBe('cancelled');
});
test('disable modal transfers tasks and closes existing employee session on access recheck',async({page,browser})=>{
 const t=await task();await ready(page,'manager');const context=await browser.newContext();try{const employee=await context.newPage();await ready(employee);await expect(cards(employee)).toContainText(t.title);
  await page.getByRole('button',{name:'Команда',exact:true}).click();const member=page.locator('.member-card').filter({has:page.getByRole('heading',{name:'Сотрудник 1',exact:true})});await member.getByRole('button',{name:'Отключить',exact:true}).click();
  await expect(page.locator('#task-dialog')).toContainText('Активных задач: 1');await page.getByLabel('Новый исполнитель',{exact:true}).selectOption(ids.employee2);await page.getByRole('button',{name:'Отключить и передать',exact:true}).click();await expect(page.locator('#task-dialog')).toHaveCount(0);
  expect((await db.query('select assignee_id from public.tasks where id=$1',[t.id])).rows[0].assignee_id).toBe(ids.employee2);
  await employee.bringToFront();await expect.poll(()=>employee.evaluate(()=>document.visibilityState)).toBe('visible');await employee.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(employee.locator('#quick-title')).toHaveCount(0);await expect(employee.getByText('Не удалось открыть пространство',{exact:true})).toBeVisible();
  await member.getByRole('button',{name:'Включить снова',exact:true}).click();await expect(member).toContainText('Активен');expect((await db.query('select assignee_id from public.tasks where id=$1',[t.id])).rows[0].assignee_id).toBe(ids.employee2);
 }finally{await context.close();}
});
test('comment create/edit/delete and manager audit preserve safe plain text',async({page})=>{
 const t=await task();await ready(page);await openTask(page);await comments(page);await page.locator('#comment-draft').fill('<img src=x onerror="window.hacked=true"> https://example.test');await page.getByRole('button',{name:'Отправить комментарий',exact:true}).click();
 await expect(page.locator('.comment-entry')).toContainText('<img');expect(await page.evaluate(()=>window.hacked)).toBeUndefined();await expect(page.locator('.comment-entry img')).toHaveCount(0);await expect(page.locator('.comment-entry a')).toHaveAttribute('rel','noopener noreferrer');
 await page.getByRole('button',{name:'Изменить комментарий',exact:true}).click();await page.locator('#comment-draft').fill('Уточнение для команды');await page.getByRole('button',{name:'Сохранить комментарий',exact:true}).click();await expect(page.locator('.comment-entry')).toContainText('Изменён');
 await page.getByRole('button',{name:'Удалить комментарий',exact:true}).click();await page.getByRole('button',{name:'Подтвердить удаление',exact:true}).click();await expect(page.locator('.comment-entry')).toContainText('Комментарий удалён');
 const history=await rpc(db,ids.employee2,'get_task_history',[team,t.id,null]);expect(JSON.stringify(history)).not.toContain('Уточнение для команды');
});
test('comment draft survives failed/unknown response and retry has one stored comment',async({page})=>{
 await task();const service=await ready(page);await openTask(page);await comments(page);await page.locator('#comment-draft').fill('Сохранить после обрыва');service.dropCommentResponse=true;
 await page.getByRole('button',{name:'Отправить комментарий',exact:true}).click();await expect(page.locator('#comment-draft')).toHaveValue('Сохранить после обрыва');await expect(page.locator('#task-dialog [role="alert"]').first()).toBeVisible();
 await page.getByRole('button',{name:'Отправить комментарий',exact:true}).click();await expect(page.locator('#comment-draft')).toHaveValue('');expect((await db.query('select count(*) as n from public.comments')).rows[0].n).toBe(1);
 await page.locator('#comment-draft').fill('Не терять при закрытии');await page.getByRole('button',{name:'Закрыть задачу',exact:true}).click();await expect(page.getByRole('dialog',{name:'Изменения ещё не сохранены'})).toBeVisible();await task({title:'Обновление во время подтверждения'});await service.emitRealtime();await expect(cards(page).filter({hasText:'Обновление во время подтверждения'})).toHaveCount(1);await expect(page.getByRole('dialog',{name:'Изменения ещё не сохранены'})).toBeVisible();await page.getByRole('button',{name:'Остаться',exact:true}).click();await expect(page.locator('#comment-draft')).toHaveValue('Не терять при закрытии');
});
test('same-author concurrent comment edit exposes conflict and preserves explicit draft',async({page,browser})=>{
 const t=await task();await rpc(db,ids.employee1,'mutate_comment',[team,'create',t.id,null,'Исходный',null,randomUUID()]);await ready(page);await openTask(page);await comments(page);await page.getByRole('button',{name:'Изменить комментарий',exact:true}).click();await page.locator('#comment-draft').fill('Мой черновик');
 const context=await browser.newContext();try{const other=await context.newPage();await ready(other);await openTask(other);await comments(other);await other.getByRole('button',{name:'Изменить комментарий',exact:true}).click();await other.locator('#comment-draft').fill('Сохранено в другой сессии');await other.getByRole('button',{name:'Сохранить комментарий',exact:true}).click();
  await expect(page.getByRole('button',{name:'Применить мой текст после проверки',exact:true})).toBeVisible();await expect(page.locator('#comment-draft')).toHaveValue('Мой черновик');await page.getByRole('button',{name:'Применить мой текст после проверки',exact:true}).click();await expect(page.locator('.comment-entry')).toContainText('Мой черновик');
 }finally{await context.close();}
});
test('notification opening marks one read across independent sessions; listing marks none',async({page,browser})=>{
 await task({assignee_id:ids.employee1},'manager');await ready(page);const context=await browser.newContext();try{const other=await context.newPage();await ready(other);
  await page.getByRole('button',{name:'Уведомления: 1',exact:true}).click();await expect(page.locator('.notification-item.unread')).toHaveCount(1);expect((await db.query('select read_at from public.notifications')).rows[0].read_at).toBeNull();
  await page.getByRole('button',{name:/Вам назначена задача/}).click();await expect(page.locator('#task-dialog .detail-title')).toHaveText('Общая задача');await expect(other.getByRole('button',{name:'Уведомления: 0',exact:true})).toBeVisible();expect((await db.query('select read_at from public.notifications')).rows[0].read_at).not.toBeNull();
 }finally{await context.close();}
});
test('notification unread filter and read-all update only personal records',async({page})=>{
 await task({title:'Первая',assignee_id:ids.employee1},'manager');await task({title:'Вторая',assignee_id:ids.employee1},'manager');await ready(page);
 await page.getByRole('button',{name:'Уведомления: 2',exact:true}).click();await page.getByRole('button',{name:'Непрочитанные',exact:true}).click();await expect(page.getByRole('button',{name:'Непрочитанные',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.locator('.notification-item')).toHaveCount(2);
 await page.getByRole('button',{name:'Прочитать все',exact:true}).click();await expect(page.locator('.notification-item')).toHaveCount(0);await expect(page.getByRole('button',{name:'Уведомления: 0',exact:true})).toBeVisible();expect((await db.query('select count(*) as n from public.notifications where read_at is null')).rows[0].n).toBe(0);
});
test('offline comment is never queued and returning online preserves draft until explicit retry',async({page})=>{
 await task();const service=await ready(page);await openTask(page);await comments(page);await page.locator('#comment-draft').fill('Вернуться к этому тексту');await page.context().setOffline(true);await page.getByRole('button',{name:'Отправить комментарий',exact:true}).click();await expect(page.locator('#network-banner')).toBeVisible();await expect(page.locator('#comment-draft')).toHaveValue('Вернуться к этому тексту');
 await page.context().setOffline(false);await expect(page.locator('#network-banner')).toHaveCount(0);await expect(page.locator('#comment-draft')).toHaveValue('Вернуться к этому тексту');expect(service.rpcRequests.filter(r=>r.name==='mutate_comment').length).toBe(0);expect((await db.query('select count(*) as n from public.comments')).rows[0].n).toBe(0);
 await page.getByRole('button',{name:'Отправить комментарий',exact:true}).click();await expect(page.locator('.comment-entry')).toContainText('Вернуться к этому тексту');
});
test('comment rate response preserves draft and repeated clicks do not create a retry loop',async({page})=>{
 await task();const service=await ready(page);await openTask(page);await comments(page);await db.query(`insert into private.rate_limit_counters values($1,'comment',date_trunc('minute',private.task_now()),20)`,['user:'+ids.employee1]);
 await page.locator('#comment-draft').fill('Подождать перед повтором');await page.getByRole('button',{name:'Отправить комментарий',exact:true}).click();await expect(page.locator('#task-dialog')).toContainText('Повторите через');await expect(page.locator('#comment-draft')).toHaveValue('Подождать перед повтором');await page.getByRole('button',{name:'Отправить комментарий',exact:true}).click();expect(service.rpcRequests.filter(r=>r.name==='mutate_comment').length).toBe(1);
});
test('recurrence full form creates weekly schedule and separate IDs for selected weekdays',async({page})=>{
 await ready(page);await page.getByRole('button',{name:'＋ Добавить задачу',exact:true}).click();await page.getByLabel('Название',{exact:true}).fill('Недельная сверка');await page.getByLabel('Как повторять',{exact:true}).selectOption('weekly');await page.getByLabel('СР',{exact:true}).check();await page.getByLabel('Последний день повторения',{exact:true}).fill('2026-11-15');await page.getByRole('button',{name:'Сохранить задачу',exact:true}).click();
 await expect(cards(page)).toContainText('Недельная сверка');await expect(cards(page)).toContainText('Повторение');expect((await db.query('select frequency,weekdays from public.recurrence_series')).rows[0]).toMatchObject({frequency:'weekly',weekdays:[1,3]});expect((await db.query('select count(*) as n from public.tasks')).rows[0].n).toBe(4);
});
test('one-instance edit leaves series intact; future edit previews changes and keeps IDs',async({page})=>{
 const s=await series();const before=(await db.query('select id from public.tasks where series_id=$1 order by occurrence_date',[s.id])).rows.map(t=>t.id);const service=await ready(page);await openTask(page,'Регулярная проверка');await page.getByRole('button',{name:'Только эту задачу',exact:true}).click();await page.getByLabel('Название',{exact:true}).fill('Исключение');await page.getByRole('button',{name:'Сохранить задачу',exact:true}).click();
 await openTask(page,'Исключение');await page.getByRole('button',{name:'Эту и будущие',exact:true}).click();await expect(page.locator('#task-dialog')).toContainText('индивидуальные изменения будут заменены');await page.getByLabel('Название',{exact:true}).fill('Обновлённая серия');await page.getByRole('button',{name:'Применить',exact:true}).click();await expect(page.locator('#task-dialog')).toHaveCount(0);
 expect((await db.query(`select template->>'title' as title from public.recurrence_series where id=$1`,[s.id])).rows[0].title,JSON.stringify(service.rpcRequests.filter(r=>r.name==='mutate_series'))).toBe('Обновлённая серия');await expect(cards(page)).toContainText('Обновлённая серия');
 expect((await db.query('select id from public.tasks where series_id=$1 order by occurrence_date',[s.id])).rows.map(t=>t.id)).toEqual(before);expect((await db.query(`select count(*) as n from public.tasks where series_id=$1 and title='Обновлённая серия'`,[s.id])).rows[0].n).toBe(5);
});
test('stop recurrence preserves current task and withdraws future plan',async({page})=>{
 await series();await ready(page);await openTask(page,'Регулярная проверка');await page.getByRole('button',{name:'Завершить повторение',exact:true}).click();await expect(page.getByLabel('Завершить повторение после даты',{exact:true})).toHaveValue('2026-11-02');await page.getByRole('button',{name:'Завершить повторение',exact:true}).click();
 await expect(cards(page)).toContainText('Регулярная проверка');expect((await db.query('select count(*) as n from public.tasks where is_superseded')).rows[0].n).toBe(4);await page.locator('.month-day[data-date="2026-11-03"]').click();await expect(cards(page)).toHaveCount(0);
});
test('Realtime updates independent board without refresh and keeps an open task draft',async({page,browser})=>{
 const t=await task();const service=await ready(page);const context=await browser.newContext();try{const manager=await context.newPage();await ready(manager,'manager');
  await openTask(page);await page.getByRole('button',{name:'Изменить',exact:true}).click();await page.getByLabel('Название',{exact:true}).fill('Не потерять черновик');
  await manager.locator('#planner-employee').selectOption(ids.employee1);await manager.locator('#quick-title').fill('Новая общая');await manager.getByRole('button',{name:'Добавить быструю задачу',exact:true}).click();await expect(cards(page).filter({hasText:'Новая общая'})).toHaveCount(1);
  const updated=await rpc(db,ids.manager,'mutate_task',[team,'update',t.id,{title:'Изменено руководителем'},t.version,randomUUID()]);expect(updated.ok).toBe(true);await service.emitRealtime();
  await expect(page.getByText('Задача изменилась у коллеги. Ваши данные сохранены в форме.',{exact:true})).toBeVisible();await expect(page.getByLabel('Название',{exact:true})).toHaveValue('Не потерять черновик');await page.getByRole('button',{name:'Загрузить актуальную задачу',exact:true}).click();await expect(page.getByLabel('Название · только просмотр',{exact:true})).toHaveValue('Изменено руководителем');await expect(page.getByLabel('Название · только просмотр',{exact:true})).toBeDisabled();
 }finally{await context.close();}
});
test('lost socket messages recover on resubscription and foreground without assuming complete delivery',async({page})=>{
 let t=await task();const service=await ready(page);service.muteRealtime=true;t=(await rpc(db,ids.employee1,'mutate_task',[team,'update',t.id,{title:'Пропущенное изменение'},t.version,randomUUID()])).data.entity;await service.emitRealtime();await expect(cards(page)).toContainText('Общая задача');
 service.muteRealtime=false;service.disconnectRealtime();await expect.poll(()=>service.socketMessages.filter(m=>m.event==='phx_join').length,{timeout:10000}).toBeGreaterThan(1);await expect(cards(page)).toContainText('Пропущенное изменение');
 service.muteRealtime=true;await rpc(db,ids.employee1,'mutate_task',[team,'update',t.id,{title:'После возврата'},t.version,randomUUID()]);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(cards(page)).toContainText('После возврата');
});
test('conflict application sends only edited task fields and preserves a colleague date change',async({page})=>{
 const t=await task();const service=await ready(page);await openTask(page);await page.getByRole('button',{name:'Изменить',exact:true}).click();await page.getByLabel('Описание',{exact:true}).fill('Мой текст описания');
 const moved=await rpc(db,ids.manager,'mutate_task',[team,'move',t.id,{plan_start:'2026-11-04'},t.version,randomUUID()]);expect(moved.ok).toBe(true);await service.emitRealtime();
 await expect(page.getByText('Актуальные данные задачи',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Применить мои изменения после проверки',exact:true}).click();await expect(page.locator('#task-dialog')).toHaveCount(0);
 expect((await db.query('select description,plan_start::text from public.tasks where id=$1',[t.id])).rows[0]).toEqual({description:'Мой текст описания',plan_start:'2026-11-04'});
});
test('series conflict shows latest rule and reapplies only edited fields',async({page})=>{
 const s=await series();await ready(page);await openTask(page,'Регулярная проверка');await page.getByRole('button',{name:'Эту и будущие',exact:true}).click();await page.getByLabel('Описание',{exact:true}).fill('Моё описание серии');
 const changed=await rpc(db,ids.employee1,'mutate_series',[team,'update',s.id,'2026-11-02',{frequency:'weekly',weekdays:[1,3]},s.version,randomUUID()]);expect(changed.ok,JSON.stringify(changed)).toBe(true);
 await page.getByRole('button',{name:'Применить',exact:true}).click();await expect(page.getByText('Актуальное правило повторения',{exact:true})).toBeVisible();await expect(page.getByLabel('Описание',{exact:true})).toHaveValue('Моё описание серии');await page.getByRole('button',{name:'Применить мои изменения после проверки',exact:true}).click();await expect(page.locator('#task-dialog')).toHaveCount(0);
 expect((await db.query(`select frequency,weekdays,template->>'description' as description from public.recurrence_series where id=$1`,[s.id])).rows[0]).toEqual({frequency:'weekly',weekdays:[1,3],description:'Моё описание серии'});
});
test('visible-tab fallback poll refreshes data after sixty seconds without Realtime',async({page})=>{
 const t=await task();const service=await ready(page);await page.clock.install();service.muteRealtime=true;await rpc(db,ids.employee1,'mutate_task',[team,'update',t.id,{title:'Резервное обновление'},t.version,randomUUID()]);await page.clock.fastForward(61000);await expect(cards(page)).toContainText('Резервное обновление');
});
test('late task response cannot replace a different modal after the first was closed',async({page})=>{
 const first=await task({title:'Медленный ответ'});await task({title:'Другая задача'});const service=await ready(page);let release;service.detailGates[first.id]=new Promise(resolve=>{release=resolve;});
 await cards(page).getByRole('button',{name:'Медленный ответ',exact:true}).click();await expect.poll(()=>service.rpcRequests.filter(r=>r.name==='get_task_detail'&&r.body.p_task_id===first.id).length).toBeGreaterThan(0);await page.getByRole('button',{name:'Закрыть задачу',exact:true}).click();
 await openTask(page,'Другая задача');release();await page.getByRole('button',{name:/^Комментарии ·/}).click();await expect(page.locator('#task-dialog .detail-title')).toHaveText('Другая задача');await expect(page.locator('#comment-draft')).toBeVisible();
});
test('server date change carries Friday task to Monday and preserves deadline',async({page})=>{
 await clock(db,'2026-11-06T12:00:00+03:00');const t=await task({deadline:'2026-11-06'});await ready(page);await clock(db,'2026-11-07T00:01:00+03:00');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.locator('#day-heading')).toContainText('7 ноября');await expect(page.locator('.daily-support')).toBeVisible();await page.getByRole('button',{name:'Закрыть сообщение поддержки',exact:true}).click();await page.locator('.month-day[data-date="2026-11-09"]').click();await expect(cards(page)).toContainText('Общая задача');expect((await db.query('select plan_start::text,deadline::text from public.tasks where id=$1',[t.id])).rows[0]).toEqual({plan_start:'2026-11-09',deadline:'2026-11-06'});
});
test('team, comments, notifications and repeat forms fit phone/desktop; screenshots use only fixtures',async({page})=>{
 await series();const service=await ready(page,'manager');await page.getByRole('button',{name:'Команда',exact:true}).click();for(const width of [360,390,768,1440]){await page.setViewportSize({width,height:950});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();}
 await page.screenshot({path:'.cache/preview-step3-team.png',fullPage:true});await page.getByRole('button',{name:'План',exact:true}).click();await openTask(page,'Регулярная проверка');await comments(page);await page.locator('#comment-draft').fill('Коллеги, данные собраны. Можно проверить итог.');await page.getByRole('button',{name:'Отправить комментарий',exact:true}).click();await expect(page.getByRole('button',{name:'Отправить комментарий',exact:true})).toBeEnabled();await page.screenshot({path:'.cache/preview-step3-comments.png'});
 await page.getByRole('button',{name:'Подробности',exact:true}).click();await page.getByRole('button',{name:'Эту и будущие',exact:true}).click();await page.setViewportSize({width:390,height:844});expect(await page.locator('#task-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBeTruthy();await page.screenshot({path:'.cache/preview-step3-series-mobile.png'});
 await page.getByRole('button',{name:'Закрыть задачу',exact:true}).click();const assigned=await task({title:'Подготовить отчёт команды',assignee_id:ids.employee1},'manager');await rpc(db,ids.employee1,'mutate_task',[team,'status',assigned.id,{status:'done'},assigned.version,randomUUID()]);await service.emitRealtime();await expect(page.getByRole('button',{name:'Уведомления: 1',exact:true})).toBeVisible();await page.getByRole('button',{name:'Уведомления: 1',exact:true}).click();await expect(page.locator('.notification-item')).toHaveCount(1);expect(await page.locator('#task-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBeTruthy();await page.screenshot({path:'.cache/preview-step3-notifications.png'});
});
test('background refresh cannot return focus to a previous invitation field after the user moved on',async({page})=>{
 await ready(page,'manager');await page.getByRole('button',{name:'Команда',exact:true}).click();await expect(page.locator('.member-card')).toHaveCount(3);await page.locator('#invite-name').focus();
 await page.evaluate(()=>{window.priorInviteName=document.getElementById('invite-name');window.savedRequestAnimationFrame=window.requestAnimationFrame;window.heldFocusCallbacks=[];window.requestAnimationFrame=callback=>{window.heldFocusCallbacks.push(callback);return window.heldFocusCallbacks.length;};document.dispatchEvent(new Event('visibilitychange'));});
 await expect.poll(()=>page.evaluate(()=>document.getElementById('invite-name')!==window.priorInviteName)).toBe(true);await page.locator('#invite-email').focus();await page.evaluate(()=>{const callbacks=window.heldFocusCallbacks.splice(0);window.requestAnimationFrame=window.savedRequestAnimationFrame;for(const callback of callbacks)callback(performance.now());});await expect(page.locator('#invite-email')).toBeFocused();await page.locator('#invite-email').fill('focus@example.test');await expect(page.locator('#invite-email')).toHaveValue('focus@example.test');
});
