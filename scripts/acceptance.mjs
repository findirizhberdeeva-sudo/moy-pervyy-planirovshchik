import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const files={a:'tests/access.test.mjs',t:'tests/tasks.test.mjs',au:'tests/automation.test.mjs',c:'tests/collaboration.test.mjs',e:'tests/edge-admin.test.mjs',ta:'tests/team-admin.test.mjs',p:'tests/persistence.test.mjs',r:'tests/reports.test.mjs',ba:'tests/browser/access.spec.mjs',bp:'tests/browser/planner.spec.mjs',bc:'tests/browser/collaboration.spec.mjs',br:'tests/browser/reports.spec.mjs',bv:'tests/browser/acceptance.spec.mjs'};
const UC=[
 'ba|invitation password',
 'ba|login buttons',
 'ba|unknown recovery;ba|recovery link;ba|expired auth',
 'ba|profile changes;ba|profile password;ba|unsaved profile',
 'bc|team is manager-only;ta|invitation intent',
 'bc|failed invitation;ta|delivery failure;ta|invitation counters',
 'bc|disable modal;ta|disable requires;ta|database failure',
 'ta|last manager cannot;ta|an old pending Auth',
 'bp|quick add;t|quick task defaults',
 'bp|manager assigns;c|assignment and manager',
 'bp|full form;t|validation rejects',
 't|self task edits',
 't|assigned task permits;bp|assigned employee sees',
 't|self task edits;t|history has safe',
 't|manager assigns;c|assignment and manager',
 't|completion/undo;au|Friday/waiting;bc|comment create',
 'bp|complete and undo;t|no-op move',
 'bp|complete and undo;t|completion/undo',
 'bp|cancellation requires;t|assigned task cannot',
 'bp|cancellation requires;t|completion/undo',
 'bp|drag and drop;t|future reschedule',
 'bp|moving long task;t|move shifts',
 't|long task is visible;au|long recurring intervals',
 'au|daily/workday;au|monthly rule;bc|recurrence full form',
 'au|only-this exception;bc|one-instance edit',
 'au|schedule revisions;bc|one-instance edit;bc|series conflict',
 'au|stopping removes;bc|stop recurrence',
 'au|Friday/waiting;au|a manually planned;au|done/cancelled',
 'au|missed runs;au|maintenance failure',
 'bp|delete and bin;t|delete hides',
 'bp|delete and bin;t|delete hides',
 'bp|filters/search;t|status/search',
 'bp|past navigation;bp|calendar and modal',
 'bp|overdue collection;t|empty and cancelled',
 'bc|comment create;c|comment recipients;c|comment validation',
 'bc|comment create;c|comment edits;c|deleted text',
 'bp|history shows;c|deleted text;t|history has safe',
 'bc|notification opening;bc|notification unread;c|notification list',
 'c|deadline changes',
 'br|reports only;r|TZ JSON;r|metric filters',
 'br|TZ fixture;br|colleague changes;r|pagination exceeds',
 'br|real browser PPTX;br|pagination and long;br|typical 500',
 'br|PNG is actual;br|clipboard fallback',
 'bp|conflicting task;bc|conflict application;t|stale edit',
 'bp|unknown result;bp|form network;bc|comment draft',
 'a|anonymous cannot;a|outsider gets;a|disabling a member',
 't|assigned task permits;t|manager assigns',
 'bc|lost socket;bc|visible-tab fallback'
];
const AC=[
 'bp|manager assigns;p|actual task and history',
 't|manager assigns;t|assigned task permits;t|self task edits',
 'a|migrations create;t|terminal task is read-only;a|an active member',
 'ta|invitation intent;ta|delivery failure;ba|invitation password',
 'ta|disable requires;ta|database failure;bc|disable modal',
 't|operation id replay;bp|unknown result;t|quick task defaults',
 't|validation rejects;a|empty and overlong;bp|form network',
 't|status/search;br|reports only;r|metric filters',
 't|status/search;bp|filters/search',
 'bp|drag and drop;bp|moving long task;t|future reschedule',
 'au|Friday/waiting',
 'au|a manually planned',
 'au|done/cancelled',
 'au|missed runs;au|maintenance failure',
 't|long task is visible;t|move shifts;au|long recurring',
 'au|monthly rule;au|daily/workday',
 'au|daily/workday;au|only-this exception',
 'au|schedule revisions;au|only-this exception;au|stopping removes',
 'r|reopening in another;t|completion/undo',
 't|delete hides;bp|delete and bin',
 't|late cancellation;r|closed periods;r|a revoked cancellation',
 'c|comment edits;c|deleted text;bc|comment draft',
 'c|deadline changes',
 't|stale edit;bp|conflicting task;bc|conflict application',
 't|operation id replay;bp|unknown result;bc|comment draft',
 't|closed day;r|closed periods',
 'r|snapshots and exported;br|colleague changes',
 'br|real browser PPTX;br|pagination and long',
 'br|PNG is actual',
 'bv|200% layout;bp|calendar and modal;bc|team, comments',
 'bv|task titles;ba|stored malicious;bc|comment create',
 'bv|clearing only;p|actual task and history',
 'bv|release works',
 'r|empty/future;t|empty and cancelled',
 'r|TZ JSON;br|TZ fixture',
 'c|comment validation;r|report user/team;ta|invitation counters;t|operation id replay',
 'br|pagination and long;br|layout splits;br|PNG is actual',
 'bc|lost socket;bc|visible-tab fallback',
 'bp|overdue collection;t|empty and cancelled'
];
export async function acceptanceRows(){
 if(UC.length!==48||AC.length!==39)throw new Error('Неполный каталог UC/AC');
 const spec=await readFile('tz.md','utf8'),rows=[];
 for(const [kind,list] of Object.entries({UC,AC}))for(let i=0;i<list.length;i++){
  const id=kind+'-'+String(i+1).padStart(2,'0'),source=spec.split('\n').find(l=>l.startsWith('| '+id+' |'));if(!source)throw new Error('В ТЗ отсутствует '+id);
  const references=[];for(const text of list[i].split(';')){const [alias,prefix]=text.split('|'),path=files[alias];if(!path)throw new Error('Нет файла '+alias);
   const code=await readFile(path,'utf8'),found=[...code.matchAll(/test\('((?:[^'\\]|\\.)*)'/g)].filter(m=>m[1].startsWith(prefix));if(found.length!==1)throw new Error(`${id}: неоднозначная/несуществующая проверка ${text}`);
   references.push({path,title:found[0][1],line:code.slice(0,found[0].index).split('\n').length});
  }
  let pending='SQL/RLS основных операций проверены в настоящем Supabase (20 проверок); настоящие JWT/PostgREST руководителя и Edge проверены; вход сотрудника подтверждён пользователем; автоматическая проверка его интерфейса и совместная работа браузеров остаются открытыми.';
  if((kind==='UC'&&[1,3,5,6].includes(i+1))||(kind==='AC'&&i+1===4))pending='Только почтовый режим: реальные SMTP, получение письма и одноразовая ссылка. В текущем режиме выключено по ТЗ 1.2.';
  if(kind==='AC'&&[17,24].includes(i+1))pending='Соревнование независимых соединений PostgreSQL: локальный PGlite сериализует запросы.';
  if(kind==='AC'&&i+1===28)pending='Открытие и редактирование непосредственно в PowerPoint / Google Презентациях.';
  if(kind==='AC'&&i+1===29)pending='Вставка PNG в настоящую презентацию; удобство оценивает пользователь.';
  if(kind==='AC'&&i+1===30)pending='Нативные Safari/iOS/Android, предыдущие основные версии, реальный браузерный масштаб и визуальная оценка.';
  if(kind==='AC'&&i+1===33)pending='Опубликованный HTTPS-адрес и действительная ссылка Auth на GitHub Pages.';
  rows.push({id,requirement:source.split('|')[3].trim(),references,pending});
 }
 return rows;
}
export async function writeAcceptance(){const rows=await acceptanceRows();
 const header='# Протокол сверки с ТЗ «Ритм»\n\nДата: 2 ноября 2026 года. Основание: tz.md 1.3, исходные 48 UC и 39 AC. Дополнение раздела 22 проверяется отдельно в QA.md.\n\nЭто карта конкретных автотестов и незакрытых внешних проверок. Наличие теста не равно успешному прогону: актуальные результаты и среда указаны в QA.md. Локальные SQL, Auth-адаптер и WebSocket не заменяют облачную приёмку. Полный выпуск не принят до закрытия внешних пунктов.\n\n';
 let text=header+'Текущий режим без почты дополнительно проверяется сценариями no-email login и no-email two-person team в tests/browser/acceptance.spec.mjs, no-email mode в tests/edge-admin.test.mjs и email delivery is off в tests/release.test.mjs. Почтовые сценарии запускаются в тестах с явным включением emailDeliveryEnabled=true и не означают наличие SMTP в рабочем выпуске.\n\n';for(const kind of ['UC','AC']){text+=`## ${kind==='UC'?'Сценарии использования':'Критерии приёмки'}\n\n| ID | Условие ТЗ | Конкретная локальная проверка | Что ещё не подтверждено |\n| --- | --- | --- | --- |\n`;
  for(const r of rows.filter(r=>r.id.startsWith(kind)))text+=`| ${r.id} | ${r.requirement} | ${r.references.map(v=>`[${v.title}](${v.path}#L${v.line})`).join('; ')} | ${r.pending} |\n`;text+='\n';
 }
 text+='## Расхождения и порядок завершения\n\n1. Supabase создан, публичный ключ проверен, 13 базовых миграций применены в пустой базе, затем установлена миграция 014; новое недельное RPC проверено под обеими SQL-ролями с откатом, задание 17:45 активно. RLS и базовые запреты анонимного доступа проверены. Рабочая команда из двух подтверждённых аккаунтов создана; 20 SQL/RLS проверок на настоящем PostgreSQL пройдены с откатом. JWT-сессия руководителя, Edge, календарь, отчёт и скачивание рабочего PPTX проверены. Вход сотрудника подтверждён пользователем; автоматическая проверка его интерфейса, совместная работа двух браузеров и наблюдение исполнения Cron ещё требуются. Edge развернута, вход закрыт для самостоятельной регистрации; базовые реальные проверки отказа выполнены. Публичные URL/ключ не заменяют административное развёртывание.\n2. GitHub Pages опубликован из main/docs: HTTPS-страница отвечает 200, все три файла совпадают со сборкой, экран входа проверен. Исходники первоначального выпуска загружены и сверены; вход руководителя проверен, вход сотрудника подтверждён пользователем, автоматическая проверка его интерфейса открыта.\n3. Полные нативные версии браузеров и физические устройства не подтверждены. Тестовый WebKit не является Safari на настоящем iPhone.\n4. Импорт PPTX в Google Презентации / PowerPoint не подтверждён. OOXML, редактируемые объекты и независимая отрисовка проверяются отдельно.\n5. Производительность 10 000 задач / 100 000 событий на прогретом настоящем облаке, p95 и задержка Realtime/Cron остаются открытыми. Локальный контрольный замер приведён в QA.md и не считается облачным SLA.\n6. npm audit: транзитивные предупреждения image-size / PptxGenJS описаны в QA.md. Закреплённая в ТЗ версия не подменяется без пересмотра зависимостей и проверки формата.\n\nОбязательные функции реализованы в коде и имеют перечисленные проверки. Отдельно перечисленные внешние условия пока не позволяют признать продукт полностью соответствующим ТЗ. Исправления совместимости и производительности записываются в истории plan.md, итоговые прогоны — в QA.md. По уточнению пользователя текущий запуск — два человека без SMTP; почтовые UC/AC условны (ТЗ 1.2). Согласованное дополнение ТЗ 1.3 (раздел 22): недельная личная динамика и поддерживающие итоги. Его SQL- и браузерные проверки находятся в tests/daily-support.test.mjs и tests/browser/daily-support.spec.mjs; результаты и статус облачного выпуска — в QA.md и plan.md.\n';
 await writeFile('ACCEPTANCE.md',text);return rows;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{const rows=await writeAcceptance();console.log(`ACCEPTANCE.md: ${rows.length} строк, все ссылки на тесты проверены.`);}catch(e){console.error(e.message);process.exitCode=1;}}
