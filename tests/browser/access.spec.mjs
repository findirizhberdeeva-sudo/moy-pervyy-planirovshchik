import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {createDatabase,seedDatabase,ids} from '../helpers/database.mjs';
import {installService,login} from './service.mjs';
import {installFonts} from './fonts.mjs';
let db,team;
test.beforeAll(async()=>{db=await createDatabase();});
test.afterAll(async()=>{await db.close();});
test.beforeEach(async()=>{team=await seedDatabase(db);});
test('unconfigured page is honest, has no working login and does not load external SDK',async({page})=>{
  await installFonts(page);
  const outbound=[];page.on('request',request=>{if(request.url().startsWith('https:')) outbound.push(request.url());});
  await page.goto('/');
  await expect(page.getByText('Планировщик ещё не подключён',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Войти в Ритм',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Проверить подключение'}).click();
  await expect(page.getByText('Планировщик ещё не подключён',{exact:true})).toBeVisible();
  // The requested Rubik font is allowed; unconfigured Auth/SDK must stay unloaded.
  expect(outbound.filter(url=>new URL(url).origin!=='https://fonts.gstatic.com')).toEqual([]);
  await page.screenshot({path:'.cache/preview-unconfigured.png',fullPage:true});
});
test('login buttons validate fields, toggle password, normalize email and restore session on reload',async({page})=>{
  const service=await installService(page,db);await page.goto('/');
  await page.getByRole('button',{name:'Войти в Ритм',exact:true}).click();
  await expect(page.getByText('Введите корректную электронную почту.')).toBeVisible();
  await page.getByLabel('Электронная почта',{exact:true}).fill(' EMPLOYEE1@EXAMPLE.TEST ');
  await page.getByLabel('Пароль',{exact:true}).fill('Test password 123!');
  await page.getByRole('button',{name:'Показать пароль',exact:true}).click();
  await expect(page.getByLabel('Пароль',{exact:true})).toHaveAttribute('type','text');
  await page.getByRole('button',{name:'Скрыть пароль',exact:true}).click();
  await page.getByRole('button',{name:'Войти в Ритм',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Здравствуйте, Сотрудник 1.'})).toBeVisible();
  expect(service.loginRequests[0].email).toBe('employee1@example.test');
  await page.reload();await expect(page.getByRole('heading',{name:'Здравствуйте, Сотрудник 1.'})).toBeVisible();
  const stored=await page.evaluate(()=>JSON.stringify({...localStorage}));expect(stored).not.toContain('Test password');
});
test('invalid credentials use one generic error and keep email draft',async({page})=>{
  await installService(page,db);await login(page,'employee1','wrong password');
  await expect(page.getByText('Не удалось войти. Проверьте почту и пароль.')).toBeVisible();
  await expect(page.getByLabel('Электронная почта',{exact:true})).toHaveValue('employee1@example.test');
});
test('profile changes reach PostgreSQL, survive reload and cannot change role',async({page})=>{
  await installService(page,db);await login(page);
  await page.getByRole('button',{name:'Открыть профиль'}).click();
  await expect(page.getByLabel('Электронная почта',{exact:true})).toHaveAttribute('readonly','');
  await page.getByLabel('Отображаемое имя').fill('Анна');
  await page.getByRole('button',{name:'Сохранить имя',exact:true}).click();
  await expect(page.getByText('Имя сохранено.',{exact:true})).toBeVisible();
  expect((await db.query('select display_name,role from public.team_members where user_id=$1',[ids.employee1])).rows[0]).toMatchObject({display_name:'Анна',role:'employee'});
  await page.reload();await expect(page.getByRole('heading',{name:'Здравствуйте, Анна.'})).toBeVisible();
});
test('profile password checks length and confirmation, saves and clears password fields',async({page})=>{
  const service=await installService(page,db);await login(page);await page.getByRole('button',{name:'Открыть профиль'}).click();
  await page.getByLabel('Новый пароль',{exact:true}).fill('short');await page.getByLabel('Повторите пароль',{exact:true}).fill('other');
  await page.getByRole('button',{name:'Сохранить пароль',exact:true}).click();
  await expect(page.getByText('Пароли не совпадают.',{exact:true})).toBeVisible();
  await page.getByLabel('Новый пароль',{exact:true}).fill(' Another password 123! ');await page.getByLabel('Повторите пароль',{exact:true}).fill(' Another password 123! ');
  await page.getByRole('button',{name:'Сохранить пароль',exact:true}).click();
  await expect(page.getByText('Новый пароль сохранён.',{exact:true})).toBeVisible();
  expect(service.passwordUpdates.at(-1)).toBe(' Another password 123! ');
  await expect(page.getByLabel('Новый пароль',{exact:true})).toHaveValue('');
});
test('unsaved profile asks whether to stay or discard, and logout clears session',async({page})=>{
  await installService(page,db);await login(page);await page.getByRole('button',{name:'Открыть профиль'}).click();
  await page.getByLabel('Отображаемое имя').fill('Не сохранено');await page.getByRole('button',{name:'Закрыть',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'Остаться',exact:true}).click();
  await expect(page.getByLabel('Отображаемое имя')).toHaveValue('Не сохранено');
  await page.getByRole('button',{name:'Выйти',exact:true}).click();await page.getByRole('button',{name:'Закрыть без сохранения'}).click();
  await expect(page.getByRole('button',{name:'Войти в Ритм',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('button',{name:'Войти в Ритм',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('ritm-auth:')))).toEqual([]);
});
test('unknown recovery email has the same confirmation, with a safe repository redirect',async({page})=>{
  const service=await installService(page,db);await page.goto('/ritm/');
  await page.getByRole('button',{name:'Забыли пароль?'}).click();
  await page.getByLabel('Электронная почта',{exact:true}).fill('unknown@example.test');await page.getByRole('button',{name:'Отправить ссылку'}).click();
  await expect(page.getByText('Если эта почта подключена к команде, на неё придёт ссылка для восстановления доступа.')).toBeVisible();
  expect(decodeURIComponent(service.recoveryRequests[0].url)).toContain('redirect_to=http://127.0.0.1:3000/ritm/');
  await page.getByRole('button',{name:'Вернуться ко входу'}).click();await expect(page.getByRole('heading',{name:'Добро пожаловать',exact:true})).toBeVisible();
});
test('recovery link opens password form, strips secret URL and updates password before opening workspace',async({page})=>{
  await installService(page,db);await page.goto('/?token_hash=valid-recovery&type=recovery');
  await expect(page.getByRole('heading',{name:'Установите пароль'})).toBeVisible();
  expect(page.url()).not.toContain('token_hash');
  await page.reload();await expect(page.getByRole('heading',{name:'Установите пароль'})).toBeVisible();
  await page.getByLabel('Новый пароль',{exact:true}).fill('New password 123!');await page.getByLabel('Повторите пароль',{exact:true}).fill('New password 123!');
  await page.getByRole('button',{name:'Сохранить пароль',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Здравствуйте, Сотрудник 1.'})).toBeVisible();
});
test('expired auth link gives an error without exposing a token or a workspace',async({page})=>{
  await installService(page,db);await page.goto('/?token_hash=expired-secret&type=recovery');
  await expect(page.getByText('Ссылка недействительна или срок её действия истёк. Запросите новую ссылку.')).toBeVisible();
  expect(page.url()).not.toContain('expired-secret');expect(await page.locator('body').innerText()).not.toContain('expired-secret');
  await expect(page.getByRole('heading',{name:/Здравствуйте/})).toHaveCount(0);
});
test('invitation password setup activates only the existing employee invitation',async({page})=>{
  await db.query(`update auth.users set encrypted_password='' where id=$1`,[ids.outsider]);
  await db.query(`insert into public.team_members(team_id,user_id,display_name,role,state) values($1,$2,'Новый сотрудник','employee','invited')`,[team,ids.outsider]);
  await db.query(`insert into private.invitations(team_id,email,display_name,user_id,state,inviter_id,expires_at,operation_id) values($1,'outsider@example.test','Новый сотрудник',$2,'sent',$3,now()+interval '24 hours',$4)`,[team,ids.outsider,ids.manager,randomUUID()]);
  await installService(page,db);await page.goto('/?token_hash=valid-invite&type=invite');
  await expect(page.getByRole('heading',{name:'Установите пароль'})).toBeVisible();
  await page.getByLabel('Новый пароль',{exact:true}).fill('Invite password 123!');await page.getByLabel('Повторите пароль',{exact:true}).fill('Invite password 123!');await page.getByRole('button',{name:'Сохранить пароль',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Здравствуйте, Новый сотрудник.'})).toBeVisible();
  expect((await db.query('select state,role from public.team_members where user_id=$1',[ids.outsider])).rows[0]).toMatchObject({state:'active',role:'employee'});
});
test('outsider and disabled employee cannot open a workspace',async({page})=>{
  await installService(page,db);await login(page,'outsider');
  await expect(page.getByRole('heading',{name:'Не удалось открыть пространство'})).toBeVisible();
  await page.getByRole('button',{name:'Вернуться ко входу'}).click();await login(page);
  await expect(page.getByRole('heading',{name:/Здравствуйте/})).toBeVisible();
  await db.query(`update public.team_members set state='disabled',disabled_at=now() where user_id=$1`,[ids.employee1]);
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('heading',{name:'Не удалось открыть пространство'})).toBeVisible();
});
test('profile version conflict preserves draft and supports explicit review/retry',async({page})=>{
  await installService(page,db);await login(page);await page.getByRole('button',{name:'Открыть профиль'}).click();
  await page.getByLabel('Отображаемое имя').fill('Мой вариант');
  await db.query('update public.team_members set display_name=$1 where user_id=$2',['Другой вариант',ids.employee1]);
  await page.getByRole('button',{name:'Сохранить имя',exact:true}).click();
  await expect(page.getByText('Актуальное имя: Другой вариант.')).toBeVisible();await expect(page.getByLabel('Отображаемое имя')).toHaveValue('Мой вариант');
  await page.getByRole('button',{name:'Применить моё имя после проверки'}).click();await expect(page.getByText('Имя сохранено.',{exact:true})).toBeVisible();
});
test('network failure keeps profile draft and retry saves once',async({page})=>{
  const service=await installService(page,db);await login(page);await page.getByRole('button',{name:'Открыть профиль'}).click();
  await page.getByLabel('Отображаемое имя').fill('После сети');service.failedProfile=true;
  await page.getByRole('button',{name:'Сохранить имя',exact:true}).click();
  await expect(page.getByText('Не удалось связаться с планировщиком. Проверьте соединение и повторите.')).toBeVisible();
  await expect(page.getByLabel('Отображаемое имя')).toHaveValue('После сети');service.failedProfile=false;
  await page.getByRole('button',{name:'Сохранить имя',exact:true}).click();await expect(page.getByText('Имя сохранено.',{exact:true})).toBeVisible();
  expect((await db.query('select version from public.team_members where user_id=$1',[ids.employee1])).rows[0].version).toBe(2);
});
test('stored malicious display name renders as text, never HTML',async({page})=>{
  await db.query('update public.team_members set display_name=$1 where user_id=$2',['<img src=x onerror="window.hacked=true">',ids.employee1]);
  await installService(page,db);await login(page);await expect(page.getByRole('heading',{name:/Здравствуйте/})).toBeVisible();
  expect(await page.evaluate(()=>window.hacked)).toBeUndefined();await expect(page.locator('img')).toHaveCount(0);
});
test('login and profile fit all target widths and retain visible actions at 200% scale',async({page})=>{
  await installService(page,db);
  for(const width of [360,390,768,1024,1440]) {
    await page.setViewportSize({width,height:900});await page.goto('/');
    await expect(page.getByRole('button',{name:'Войти в Ритм',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  }
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.cache/preview-login-desktop.png',fullPage:true});
  await login(page);await page.getByRole('button',{name:'Открыть профиль'}).click();
  for(const width of [360,390,768,1024,1440]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await expect(page.getByRole('button',{name:'Сохранить имя',exact:true})).toBeVisible();
  }
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.cache/preview-profile-mobile.png',fullPage:true});
  await page.setViewportSize({width:720,height:500});await expect(page.getByRole('button',{name:'Сохранить имя',exact:true})).toBeVisible();
});
