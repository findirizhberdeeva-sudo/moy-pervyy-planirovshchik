/* Ритм. Публичные параметры проекта; административные ключи остаются только в Edge Function. */
(() => {
  'use strict';
  // Config: fill only after a real Supabase project has been created.
  const Config = Object.freeze({
    supabaseUrl: "https://mganffnshbhmtnhxacqi.supabase.co",
    publishableKey: "sb_publishable_P0fr9FR35L_EZWZ6W6jAdg_oeNwXf8l",
    appBaseUrl: "https://findirizhberdeeva-sudo.github.io/moy-pervyy-planirovshchik/",
    emailDeliveryEnabled: false,
    sdkUrl: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js'
  });
  const root = document.getElementById('app');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const State = {
    view:'login', context:null, client:null, busy:false, signingOut:false, errors:{}, message:null,
    flow:null, generation:0, connectionLost:false, storagePersistent:true,
    drafts:{email:'',password:'',new_password:'',confirm_password:'',display_name:null,profile_password:'',profile_confirm:''},
    pendingProfile:null, profileConflict:null, profileVersion:null, navigation:null, watch:null, authSubscription:null
  };
  const Dates = { label(value) { return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',weekday:'long',day:'numeric',month:'long'}).format(new Date(value || Date.now())); } };
  const localMemory = new Map();
  const storage = {
    getItem(key) { try { return localStorage.getItem(key); } catch { State.storagePersistent=false; return localMemory.get(key) ?? null; } },
    setItem(key,value) { try { localStorage.setItem(key,value); } catch { State.storagePersistent=false; localMemory.set(key,value); } },
    removeItem(key) { try { localStorage.removeItem(key); } catch {} localMemory.delete(key); }
  };
  const flowStorage = {
    get() { try { const v=sessionStorage.getItem('ritm:auth-flow'); return ['invite','recovery'].includes(v)?v:null; } catch { return null; } },
    set(value) { try { value?sessionStorage.setItem('ritm:auth-flow',value):sessionStorage.removeItem('ritm:auth-flow'); } catch {} }
  };
  function configValid() {
    try {
      const url=new URL(Config.supabaseUrl);
      if (!(url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) return false;
      if (url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) return false;
      if (Config.publishableKey.startsWith('sb_publishable_') && Config.publishableKey.length>=25) return true;
      const payload=JSON.parse(atob(Config.publishableKey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      return payload.role==='anon';
    } catch { return false; }
  }
  function redirectUrl() {
    const url=Config.appBaseUrl?new URL(Config.appBaseUrl):new URL('./',location.href);
    if (url.origin!==location.origin) throw new Error('INVALID_APP_BASE_URL');
    url.search=''; url.hash=''; return url.href;
  }
  const authKey = () => `ritm-auth:${new URL(Config.supabaseUrl).hostname}`;
  class AppError extends Error {
    constructor(code,message,details={}) { super(message); this.code=code; Object.assign(this,details); }
  }
  function normalizeError(error,context='general') {
    if(error instanceof AppError) {
      if(error.code==='RATE_LIMITED' && error.retry_after_seconds) error.message=`Слишком много запросов. Повторите через ${Math.max(1,error.retry_after_seconds)} секунд.`;
      return error;
    }
    if (error?.status===429 || error?.code==='over_request_rate_limit' || error?.code==='over_email_send_rate_limit') return new AppError('RATE_LIMITED','Слишком много запросов. Повторите через 60 секунд.');
    if (!navigator.onLine || error?.name==='AbortError' || /fetch|network|timeout|load failed/i.test(error?.name+' '+error?.message)) {
      State.connectionLost=true; return new AppError('NETWORK_ERROR','Не удалось связаться с планировщиком. Проверьте соединение и повторите.');
    }
    if(context==='login') return new AppError('INVALID_CREDENTIALS','Не удалось войти. Проверьте почту и пароль.');
    if(context==='link') return new AppError('INVALID_LINK','Ссылка недействительна или срок её действия истёк. Запросите новую ссылку.');
    if(error?.code==='reauthentication_needed' || error?.code==='reauthentication_not_valid') return new AppError('REAUTHENTICATE','Для смены пароля войдите в аккаунт ещё раз.');
    if(error?.code==='weak_password') return new AppError('WEAK_PASSWORD','Используйте пароль не короче 12 символов.');
    return new AppError('SERVICE_ERROR','Не удалось выполнить действие. Повторите попытку.');
  }
  let sdkPromise;
  const Api = {
    async initialize() {
      if(!configValid()) throw new AppError('NOT_CONFIGURED','Планировщик ещё не подключён.');
      if(!window.supabase?.createClient) {
        sdkPromise ||= new Promise((resolve,reject)=>{
          const script=document.createElement('script'); script.src=Config.sdkUrl; script.referrerPolicy='no-referrer';
          const timer=setTimeout(()=>{script.remove(); reject(new AppError('SDK_UNAVAILABLE','Не удалось загрузить подключение. Проверьте соединение.'));},15000);
          script.onload=()=>{clearTimeout(timer); resolve();};
          script.onerror=()=>{clearTimeout(timer); script.remove(); reject(new AppError('SDK_UNAVAILABLE','Не удалось загрузить подключение. Проверьте соединение.'));};
          document.head.append(script);
        }).catch(error=>{sdkPromise=null; throw error;});
        await sdkPromise;
      }
      if(!State.client) State.client=window.supabase.createClient(Config.supabaseUrl,Config.publishableKey,{
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storage,storageKey:authKey()},
        global:{fetch:(url,options={})=>fetch(url,{...options,signal:options.signal || AbortSignal.timeout(15000)})}
      });
      return State.client;
    },
    async rpc(name,parameters={}) {
      if(!navigator.onLine) throw normalizeError(new TypeError('network offline'));
      const {data,error}=await State.client.rpc(name,parameters);
      if(error) {
        if(error.status===401 || ['PGRST301','PGRST303'].includes(error.code)) throw new AppError('UNAUTHENTICATED','Сессия истекла. Войдите снова.');
        throw normalizeError(error);
      }
      if(!data?.ok) throw new AppError(data?.error?.code || 'SERVICE_ERROR',data?.error?.message || 'Не удалось выполнить действие.',data?.error || {});
      if(['mutate_task','mutate_series'].includes(name))Daily.invalidate();
      State.serverTime=data.meta?.server_time;State.serverTimeReceived=Date.now();State.connectionLost=false; return data.data;
    },
    async admin(action,payload={},version=null,operation=null) {
      if(!navigator.onLine)throw normalizeError(new TypeError('network offline'));
      const {data:session}=await State.client.auth.getSession();if(!session?.session)throw new AppError('UNAUTHENTICATED','Войдите снова.');
      const response=await fetch(Config.supabaseUrl+'/functions/v1/team-admin',{method:'POST',headers:{'Content-Type':'application/json',apikey:Config.publishableKey,Authorization:'Bearer '+session.session.access_token},
        body:JSON.stringify({team_id:State.context.team.id,action,payload,expected_version:version,operation_id:operation}),signal:AbortSignal.timeout(15000)});
      let result;try{result=await response.json();}catch{throw normalizeError(new TypeError('network response unavailable'));}
      if(!result?.ok)throw new AppError(result?.error?.code||'SERVICE_ERROR',result?.error?.message||'Не удалось выполнить действие.',result?.error||{});
      State.serverTime=result.meta?.server_time;State.serverTimeReceived=Date.now();State.connectionLost=false;return result.data;
    },
    async access() {
      const {data,error}=await State.client.auth.getUser();
      if(error || !data?.user) {
        if(error?.status===401 || error?.status===403 || !error) throw new AppError('UNAUTHENTICATED','Сессия истекла. Войдите снова.');
        throw normalizeError(error);
      }
      return Api.rpc('get_access_context');
    },
    async logout() {
      State.signingOut=true;State.busy=true;
      State.generation++; Sync.stop();Team.clear();Comments.clear();Notifications.clear();Work.pending={};Planner.clear(); clearInterval(State.watch); State.watch=null;
      State.context=null; State.flow=null; flowStorage.set(null); State.profileConflict=null;
      State.pendingProfile=null; State.navigation=null;
      State.drafts={email:'',password:'',new_password:'',confirm_password:'',display_name:null,profile_password:'',profile_confirm:''};
      const client=State.client; State.authSubscription?.unsubscribe(); State.authSubscription=null;
      Views.render();
      if(client) {
        client.auth.stopAutoRefresh();
        try { await client.removeAllChannels();await client.auth.signOut({scope:'local'}); } catch {}
      }
      storage.removeItem(authKey()); storage.removeItem(authKey()+'-code-verifier'); storage.removeItem(authKey()+'-user');
      State.client=null; State.view='login'; State.errors={}; State.message=null; State.busy=false;State.signingOut=false; Views.render();
    }
  };

  // Views: user-provided strings are always escaped; the DOM never renders raw HTML from the API.
  const brand = () => `<div class="brand"><span class="brand-mark" aria-hidden="true">р</span><span><span class="brand-name">Ритм</span><span class="brand-subtitle">Командный планировщик</span></span></div>`;
  const notice = (message=State.message) => message?`<div class="notice notice-${escape(message.type||'error')}" role="${message.type==='error'?'alert':'status'}">${escape(message.text)}${message.action==='show-mine'?'<button class="button-link" data-action="planner-mine">Показать мои</button>':''}</div>`:'';
  const eye = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>`;
  function field(name,label,{type='text',value='',hint='',autocomplete='',readonly=false,maxlength}={}) {
    const error=State.errors[name], id=`field-${name}`;
    const input=`<input id="${id}" name="${name}" type="${type}" value="${escape(value)}" ${autocomplete?`autocomplete="${autocomplete}"`:''} ${readonly?'readonly':'required'} ${maxlength?`maxlength="${maxlength}"`:''} ${name==='email'?'inputmode="email" autocapitalize="none" spellcheck="false"':''} aria-invalid="${!!error}" aria-describedby="${id}-hint ${id}-error">`;
    return `<div class="field"><label for="${id}">${label}</label>${type==='password'?`<div class="password-wrap">${input}<button class="password-toggle" type="button" data-action="toggle-password" data-target="${id}" aria-label="Показать пароль" aria-controls="${id}" aria-pressed="false">${eye}</button></div>`:input}<p class="field-hint" id="${id}-hint">${escape(hint)}</p><span class="field-error" id="${id}-error">${escape(error || '')}</span></div>`;
  }
  const submit = (text,busyText) => `<button class="button button-primary button-full" type="submit" ${State.busy || !configValid()?'disabled':''}>${State.busy?busyText:text}</button>`;
  const Views = {
    render() {
      root.setAttribute('aria-busy',String(State.busy));
      root.innerHTML=State.context && !State.flow?Views.workspace():Views.auth();
      const heading=root.querySelector('main h1,main h2');
      document.title=State.context && State.view==='profile'?'Профиль — Ритм':'Ритм — командный планировщик';
      if(State.connectionLost || !navigator.onLine) Views.network();
      Planner.afterRender();
      Daily.afterRender();
      const reportDialog=document.getElementById('report-dialog');if(reportDialog&&!reportDialog.open)reportDialog.showModal();
      if(State.navigation)document.getElementById('discard-dialog')?.showModal();
      if(State.errors && Object.keys(State.errors).length) requestAnimationFrame(()=>root.querySelector('[aria-invalid="true"]')?.focus());
      else if(heading) heading.setAttribute('tabindex','-1');
      if(State.context&&!State.busy)queueMicrotask(()=>Daily.maybeShow());
    },
    network() {
      let banner=document.getElementById('network-banner');
      if(State.connectionLost || !navigator.onLine) {
        if(!banner) { banner=document.createElement('div'); banner.id='network-banner'; banner.className='network-banner'; banner.setAttribute('role','status'); root.prepend(banner); }
        banner.textContent='Нет связи. Данные могут быть устаревшими.';
      } else banner?.remove();
    },
    auth() {
      if(State.signingOut)return '<main id="main" class="loading-page"><span class="brand-mark" aria-hidden="true">р</span><p role="status">Завершаем сессию…</p></main>';
      let content;
      if(State.view==='blocked') content=`<p class="card-kicker">Доступ к команде</p><h2>Не удалось открыть пространство</h2><p class="lead">Доступ предоставляется руководителем команды.</p>${notice()}<button class="button button-primary button-full" data-action="logout">Вернуться ко входу</button>`;
      else if(State.flow) content=`<p class="card-kicker">${State.flow==='invite'?'Добро пожаловать в команду':'Восстановление доступа'}</p><h2>Установите пароль</h2><p class="lead">Придумайте пароль для вашего аккаунта. После сохранения откроется командное пространство.</p>${notice()}<form class="form" data-form="set-password" novalidate>${field('new_password','Новый пароль',{type:'password',value:State.drafts.new_password,autocomplete:'new-password',hint:'Не менее 12 символов.'})}${field('confirm_password','Повторите пароль',{type:'password',value:State.drafts.confirm_password,autocomplete:'new-password'})}${submit('Сохранить пароль','Сохраняем…')}<button class="button-link" type="button" data-action="logout">Вернуться ко входу</button></form>`;
      else if(State.view==='recovery') content=`<p class="card-kicker">Восстановление доступа</p><h2>Забыли пароль?</h2><p class="lead">Введите почту, которую указали при подключении к команде.</p>${notice()}<form class="form" data-form="recovery" novalidate>${field('email','Электронная почта',{type:'email',value:State.drafts.email,autocomplete:'email'})}${submit('Отправить ссылку','Отправляем…')}<button class="button-link" type="button" data-action="login-view">Вернуться ко входу</button></form>`;
      else content=`<p class="card-kicker">Ваше рабочее пространство</p><h2>Добро пожаловать</h2><p class="lead">Войдите, чтобы продолжить работу с командой.</p>${notice()}<form class="form" data-form="login" novalidate>${field('email','Электронная почта',{type:'email',value:State.drafts.email,autocomplete:'username'})}${field('password','Пароль',{type:'password',value:State.drafts.password,autocomplete:'current-password'})}<div class="form-meta">${Config.emailDeliveryEnabled?'<button class="button-link" type="button" data-action="recovery-view">Забыли пароль?</button>':'<p class="field-hint">Если забыли пароль, обратитесь к руководителю.</p>'}</div>${submit('Войти в Ритм','Входим…')}</form><div class="auth-bottom">Первый раз здесь?<br><strong>${Config.emailDeliveryEnabled?'Попросите руководителя пригласить вас в команду.':'Получите логин и пароль у владельца планировщика.'}</strong></div>`;
      if(!configValid()) content=`<div class="notice notice-warning" role="status"><strong>Планировщик ещё не подключён</strong>Руководитель готовит общее пространство. Вход станет доступен после подключения.<br><button class="button-link" data-action="retry">Проверить подключение</button></div>`+content;
      return `<div class="auth-shell"><aside class="intro" aria-label="Ритм">${brand()}<div class="intro-body"><div class="eyebrow">В своём ритме</div><h1>Ясный план.<br><span>Спокойный день.</span></h1><p class="intro-copy">Рабочие задачи и движение к результату — в одном пространстве для вашей команды.</p><div class="rhythm" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div><div class="intro-footer"><span>День · Неделя · Месяц</span><span>Ритм</span></div></aside><main class="auth-content" id="main"><div class="auth-card"><div class="mobile-brand">${brand()}</div>${content}</div></main></div>`;
    },
    workspace() {
      const c=State.context,m=c.member;
      const initials=m.display_name.split(/\s+/).slice(0,2).map(v=>v[0]).join('').toUpperCase();
      const header=`<header class="app-header">${brand()}<nav class="workspace-nav" aria-label="Разделы"><button class="button-link ${State.view==='home'?'active':''}" data-action="home-view" ${State.busy?'disabled':''}>План</button><button class="button-link ${State.view==='reports'?'active':''}" data-action="report-open" ${State.busy?'disabled':''}>Итоги</button>${m.role==='manager'?`<button class="button-link ${State.view==='team'?'active':''}" data-action="team-view" ${State.busy?'disabled':''}>Команда</button>`:''}</nav><div class="header-actions"><span class="team-pill">${escape(c.team.name)}</span><button class="notification-bell" data-action="work-notifications" aria-label="Уведомления: ${Notifications.unread}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" stroke-linecap="round" stroke-linejoin="round"/></svg>${Notifications.unread?`<b>${Notifications.unread}</b>`:''}</button><button class="profile-button" data-action="profile-view" ${State.busy?'disabled':''} aria-label="Открыть профиль"><span class="avatar" aria-hidden="true">${escape(initials)}</span><span class="profile-label">${escape(m.display_name)}</span></button><button class="button-link" data-action="logout" ${State.busy?'disabled':''}>Выйти</button></div></header>`;
      const storageNotice=State.storagePersistent?'':`<div class="notice notice-warning" role="status">Браузер не сохраняет вход. После закрытия страницы потребуется войти снова.</div>`;
      let body;
      if(State.view==='profile') {
        const conflict=State.profileConflict?`<div class="notice notice-warning" role="alert">Актуальное имя: ${escape(State.profileConflict.display_name)}.<div class="form-actions"><button type="button" class="button-link" data-action="reload-profile">Загрузить актуальное</button><button type="button" class="button-link" data-action="retry-profile">Применить моё имя после проверки</button></div></div>`:'';
        body=`<button class="button-link back-link" data-action="home-view">← В пространство</button><h1>Ваш профиль</h1><p class="workspace-lead">Личные данные и доступ к аккаунту.</p>${storageNotice}${notice()}${conflict}<div class="profile-grid"><section class="panel" aria-labelledby="personal-title"><h2 id="personal-title">Личные данные</h2><p class="lead">Имя будет видно коллегам в задачах и комментариях.</p><form class="form" data-form="profile" novalidate>${field('display_name','Отображаемое имя',{value:State.drafts.display_name ?? m.display_name,maxlength:80,autocomplete:'name'})}${field('account_email','Электронная почта',{value:c.user.email,readonly:true,hint:Config.emailDeliveryEnabled?'Почта используется для входа и восстановления доступа.':'Email используется только как логин.'})}<p class="field-hint">Роль: ${m.role==='manager'?'Руководитель':'Сотрудник'}</p><div class="form-actions"><button class="button button-primary" type="submit" ${State.busy?'disabled':''}>${State.busy?'Сохраняем…':'Сохранить имя'}</button><button class="button button-secondary" type="button" data-action="home-view" ${State.busy?'disabled':''}>Закрыть</button></div></form></section><section class="panel" aria-labelledby="password-title"><h2 id="password-title">Сменить пароль</h2><p class="lead">Используйте пароль, который не применяете в других сервисах.</p><form class="form" data-form="profile-password" novalidate>${field('profile_password','Новый пароль',{type:'password',value:State.drafts.profile_password,autocomplete:'new-password',hint:'Не менее 12 символов.'})}${field('profile_confirm','Повторите пароль',{type:'password',value:State.drafts.profile_confirm,autocomplete:'new-password'})}<button class="button button-secondary" type="submit" ${State.busy?'disabled':''}>Сохранить пароль</button></form></section></div>`;
      } else if(State.view==='reports')body=`${storageNotice}${notice()}${Reports.render()}`;
      else if(State.view==='team')body=`${storageNotice}${notice()}${Team.render()}`;
      else body=`${storageNotice}${notice()}${Sync.live?'':'<p class="sync-note" role="status">Изменения проверяются каждую минуту.</p>'}${Planner.render()}`;
      return `${header}<main class="workspace ${State.view==='reports'?'reports-workspace':''} ${['profile','team'].includes(State.view)?'':'planner-workspace'}" id="main">${Daily.renderBanner()}${body}<p class="screen-footer">Ритм · Командное пространство</p></main>${Planner.renderModal()}${Reports.renderModal()}<dialog id="discard-dialog" aria-labelledby="discard-title"><h2 id="discard-title">Изменения ещё не сохранены</h2><p>Закрыть форму без сохранения?</p><div class="form-actions"><button class="button button-primary" data-action="stay">Остаться</button><button class="button button-secondary" data-action="confirm-discard">Закрыть без сохранения</button></div></dialog>`;
    }
  };

  // Planner: UI commands and rendering. Business state, permissions and progress come from SQL.
  const Statuses={planned:'В плане',in_progress:'В работе',waiting:'Ожидает ответа',done:'Выполнено',cancelled:'Отменено'};
  function taskStatusBadges(task){
    const overdue=task.overdue&&['planned','in_progress','waiting'].includes(task.status);
    return `<span class="status-pill status-${task.status}">${Statuses[task.status]}</span>${overdue?'<span class="status-pill status-overdue">Просрочено</span>':''}`;
  }
  function refreshTaskDateHints(){
    const hint=root.querySelector('.result-date-hint strong');
    if(!hint||!P.form)return false;
    const date=P.form.deadline||P.form.plan_end||P.form.plan_start;
    hint.textContent=Number.isNaN(Date.parse(date+'T12:00:00Z'))?'Уточните дату':Calendar.format(date);
    const visibility=root.querySelector('.task-visibility-hint');
    if(visibility)visibility.textContent=taskVisibilityHint(P.form.deadline);
    const warning=root.querySelector('.task-date-warning');
    if(warning)warning.hidden=!(P.form.deadline&&(P.form.deadline<P.form.plan_start||P.form.deadline<P.data.today));
    return true;
  }
  function taskVisibilityHint(deadline){return deadline?'Задача видна с даты работы по срок сдачи включительно, каждый календарный день. После срока остаётся в текущем дне до выполнения.':'Без срока сдачи задача показывается в дни работы; незавершённая переносится на следующий рабочий день.';}
  const Directions={all:'Все направления',sto:'СТО',dbk:'ДБК',rental:'ПРОКАТ',uk:'УК',none:'Без направления'};
  const Priorities={important_urgent:'Важная и срочная',important_not_urgent:'Важная и несрочная',not_important_urgent:'Неважная и срочная',not_important_not_urgent:'Неважная и несрочная',unset:'Приоритет не задан'};
  function progressColor(percent){
    if(percent===null)return 'var(--muted)';
    const ratio=Math.max(0,Math.min(100,Number(percent)||0))/100;
    return `rgb(${[173,79,112].map((value,i)=>Math.round(value+([61,116,78][i]-value)*ratio)).join(',')})`;
  }
  const Calendar={
    add(date,days){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);},
    month(date,delta){const d=new Date(date+'T12:00:00Z'),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+delta);const end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,end));return d.toISOString().slice(0,10);},
    format(date,options={day:'numeric',month:'long'}){return new Intl.DateTimeFormat('ru-RU',{...options,timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));},
    weekend(date){return [0,6].includes(new Date(date+'T12:00:00Z').getUTCDay());},
    nextWork(date){let d=Calendar.add(date,1);while(Calendar.weekend(d))d=Calendar.add(d,1);return d;},
    valid(date){try{return typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&date>='2000-01-01'&&date<='2100-12-31'&&Calendar.add(date,0)===date;}catch{return false;}},
    workdays(today){const days=[];for(let date=today;days.length<5&&date<='2100-12-31';date=Calendar.add(date,1))if(!Calendar.weekend(date))days.push(date);return days;}
  };
  const P={date:null,data:null,filters:null,loading:false,sequence:0,quick:'',modal:null,form:null,errors:{},pending:null,undo:null,
    history:[],historyCursor:null,tab:'detail',collection:null,collectionCursor:null,detailsOpen:{},focusModal:false,searchTimer:null,loadingModal:false,targetDate:null,dateFocusId:null,dateError:''};
  // Snapshot native text before replacing the DOM, even if its input event is pending.
  // Owner/revision guards keep an intentional reload or reset from reviving old text.
  const NativeDrafts=new WeakMap();
  function captureNativeDraft(el=document.activeElement){
    if(!el?.isConnected)return;const binding=NativeDrafts.get(el);if(!binding)return;
    if(binding.form&&binding.form===P.form)P.form[binding.field]=el.value;
    else if(binding.comment&&binding.revision===Comments.draftRevision&&binding.task===P.modal?.task?.id)Comments.draft=el.value;
  }
  function bindNativeDrafts(){
    if(P.form)root.querySelectorAll('textarea[data-task-field],input[type="text"][data-task-field]').forEach(el=>NativeDrafts.set(el,{form:P.form,field:el.dataset.taskField}));
    const comment=document.getElementById('comment-draft');if(comment)NativeDrafts.set(comment,{comment:true,revision:Comments.draftRevision,task:P.modal?.task?.id});
  }
  // Keep the pressed node alive through pointerup/click. Access revocation still
  // renders immediately through Views.render; only ordinary planner redraws wait.
  const RenderInteraction={pointers:new Set(),dragging:false,settling:false,pending:null,timer:null,
    hold(event){captureNativeDraft();if(!root.contains(event.target))return;clearTimeout(RenderInteraction.timer);RenderInteraction.settling=false;RenderInteraction.pointers.add(event.pointerId);},
    release(event){RenderInteraction.pointers.delete(event.pointerId);RenderInteraction.flushSoon();},
    flushSoon(){RenderInteraction.settling=true;clearTimeout(RenderInteraction.timer);RenderInteraction.timer=setTimeout(()=>{if(RenderInteraction.pointers.size||RenderInteraction.dragging)return;RenderInteraction.settling=false;const focus=RenderInteraction.pending;RenderInteraction.pending=null;if(focus!==null)plannerRender(focus);},0);}
  };
  function plannerRender(focus=true){
    captureNativeDraft();
    const active=document.activeElement;
    const editingDate=active?.id==='planner-selected-date'&&!P.targetDate&&active.value!==P.date;
    if(RenderInteraction.pointers.size||RenderInteraction.dragging||RenderInteraction.settling||editingDate){RenderInteraction.pending=focus;return;}
    RenderInteraction.pending=null;
    const id=active?.id, start=active?.selectionStart,end=active?.selectionEnd;
    Views.render();
    bindNativeDrafts();
    // Restore before returning control: a delayed callback could steal the next field's focus.
    if(focus && id && !Daily.banner && !Object.keys(P.errors).length){const el=document.getElementById(id);if(el){el.focus({preventScroll:true});if(el.setSelectionRange && typeof start==='number' && !['date','email','number'].includes(el.type))try{el.setSelectionRange(start,end);}catch{}}}
  }
  const Planner={
    clear(){Daily.clear();Reports.clear();P.sequence++;P.data=null;P.modal=null;P.form=null;P.undo=null;P.quick='';P.pending=null;P.history=[];P.historyCursor=null;P.collectionCursor=null;P.collection=null;P.errors={};P.loading=false;P.loadingModal=false;P.targetDate=null;P.dateFocusId=null;P.dateError='';P.tab='detail';clearTimeout(P.searchTimer);},
    defaults(){return {employee_id:State.context.member.role==='manager'?null:State.context.user.id,direction:'all',statuses:['planned','in_progress','waiting'],priorities:[],deadline_filter:'all',query:'',group_by:'list'};},
    key(){return `ritm:planner:v1:${State.context.team.id}:${State.context.user.id}`;},
    save(){if(State.context&&P.filters)storage.setItem(Planner.key(),JSON.stringify({...P.filters,query:''}));},
    async init(){
      P.sequence++;P.date=null;P.data=null;P.modal=null;P.form=null;P.quick='';P.undo=null;P.pending=null;P.targetDate=null;P.dateFocusId=null;P.dateError='';P.filters=Planner.defaults();
      try{const saved=JSON.parse(storage.getItem(Planner.key()));if(saved&&typeof saved==='object')for(const k of Object.keys(P.filters))if(k!=='query'&&Object.hasOwn(saved,k))P.filters[k]=saved[k];}catch{}
      await Planner.load({initial:true});
    },
    async load({initial=false,append=false,render=true,selectedDate=P.targetDate||P.date}={}){
      if(!State.context)return;const seq=++P.sequence,generation=State.generation;P.loading=true;
      try{
        const result=await Api.rpc('get_planner',{p_team_id:State.context.team.id,p_selected_date:selectedDate,p_filters:P.filters,p_cursor:append?P.data?.next_cursor:null});
        if(seq!==P.sequence||generation!==State.generation||!State.context)return;
        if(append&&P.data)result.day_tasks=[...new Map([...P.data.day_tasks,...result.day_tasks].map(t=>[t.id,t])).values()];
        if(result.selected_date!==P.date)P.detailsOpen={};P.data=result;P.date=result.selected_date;P.targetDate=null;P.loading=false;if(render)plannerRender();void Daily.load();
      }catch(error){
        if(seq!==P.sequence||generation!==State.generation||!State.context)return;P.targetDate=null;P.loading=false;error=normalizeError(error);
        if(initial&&['VALIDATION_ERROR','ACCESS_DENIED'].includes(error.code)){try{await Api.access();P.filters=Planner.defaults();Planner.save();return Planner.load();}catch{}}
        if(['ACCESS_DENIED','UNAUTHENTICATED'].includes(error.code)){State.context=null;State.view=error.code==='ACCESS_DENIED'?'blocked':'login';P.data=null;}
        setMessage(error.message);if(render)plannerRender();
      }
    },
    async date(date,focusId=null){
      const picker=document.getElementById('planner-selected-date');
      if(State.busy||P.targetDate){if(picker)picker.value=P.targetDate||P.date;return;}
      P.dateError=Calendar.valid(date)?'':'Выберите корректную дату с 01.01.2000 по 31.12.2100.';
      if(picker)picker.setAttribute('aria-invalid',String(!!P.dateError));
      const error=document.getElementById('planner-date-error');if(error)error.textContent=P.dateError;
      if(P.dateError||date===P.date)return;
      const focus=focusId||document.activeElement?.id;P.dateFocusId=['planner-selected-date','planner-day-prev','planner-day-next'].includes(focus)?focus:null;
      P.targetDate=date;plannerRender();await Planner.load();
    },
    render(){
      const greeting=`<div class="planner-greeting"><div><p class="card-kicker">${escape(State.context.team.name)}</p><h1>Здравствуйте, ${escape(State.context.member.display_name)}.</h1><p class="workspace-lead">Рабочий план — день за днём.</p></div><button class="button button-primary" data-action="planner-create" ${!P.data||State.busy||P.targetDate?'disabled':''}>＋ Добавить задачу</button></div>`;
      if(!P.data)return `${greeting}<div class="panel planner-loading" role="status">${P.loading?'Загружаем план…':'Не удалось получить план.'}<button class="button-link" data-action="planner-refresh">Повторить</button></div>`;
      const d=P.data,f=P.filters;
      const quickDays=Calendar.workdays(d.today),quickIndex=quickDays.indexOf(P.date),navigationDisabled=State.busy||P.loading||!!P.targetDate;
      const quickRange=quickDays.length?Calendar.format(quickDays[0])+' — '+Calendar.format(quickDays.at(-1)):'';
      const members=`<option value="">Вся команда</option><option value="${State.context.user.id}" ${f.employee_id===State.context.user.id?'selected':''}>Мои задачи</option>`+d.members.filter(m=>m.user_id!==State.context.user.id).map(m=>`<option value="${m.user_id}" ${f.employee_id===m.user_id?'selected':''}>${escape(m.display_name)}${m.state==='disabled'?' · отключён':''}</option>`).join('');
      const options=(obj,current)=>Object.entries(obj).map(([v,l])=>`<option value="${v}" ${v===current?'selected':''}>${escape(l)}</option>`).join('');
      const checkFilter=(kind,items,selected,label)=>`<details class="filter-popover" data-disclosure="filter-${kind}" ${P.detailsOpen[`filter-${kind}`]?'open':''}><summary>${label}${selected.length?` · ${selected.length}`:''}</summary><div>${Object.entries(items).map(([v,l])=>`<label><input type="checkbox" data-filter-multi="${kind}" value="${v}" ${selected.includes(v)?'checked':''}>${escape(l)}</label>`).join('')}</div></details>`;
      const progress=Object.entries({day:'День',week:'Неделя',month:'Месяц'}).map(([key,label])=>{const m=d.progress[key];return `<section class="progress-card progress-${key}" style="--progress-color:${progressColor(m.progress_percent)}" aria-label="Прогресс: ${label}"><div><span>${label}</span><strong>${m.progress_percent===null?'—':new Intl.NumberFormat('ru-RU').format(m.progress_percent)+'%'}</strong></div><div class="progress-track" role="progressbar" aria-label="Выполнение плана: ${label}" aria-valuemin="0" aria-valuemax="100" ${m.progress_percent===null?'':`aria-valuenow="${m.progress_percent}"`}><i style="width:${m.progress_percent||0}%"></i></div><p>${m.planned_count?`${m.plan_done_count} из ${m.planned_count} задач выполнено`:'Нет запланированных задач'}</p>${m.early_done_count?`<p class="early-result">Сделано заранее: ${m.early_done_count}</p>`:''}</section>`;}).join('');
      const weekday=Calendar.format(P.date,{weekday:'long'}), day=Calendar.format(P.date);
      const quickDate=P.date<d.today?d.today:P.date;
      const assignee=State.context.member.role==='manager'?d.members.find(m=>m.user_id===f.employee_id&&m.state==='active')?.user_id||State.context.user.id:State.context.user.id;
      const quickOwner=d.members.find(m=>m.user_id===assignee)?.display_name||'';
      const cards=Planner.list(d.day_tasks);
      const terminal=['done','cancelled'].map(status=>{if(f.statuses.length!==3||!['planned','in_progress','waiting'].every(s=>f.statuses.includes(s)))return '';const rows=status==='done'?d.day_done_tasks:d.day_cancelled_tasks;
        return rows.length?`<details class="terminal-group" data-disclosure="${status}" ${P.detailsOpen[status]?'open':''}><summary>${Statuses[status]} · ${rows.length}${rows.length===5?'+':''}</summary>${rows.map(t=>Planner.card(t)).join('')}<button class="button-link" data-action="planner-show-status" data-status="${status}">Показать все</button></details>`:'';}).join('');
      const week=d.week_days.map(w=>`<div class="week-day ${Calendar.weekend(w.date)?'weekend':''} ${w.date===P.date?'selected':''}" data-drop-date="${w.date}"><button class="week-date" data-action="planner-date" data-date="${w.date}" aria-label="Открыть ${Calendar.format(w.date)}"><span>${Calendar.format(w.date,{weekday:'short'})}</span><strong class="${w.date===d.today?'today-number':''}">${Number(w.date.slice(8))}</strong></button><div class="week-tasks">${w.tasks.map(t=>`<button class="week-task" data-action="planner-detail" data-id="${t.id}"><span class="mini-dot ${t.overdue?'danger':t.status==='done'?'success':''}"></span><span>${escape(t.title)}</span></button>`).join('')}${!w.tasks.length?'<span class="week-empty">Нет задач</span>':''}${w.total>3?`<button class="button-link week-more" data-action="planner-date" data-date="${w.date}">Ещё ${w.total-3}</button>`:''}</div></div>`).join('');
      const month=d.month_cells.map(c=>`<button class="month-day ${c.date.slice(0,7)!==P.date.slice(0,7)?'outside':''} ${Calendar.weekend(c.date)?'weekend':''} ${c.date===P.date?'selected':''}" data-action="planner-date" data-date="${c.date}" data-drop-date="${c.date}" aria-label="${Calendar.format(c.date)}: ${c.total} задач"><span class="month-number ${c.date===d.today?'today-number':''}">${Number(c.date.slice(8))}</span>${c.total?`<span class="month-count">${c.total} задач</span><span class="month-bar" style="--progress-color:${progressColor(100*c.done/c.total)}"><i style="width:${100*c.done/c.total}%"></i></span>`:'<span class="month-empty">—</span>'}</button>`).join('');
      return `${greeting}<div class="planner-toolbar"><div class="period-nav"><button class="icon-button" data-action="planner-month-prev" aria-label="Предыдущий месяц" ${navigationDisabled?'disabled':''}>‹</button><h2>${Calendar.format(P.date,{month:'long',year:'numeric'})}</h2><button class="icon-button" data-action="planner-month-next" aria-label="Следующий месяц" ${navigationDisabled?'disabled':''}>›</button><div class="planner-date-picker"><label for="planner-selected-date">Выбрать дату</label><input id="planner-selected-date" type="date" min="2000-01-01" max="2100-12-31" value="${P.targetDate||P.date}" aria-invalid="${!!P.dateError}" aria-describedby="planner-date-error" ${navigationDisabled?'disabled':''}><span class="planner-date-error" id="planner-date-error" role="alert">${escape(P.dateError)}</span></div></div><div class="main-filters"><label><span>Исполнитель</span><select id="planner-employee" data-filter="employee_id">${members}</select></label><label><span>Направление</span><select id="planner-direction" data-filter="direction">${options(Directions,f.direction)}</select></label></div></div><div class="progress-grid">${progress}</div><p class="progress-hint">Результат — по сроку сдачи, без срока — по последнему дню работы; незавершённые прошлые сроки тоже учитываются. Прогресс учитывает исполнителя и направление. Статус, поиск, срок и приоритет фильтруют только списки.</p><div class="secondary-filters"><input id="planner-query" type="search" maxlength="200" data-query placeholder="Найти задачу" aria-label="Поиск задач" value="${escape(f.query)}">${checkFilter('statuses',Statuses,f.statuses,'Статусы')}${checkFilter('priorities',Priorities,f.priorities,'Приоритет')}<select aria-label="Фильтр по сроку" data-filter="deadline_filter">${options({all:'Любой срок',none:'Без срока',today:'Срок сегодня',next_7_days:'Ближайшие 7 дней',overdue:'Просрочено'},f.deadline_filter)}</select><select aria-label="Группировка задач" data-filter="group_by">${options({list:'Обычный список',status:'По статусу',priority:'По приоритету'},f.group_by)}</select><button class="button-link" data-action="planner-reset">Сбросить</button></div><div class="plan-links"><button class="button-link ${d.overdue_total?'overdue-link':''}" data-action="planner-overdue">Все просроченные: ${d.overdue_total}</button><button class="button-link" data-action="planner-bin">Корзина</button><button class="button-link" data-action="planner-refresh" ${P.loading?'disabled':''}>${P.loading?'Обновляем…':'Обновить'}</button></div>${P.undo&&Date.now()<P.undo.expires?`<div class="notice notice-success undo-notice" role="status">${escape(P.undo.message)} <button class="button-link" data-action="planner-undo">Отменить действие</button></div>`:''}<div class="planning-grid"><section class="day-panel panel" aria-labelledby="day-heading" aria-busy="${!!P.targetDate}" data-drop-date="${P.date}"><div class="section-heading day-heading-row"><div><p class="card-kicker">${weekday}${P.date===d.today?' · Сегодня':P.date<d.today?' · История':''}</p><h2 id="day-heading">${day}</h2></div><div class="day-navigation" role="group" aria-label="Быстрый переход по рабочим дням"><span class="count-badge">${d.day_total}</span><button id="planner-day-prev" class="icon-button" data-action="planner-day-prev" aria-label="Предыдущий рабочий день" aria-describedby="quick-days-hint" ${navigationDisabled||quickIndex<=0?'disabled':''}>‹</button><button id="planner-day-next" class="icon-button" data-action="planner-day-next" aria-label="Следующий рабочий день" aria-describedby="quick-days-hint" ${navigationDisabled||quickIndex<0||quickIndex===quickDays.length-1?'disabled':''}>›</button></div></div><p class="quick-days-hint" id="quick-days-hint" role="status">${P.targetDate?'Загружаем выбранный день…':'Быстрый переход: '+quickRange+' · ближайшие рабочие дни.'}${!P.targetDate?' Если дата вне быстрого диапазона — выберите дату вверху.':''}</p><form data-form="planner-quick" class="quick-form" novalidate><label class="sr-only" for="quick-title">Название быстрой задачи</label><input id="quick-title" name="quick-title" maxlength="200" value="${escape(P.quick)}" placeholder="Какая задача появилась?" autocomplete="off"><button class="icon-button" type="submit" aria-label="Добавить быструю задачу" ${State.busy||P.targetDate?'disabled':''}>＋</button></form><p class="quick-hint">${escape(quickOwner)} · ${Calendar.format(quickDate)} · ${escape(Directions[f.direction==='all'?'none':f.direction])}${P.date<d.today?' · создание на сегодня':''}</p>${P.errors.quick?`<p class="field-error" role="alert">${escape(P.errors.quick)}</p>`:''}<div class="day-tasks">${cards||`<div class="empty-state"><strong>${f.query||f.priorities.length||f.deadline_filter!=='all'?'По фильтрам ничего не найдено':'В этот день нет задач для показа'}</strong><p>${d.progress.day.planned_count?'Результат учитывается по срокам сдачи. Выполненные ранее задачи сохранены в итогах.':'Добавьте задачу или измените фильтры.'}</p></div>`}</div>${d.next_cursor?'<button class="button button-secondary button-full" data-action="planner-more">Показать ещё</button>':''}${terminal}</section><section class="week-panel panel" aria-labelledby="week-heading"><div class="section-heading"><h2 id="week-heading">Неделя</h2><div><button class="icon-button" data-action="planner-week-prev" aria-label="Предыдущая неделя" ${navigationDisabled?'disabled':''}>‹</button><button class="icon-button" data-action="planner-week-next" aria-label="Следующая неделя" ${navigationDisabled?'disabled':''}>›</button></div></div><div class="week-range">${Calendar.format(d.week_days[0].date)} — ${Calendar.format(d.week_days[6].date)}</div><div class="week-list">${week}</div></section></div>${Daily.render()}<details class="month-panel panel" data-disclosure="month" ${P.detailsOpen.month!==false?'open':''}><summary>Обзор месяца <span>${Calendar.format(P.date,{month:'long',year:'numeric'})}</span></summary><div class="month-weekdays">${['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map(v=>`<span>${v}</span>`).join('')}</div><div class="month-grid">${month}</div></details>`;
    },
    list(tasks){
      if(P.filters.group_by==='list')return tasks.map(Planner.card).join('');
      const key=P.filters.group_by==='status'?'status':'priority',labels=key==='status'?Statuses:Priorities;
      return Object.entries(labels).map(([v,label])=>{const group=tasks.filter(t=>t[key]===v);return group.length?`<div class="task-group"><h3>${label} · ${group.length}</h3>${group.map(Planner.card).join('')}</div>`:'';}).join('');
    },
    card(t){return `<article class="task-card ${t.status==='done'?'task-done':''}" data-task-id="${t.id}" ${t.allowed_actions.includes('move')?'draggable="true"':''}><div class="task-top">${t.allowed_actions.includes('complete')?`<button class="task-check" data-action="planner-complete" data-id="${t.id}" aria-label="Завершить: ${escape(t.title)}" ${State.busy?'disabled':''}>✓</button>`:`<span class="task-state-icon">${t.status==='done'?'✓':'·'}</span>`}<button class="task-title" data-action="planner-detail" data-id="${t.id}">${escape(t.title)}</button>${t.allowed_actions.includes('move')?`<button class="task-menu" data-action="planner-move" data-id="${t.id}" aria-label="Перенести: ${escape(t.title)}">↗</button>`:''}</div><div class="task-meta">${taskStatusBadges(t)}<span>${escape(t.assignee_name)}</span><span>${Directions[t.direction||'none']}</span></div><div class="task-tags">${t.priority!=='unset'?`<span class="priority-tag priority-${t.priority}">${Priorities[t.priority]}</span>`:''}${t.deadline?`<span class="deadline-tag ${t.overdue?'danger':t.deadline===P.data.today?'due-today':''}">${t.late?'С опозданием · ':'Срок · '}${Calendar.format(t.deadline)}</span>`:''}${t.plan_start!==t.plan_end?`<span>Период ${Calendar.format(t.plan_start)} — ${Calendar.format(t.plan_end)}</span>`:''}${t.recurrence?'<span>Повторение</span>':''}${t.comment_count?`<span>Комментарии · ${t.comment_count}</span>`:''}${t.continuation?'<span>Продолжение</span>':''}${t.historical?'<span>История дня</span>':''}</div></article>`;},
    formField(name,label,{type='text',options=null,readonly=false,hint=''}={}){
      const f=P.form||{},value=f[name]??'',error=P.errors[name],id=`task-${name}`;
      const attrs=`id="${id}" name="${name}" data-task-field="${name}" aria-invalid="${!!error}" aria-describedby="${id}-error" ${readonly?'disabled':''}`;
      let control=options?`<select ${attrs}>${Object.entries(options).map(([v,l])=>`<option value="${escape(v)}" ${String(value)===v?'selected':''}>${escape(l)}</option>`).join('')}</select>`:type==='textarea'?`<textarea ${attrs} rows="4" maxlength="${name==='reason'?1000:10000}">${escape(value)}</textarea>`:`<input ${attrs} type="${type}" value="${escape(value)}" ${type==='date'?'min="2000-01-01" max="2100-12-31"':''} ${name==='title'?'maxlength="200"':''}>`;
      return `<div class="field ${type==='textarea'?'field-wide':''}"><label for="${id}">${label}${readonly?' · только просмотр':''}</label>${control}${hint?`<p class="field-hint">${escape(hint)}</p>`:''}<span class="field-error" id="${id}-error">${escape(error||'')}</span></div>`;
    },
    renderModal(){
      if(!P.modal)return '';const t=P.modal.task,mode=P.modal.mode;let body,title;
      if(mode==='notifications')return Work.dialog('Уведомления',Notifications.render());
      if(mode==='team-disable')return Work.dialog('Отключить сотрудника',Team.disableForm());
      if(mode==='series-edit'||mode==='series-stop')return Work.dialog(mode==='series-stop'?'Завершить повторение':'Изменить повторение',Series.render());
      if(P.loadingModal){title='Задача';body='<p role="status">Загружаем…</p>';}
      else if(['create','edit'].includes(mode)){
        title=mode==='create'?'Новая задача':'Изменить задачу';const f=P.form, editable=t?.editable_fields||['title','description','plan_start','plan_end','deadline','important','urgent','direction','assignee_id'];
        const owners=Object.fromEntries((P.data?.members||[]).filter(m=>m.state==='active'||m.user_id===f.assignee_id).map(m=>[m.user_id,m.display_name]));
        const locked=k=>mode==='edit'&&!editable.includes(k);
        body=`<form class="task-form" data-form="planner-task" novalidate>${t?.series_id?'<p class="notice">Изменится только эта задача. Остальные повторения сохранятся.</p>':''}<div class="task-fields">${Planner.formField('title','Название',{readonly:locked('title')})}${Planner.formField('plan_start','Дата работы',{type:'date',readonly:locked('plan_start')})}${Planner.formField('plan_end','Последний день работы',{type:'date',readonly:locked('plan_end')})}${Planner.formField('assignee_id','Исполнитель',{options:owners,readonly:State.context.member.role!=='manager'||locked('assignee_id')})}${Planner.formField('direction','Направление',{options:Object.fromEntries(Object.entries(Directions).filter(([k])=>k!=='all')),readonly:locked('direction')})}${Planner.formField('priority','Приоритет',{options:Priorities,readonly:locked('important')})}${Planner.formField('deadline','Срок сдачи',{type:'date',readonly:locked('deadline'),hint:'Не изменяется при переносе даты работы.'})}${Planner.formField('description','Описание',{type:'textarea',readonly:locked('description')})}</div><p class="notice result-date-hint">В результате за: <strong>${Calendar.format(f.deadline||f.plan_end||f.plan_start)}</strong>. Начало работы не снижает процент до этой даты.</p><p class="field-hint task-visibility-hint">${taskVisibilityHint(f.deadline)}</p>${mode==='create'?Series.repeatFields():''}<div class="notice notice-warning task-date-warning" ${f.deadline&&(f.deadline<f.plan_start||f.deadline<P.data.today)?'':'hidden'}>Срок раньше даты работы или уже прошёл. Он сохранится: перенос плана не меняет срок сдачи.</div>${mode==='edit'&&State.context.member.role==='manager'&&t.management_mode==='self'?'<div class="notice">Если изменить название, исполнителя, направление, приоритет или срок, задача перейдёт под управление руководителя.</div>':''}${Planner.modalErrors()}<div class="modal-actions"><button class="button button-primary" type="submit" ${State.busy?'disabled':''}>${State.busy?'Сохраняем…':'Сохранить задачу'}</button><button class="button button-secondary" type="button" data-action="planner-close">Закрыть</button></div></form>`;
      }else if(mode==='move'){
        title='Перенести задачу';const end=Calendar.add(P.form.plan_start||t.plan_start,Math.round((Date.parse(t.plan_end)-Date.parse(t.plan_start))/86400000));
        body=`<p class="modal-task-name">${escape(t.title)}</p><p class="field-hint">Текущий план: ${Calendar.format(t.plan_start)} — ${Calendar.format(t.plan_end)}. Срок: ${t.deadline?Calendar.format(t.deadline):'не задан'}.</p><form class="task-form" data-form="planner-move" novalidate>${Planner.formField('plan_start','Новая дата работы',{type:'date'})}<p class="field-hint">Новый интервал: ${Calendar.format(P.form.plan_start||t.plan_start)} — ${Calendar.format(end)}. Срок сдачи сохранится.</p><div class="form-actions"><button type="button" class="button-link" data-action="planner-move-today">Сегодня</button><button type="button" class="button-link" data-action="planner-move-next">Следующий рабочий день</button></div>${P.form.plan_start&&t.deadline&&P.form.plan_start>t.deadline?'<p class="notice notice-warning">Дата работы позже срока сдачи.</p>':''}${Planner.modalErrors()}<div class="modal-actions"><button class="button button-primary" type="submit" ${State.busy?'disabled':''}>Перенести</button><button class="button button-secondary" type="button" data-action="planner-close">Отмена</button></div></form>`;
      }else if(mode==='cancel'||mode==='delete'){
        title=mode==='cancel'?'Отменить задачу':'Удалить задачу';body=`<p class="modal-task-name">${escape(t.title)}</p><p class="lead">${mode==='delete'?'История сохранится. Задачу можно восстановить из корзины.':'Задача больше не требуется. Укажите причину отмены.'}</p><form class="task-form" data-form="planner-confirm" novalidate>${mode==='cancel'?Planner.formField('reason','Причина отмены',{type:'textarea'}):''}${Planner.modalErrors()}<div class="modal-actions"><button class="button button-primary" type="submit" ${State.busy?'disabled':''}>${mode==='cancel'?'Отменить задачу':'Удалить'}</button><button class="button button-secondary" type="button" data-action="planner-close">Назад</button></div></form>`;
      }else if(mode==='collection'){
        title=P.collection==='deleted'?'Корзина':'Все просроченные';body=`<p class="lead">${P.modal.total||0} задач · текущие исполнитель и направление</p>${(P.modal.tasks||[]).map(Planner.card).join('')||'<p class="empty-state">Нет задач</p>'}${P.collectionCursor?'<button class="button button-secondary" data-action="planner-collection-more">Показать ещё</button>':''}${Planner.modalErrors()}`;
      }else{
        title='Задача';const actionButton=(action,label)=>t.allowed_actions.includes(action)?`<button class="button button-secondary" data-action="planner-${action}" data-id="${t.id}" ${State.busy?'disabled':''}>${label}</button>`:'';
        const history=P.history.map(e=>{const labels={create:'Создана',update:'Изменена',move:'Перенесена',status:'Изменён статус',delete:'Удалена',restore:'Восстановлена',take_control:'Передана под управление',auto_move:'Автоматический перенос',series_create:'Создан экземпляр повторения',series_update:'Изменено повторение',series_replace:'Заменён будущий экземпляр',series_stop:'Повторение завершено',bulk_transfer:'Передано при отключении сотрудника',comment_create:'Добавлен комментарий',comment_update:'Изменён комментарий',comment_delete:'Удалён комментарий'};
          const names={title:'Название',description:'Описание',assignee_id:'Исполнитель',direction:'Направление',deadline:'Срок',plan_start:'Начало работы',plan_end:'Конец работы',status:'Статус',management_mode:'Управление',cancel_reason:'Причина отмены'};
          const val=(k,v)=>k==='status'?Statuses[v]||v:k==='direction'?Directions[v||'none']:k==='assignee_id'?P.data.members.find(m=>m.user_id===v)?.display_name||v:v===null||v===undefined?'Не задано':String(v);
          const changes=Object.keys(names).filter(k=>e.before?.[k]!==e.after?.[k]).map(k=>`<li><strong>${names[k]}:</strong> ${e.before?escape(val(k,e.before?.[k]))+' → ':''}${escape(val(k,e.after?.[k]))}</li>`).join('');
          return `<article class="history-entry"><div><strong>${e.type==='series_rule_changed'?'Правило повторения':labels[e.type]||e.type}</strong><time>${Work.dateTime(e.at)}</time></div><p>${escape(e.actor_name)}</p><ul>${changes}</ul>${e.series_change?Series.history(e.series_change):''}${e.comment?`<p>${e.comment.deleted?'Комментарий удалён':escape(e.comment.before?.body||'')+(e.comment.before?.body?' → ':'')+escape(e.comment.after?.body||'Комментарий удалён')}</p>`:''}</article>`;}).join('');
        const description=escape(t.description).replace(/https?:\/\/[^\s<>]+/g,url=>`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
        const tabs=`<div class="detail-tabs"><button class="${P.tab==='detail'?'active':''}" data-action="planner-tab-detail">Подробности</button><button class="${P.tab==='comments'?'active':''}" data-action="work-comments">Комментарии · ${t.comment_count||0}</button><button class="${P.tab==='history'?'active':''}" data-action="planner-tab-history">История</button></div>`;
        const content=P.tab==='comments'?Comments.render():P.tab==='history'?`${history||'<p>История загружается…</p>'}${P.historyCursor?'<button class="button-link" data-action="planner-history-more">Ещё записи</button>':''}`:
          `<dl class="task-details"><div><dt>Исполнитель</dt><dd>${escape(t.assignee_name)}</dd></div><div><dt>Статус</dt><dd class="task-status-badges">${taskStatusBadges(t)}</dd></div><div><dt>Направление</dt><dd>${Directions[t.direction||'none']}</dd></div><div><dt>Приоритет</dt><dd>${Priorities[t.priority]}</dd></div><div><dt>План</dt><dd>${Calendar.format(t.plan_start)} — ${Calendar.format(t.plan_end)}</dd></div><div><dt>Срок сдачи</dt><dd class="${t.overdue?'danger':''}">${t.deadline?Calendar.format(t.deadline):'Не задан'}${t.overdue?' · просрочен':''}</dd></div></dl><div class="task-description">${description||'Описание не добавлено.'}</div>${Series.summary()}<div class="form-actions">${actionButton('edit',t.series_id?'Только эту задачу':'Изменить')}${actionButton('move','Перенести')}${actionButton('complete','Выполнено')}${actionButton('reopen','Вернуть в работу')}${actionButton('cancel','Отменить задачу')}${actionButton('delete','Удалить')}${actionButton('restore','Восстановить')}${actionButton('take_control','Взять под управление')}</div>${t.allowed_actions.includes('status')?`<label class="field status-change-label">Изменить статус<select id="task-status" data-task-status="${t.id}">${Object.entries(Statuses).filter(([v])=>['planned','in_progress','waiting'].includes(v)).map(([v,l])=>`<option value="${v}" ${v===t.status?'selected':''}>${l}</option>`).join('')}</select></label>`:''}`;
        body=`<h3 class="detail-title">${escape(t.title)}</h3>${P.modal.fromHistory?'<p class="notice">Открыто текущее состояние задачи. Исторический план не изменяется.</p>':''}${t.deleted_at?'<p class="notice notice-warning">Задача удалена.</p>':''}${tabs}${content}${Planner.modalErrors()}`;
      }
      return `<dialog id="task-dialog" class="task-dialog" aria-labelledby="task-dialog-title"><div class="modal-heading"><h2 id="task-dialog-title">${title}</h2><button class="icon-button" data-action="planner-close" aria-label="Закрыть задачу">×</button></div>${body}</dialog>`;
    },
    modalErrors(){const canApply=P.modal?.latest?.allowed_actions?.includes(P.modal.mode==='edit'?'edit':P.modal.mode);return P.errors._form?`<div class="notice notice-error" role="alert">${escape(P.errors._form)}</div>${P.modal?.latestSeries?Series.latestSummary(P.modal.latestSeries):''}${P.modal?.latestMember?`<p class="notice">Актуальные данные сотрудника: активных задач ${P.modal.latestMember.active_task_count}, серий ${P.modal.latestMember.active_series_count}.<br><button type="button" class="button-link" data-action="work-member-latest">Обновить данные сотрудника</button></p>`:''}${P.modal?.latest?`${Planner.latestSummary(P.modal.latest)}<button type="button" class="button-link" data-action="planner-load-latest">Загрузить актуальную задачу</button>${canApply?'<p class="field-hint">Применятся только ваши изменения в разрешённых полях.</p><button type="button" class="button-link" data-action="planner-apply-draft">Применить мои изменения после проверки</button>':'<p class="field-hint">Изменение недоступно в текущем состоянии задачи.</p>'}`:''}`:'';},
    latestSummary(t){return `<details class="conflict-current" open><summary>Актуальные данные задачи</summary><p><strong>${escape(t.title)}</strong></p><p>${escape(t.assignee_name)} · ${Statuses[t.status]} · ${Directions[t.direction||'none']} · ${Priorities[t.priority]}</p><p>План: ${Calendar.format(t.plan_start)} — ${Calendar.format(t.plan_end)}. Срок: ${t.deadline?Calendar.format(t.deadline):'Не задан'}.</p><p class="comment-body">${escape(t.description||'Описание не добавлено.')}</p></details>`;},
    afterRender(){
      if(P.dateFocusId&&!P.targetDate&&!P.modal&&!Daily.banner){const control=document.getElementById(P.dateFocusId);P.dateFocusId=null;(control&&!control.disabled?control:document.getElementById('planner-selected-date'))?.focus({preventScroll:true});}
      const dialog=document.getElementById('task-dialog');if(dialog&&!dialog.open){dialog.showModal();if(P.focusModal){P.focusModal=false;requestAnimationFrame(()=>{(dialog.querySelector('[aria-invalid="true"]')||dialog.querySelector('#task-title')||dialog.querySelector('#task-plan_start')||dialog.querySelector('button'))?.focus();});}}},
    hasDirty(){captureNativeDraft();return !!P.modal&&(['create','edit','move','cancel','series-edit','series-stop','team-disable'].includes(P.modal.mode)&&JSON.stringify(P.form)!==P.modal.baseline||Comments.dirty());},
    close(force=false){if(State.busy)return;if(!force&&Planner.hasDirty())return navigate(()=>Planner.close(true));P.pending=null;delete Work.pending.series;P.modal=null;P.form=null;P.errors={};P.tab='detail';P.history=[];Comments.clear();plannerRender(false);},
    openCreate(){if(!P.data||P.targetDate)return;const owner=State.context.member.role==='manager'&&P.data.members.some(m=>m.user_id===P.filters.employee_id&&m.state==='active')?P.filters.employee_id:State.context.user.id;
      const day=P.date<P.data.today?P.data.today:P.date;P.form={title:P.quick,description:'',plan_start:day,plan_end:day,deadline:'',direction:P.filters.direction==='all'?'none':P.filters.direction,priority:'unset',assignee_id:owner,frequency:'none',weekdays:[new Date(day+'T12:00:00Z').getUTCDay()||7],month_day:Number(day.slice(8)),repeat_end:''};P.modal={mode:'create',baseline:JSON.stringify(P.form)};P.errors={};P.focusModal=true;plannerRender(false);},
    async open(id,mode='detail'){
      P.modal={mode,task:null};P.loadingModal=true;P.form=null;P.errors={};P.tab='detail';P.history=[];P.focusModal=true;plannerRender(false);
      const modal=P.modal,generation=State.generation;
      try{const data=await Api.rpc('get_task_detail',{p_team_id:State.context.team.id,p_task_id:id});if(P.modal!==modal||generation!==State.generation)return;
        P.modal.task=data.task;P.modal.series=data.series;P.modal.fromHistory=P.date<P.data.today;P.loadingModal=false;Comments.clear();
        if(['edit','move','cancel'].includes(mode))Planner.startForm(mode,data.task);else plannerRender(false);
      }catch(e){if(P.modal!==modal||generation!==State.generation)return;P.loadingModal=false;P.errors._form=normalizeError(e).message;P.modal=null;setMessage(P.errors._form);plannerRender();}
    },
    startForm(mode,t){P.form=mode==='move'?{plan_start:t.plan_start}:mode==='cancel'?{reason:''}:{title:t.title,description:t.description,plan_start:t.plan_start,plan_end:t.plan_end,deadline:t.deadline||'',assignee_id:t.assignee_id,direction:t.direction||'none',priority:t.priority};P.modal={...P.modal,mode,task:t,baseline:JSON.stringify(P.form)};P.errors={};P.focusModal=true;plannerRender(false);},
    async history(append=false){const modal=P.modal,generation=State.generation;if(!modal?.task)return;P.tab='history';plannerRender(false);try{const r=await Api.rpc('get_task_history',{p_team_id:State.context.team.id,p_task_id:modal.task.id,p_cursor:append?P.historyCursor:null});if(P.modal!==modal||generation!==State.generation||P.tab!=='history')return;P.history=append?[...P.history,...r.events]:r.events;P.historyCursor=r.next_cursor;plannerRender(false);}catch(e){if(P.modal!==modal||generation!==State.generation)return;P.errors._form=normalizeError(e).message;plannerRender();}},
    async collection(name,append=false){P.collection=name;if(!append){P.modal={mode:'collection',tasks:[]};P.form=null;P.loadingModal=true;P.focusModal=true;plannerRender(false);}const modal=P.modal,generation=State.generation;try{const r=await Api.rpc('list_task_collection',{p_team_id:State.context.team.id,p_collection:name,p_employee_id:P.filters.employee_id,p_direction:P.filters.direction,p_cursor:append?P.collectionCursor:null});if(P.modal!==modal||generation!==State.generation)return;P.modal={mode:'collection',total:r.total,tasks:append?[...modal.tasks,...r.tasks]:r.tasks};P.loadingModal=false;P.collectionCursor=r.next_cursor;P.form=null;P.errors={};P.focusModal=true;plannerRender(false);}catch(e){if(P.modal!==modal||generation!==State.generation)return;P.loadingModal=false;if(!append)P.modal=null;setMessage(normalizeError(e).message);plannerRender();}},
    async mutate(action,t,payload={}, {quick=false,undo=false}={}){
      if(State.busy||action==='create'&&P.targetDate)return;const generation=State.generation;State.busy=true;P.errors={};const fingerprint=JSON.stringify([action,t?.id||null,payload,t?.version||null]);
      if(P.pending?.fingerprint!==fingerprint)P.pending={id:crypto.randomUUID(),fingerprint};const op=P.pending.id;plannerRender();
      try{
        const result=await Api.rpc('mutate_task',{p_team_id:State.context.team.id,p_action:action,p_task_id:t?.id||null,p_payload:payload,p_expected_version:t?.version||null,p_operation_id:op});
        if(generation!==State.generation)return;
        const saved=result.entity;P.pending=null;P.modal=null;P.form=null;if(action==='create')P.quick='';
        if(!undo&&(action==='delete'||action==='status'&&saved.status==='done')){
          const expiry=Date.now()+10000;P.undo={task:saved,action:action==='delete'?'restore':'status',payload:action==='delete'?{}:{status:'in_progress'},expires:expiry,message:action==='delete'?'Задача удалена.':'Задача выполнена.'};
          setTimeout(()=>{if(P.undo?.expires===expiry){P.undo=null;if(State.context&&State.view!=='profile')plannerRender();}},10020);
        }else if(undo)P.undo=null;
        setMessage(action==='create'&&P.filters.employee_id&&P.filters.employee_id!==saved.assignee_id?'Задача добавлена и скрыта фильтром исполнителя. Выберите «Мои задачи», чтобы увидеть её.':'Изменения сохранены.','success');
        if(action==='create'&&P.filters.employee_id&&P.filters.employee_id!==saved.assignee_id)State.message.action='show-mine';
        await Planner.load();return saved;
      }catch(e){if(generation!==State.generation)return;e=normalizeError(e);P.errors={...(e.field_errors||{}),_form:e.message};
        if(e.code==='VERSION_CONFLICT'&&P.modal)P.modal.latest=e.latest_entity;
        if(quick){P.errors.quick=e.message;setMessage(e.message);}else if(!P.modal)setMessage(e.message);
        if(['ACCESS_DENIED','UNAUTHENTICATED'].includes(e.code)){await loadAccess({preserve:true});}
      }finally{if(generation===State.generation){State.busy=false;plannerRender();}}
    },
    async submit(kind){
      if(kind==='planner-quick'){
        if(!P.quick.trim()){P.errors.quick='Введите название задачи.';plannerRender();return;}
        const owner=State.context.member.role==='manager'&&P.data.members.some(m=>m.user_id===P.filters.employee_id&&m.state==='active')?P.filters.employee_id:State.context.user.id;
        return Planner.mutate('create',null,{title:P.quick,plan_start:P.date<P.data.today?P.data.today:P.date,assignee_id:owner,direction:P.filters.direction==='all'||P.filters.direction==='none'?null:P.filters.direction},{quick:true});
      }
      const mode=P.modal.mode,t=P.modal.task,f=P.form;
      if(kind==='planner-task'){
        const parts=f.priority==='unset'?[null,null]:[f.priority.startsWith('important_'),f.priority.endsWith('_urgent')&&!f.priority.endsWith('_not_urgent')];
        const full={title:f.title,description:f.description,plan_start:f.plan_start,plan_end:f.plan_end,deadline:f.deadline||null,direction:f.direction==='none'?null:f.direction,important:parts[0],urgent:parts[1],assignee_id:f.assignee_id};
        if(mode==='create'&&f.frequency!=='none')return Series.save('create');
        const patch=mode==='create'?full:Object.fromEntries(Object.entries(full).filter(([k,v])=>t.editable_fields.includes(k)&&t[k]!==v));
        return Planner.mutate(mode==='create'?'create':'update',t,patch);
      }
      if(kind==='planner-move')return Planner.mutate('move',t,{plan_start:f.plan_start});
      if(kind==='planner-confirm')return Planner.mutate(mode==='delete'?'delete':'status',t,mode==='delete'?{}:{status:'cancelled',reason:f.reason});
    },
    async click(button){
      const a=button.dataset.action.replace('planner-',''),id=button.dataset.id;
      if(State.busy&&!['close'].includes(a))return;
      if(a==='create')return Planner.openCreate();if(a==='detail')return Planner.open(id);
      if(a==='date')return Planner.date(button.dataset.date);
      if(a==='day-prev'||a==='day-next'){const days=Calendar.workdays(P.data.today),index=days.indexOf(P.date),date=index<0?null:days[index+(a==='day-prev'?-1:1)];if(date)return Planner.date(date,button.id);return;}
      if(a.startsWith('month-'))return Planner.date(Calendar.month(P.date,a.endsWith('prev')?-1:1));
      if(a.startsWith('week-'))return Planner.date(Calendar.add(P.date,a.endsWith('prev')?-7:7));
      if(a==='refresh')return Planner.load();if(a==='more')return Planner.load({append:true});
      if(a==='reset'){P.filters=Planner.defaults();Planner.save();return Planner.load();}
      if(a==='mine'){P.filters.employee_id=State.context.user.id;State.message=null;Planner.save();return Planner.load();}
      if(a==='show-status'){P.filters.statuses=[button.dataset.status];Planner.save();return Planner.load();}
      if(a==='close')return Planner.close();if(a==='bin'||a==='overdue')return Planner.collection(a==='bin'?'deleted':'overdue');
      if(a==='collection-more')return Planner.collection(P.collection,true);if(a==='tab-detail'){P.tab='detail';return plannerRender(false);}if(a==='tab-history'||a==='history-more')return Planner.history(a==='history-more');
      if(a==='move-today'||a==='move-next'){P.form.plan_start=a==='move-today'?P.data.today:Calendar.nextWork(P.data.today);return plannerRender();}
      if(a==='undo'&&P.undo&&Date.now()<P.undo.expires)return Planner.mutate(P.undo.action,P.undo.task,P.undo.payload,{undo:true});
      if(a==='load-latest'&&P.modal.latest){const mode=P.modal.mode,latest=P.modal.latest;if(!latest.allowed_actions.includes(mode==='edit'?'edit':mode)){P.modal={mode:'detail',task:latest};P.form=null;P.errors={};P.tab='detail';return plannerRender(false);}P.modal.task=latest;return Planner.startForm(mode,latest);}
      if(a==='apply-draft'&&P.modal.latest){const mode=P.modal.mode,latest=P.modal.latest,draft={...P.form},base=JSON.parse(P.modal.baseline);P.modal.latest=null;Planner.startForm(mode,latest);
        for(const [key,value] of Object.entries(draft))if(JSON.stringify(value)!==JSON.stringify(base[key])&&(mode!=='edit'||latest.editable_fields.includes(key==='priority'?'important':key)))P.form[key]=value;
        return Planner.submit(mode==='move'?'planner-move':['cancel','delete'].includes(mode)?'planner-confirm':'planner-task');}
      if(a==='edit'||a==='move'||a==='cancel'||a==='delete')return navigate(()=>Planner.open(id,a));
      const t=P.modal?.task?.id===id?P.modal.task:P.data.day_tasks.find(t=>t.id===id)||P.data.week_days.flatMap(d=>d.tasks).find(t=>t.id===id);
      if(!t)return;
      if(a==='complete')return navigate(()=>Planner.mutate('status',t,{status:'done'}));
      if(a==='reopen')return navigate(()=>Planner.mutate('status',t,{status:'in_progress'}));
      if(a==='restore')return navigate(()=>Planner.mutate('restore',t));
      if(a==='take_control')return navigate(()=>Planner.mutate('take_control',t));
    }
  };

  // Collaboration uses the same RPC boundary as the planner. Drafts live only in this page.
  const Work={pending:{},retryUntil:{},
    dateTime(value){return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}).format(new Date(value));},
    text(value){return escape(value||'').replace(/https?:\/\/[^\s<>]+/g,url=>`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);},
    dialog(title,body){return `<dialog id="task-dialog" class="task-dialog" aria-labelledby="task-dialog-title"><div class="modal-heading"><h2 id="task-dialog-title">${title}</h2><button class="icon-button" data-action="planner-close" aria-label="Закрыть задачу">×</button></div>${body}</dialog>`;},
    now(){return State.serverTime?Date.parse(State.serverTime)+Date.now()-(State.serverTimeReceived||Date.now()):Date.now();},
    async run(key,parameters,send,done){
      if(State.busy)return;if(Date.now()<(Work.retryUntil[key]||0)){P.errors._form='Слишком много запросов. Подождите перед повтором.';plannerRender();return;}
      const fingerprint=JSON.stringify(parameters),generation=State.generation;
      if(Work.pending[key]?.fingerprint!==fingerprint)Work.pending[key]={id:crypto.randomUUID(),fingerprint};
      State.busy=true;P.errors={};Team.error='';Comments.error='';State.message=null;plannerRender();
      try{const result=await send(Work.pending[key].id);if(generation!==State.generation)return;delete Work.pending[key];await done(result);}
      catch(error){if(generation!==State.generation)return;const e=normalizeError(error);P.errors={...e.field_errors,_form:e.message};Team.error=e.message;Comments.error=e.field_errors?.comment_body||e.message;
        if(key==='series'&&e.field_errors){if(e.field_errors.start_date)P.errors.plan_start=e.field_errors.start_date;if(e.field_errors.end_date)P.errors.repeat_end=e.field_errors.end_date;}
        if(e.code==='VERSION_CONFLICT'){if(key==='series'&&P.modal)P.modal.latestSeries=e.latest_entity;else if(key==='comment'){Comments.latest=e.latest_entity;Comments.error='Комментарий изменился. Актуальный текст: '+(e.latest_entity?.deleted_at?'Комментарий удалён':e.latest_entity?.body||'');}}
        if(e.code==='RATE_LIMITED'){Work.retryUntil[key]=Date.now()+(e.retry_after_seconds||60)*1000;P.errors._form=`Слишком много запросов. Повторите через ${e.retry_after_seconds||60} секунд.`;Team.error=P.errors._form;Comments.error=P.errors._form;}
        if(['NETWORK_ERROR','NETWORK_OR_SERVICE_ERROR'].includes(e.code))State.connectionLost=true;
        if(['ACCESS_DENIED','UNAUTHENTICATED'].includes(e.code))await loadAccess({preserve:true});
        else if(key==='team'&&P.modal?.mode==='team-disable'){await Team.load();if(P.modal?.mode==='team-disable')P.modal.latestMember=Team.data?.members.find(m=>m.user_id===P.modal.member.user_id);}
      }finally{if(generation===State.generation){State.busy=false;plannerRender();if(Sync.pending)Sync.schedule();}}
    },
    async click(button){
      if(State.busy)return;const a=button.dataset.action.replace('work-',''),id=button.dataset.id;
      if(a==='notifications')return navigate(()=>Notifications.open());
      if(a==='notifications-more')return Notifications.load(true);if(a==='notifications-all'||a==='notifications-unread'){Notifications.unreadOnly=a==='notifications-unread';return Notifications.load();}
      if(a==='notifications-read-all')return Notifications.readAll();if(a==='notification-open')return Notifications.openItem(id);
      if(a==='comments')return Comments.open();if(a==='comments-more')return Comments.load(true);if(a==='comments-latest')return Comments.load(false,true);
      if(a==='comment-edit'){const c=Comments.rows.find(c=>c.id===id),modal=P.modal;if(c)return navigate(()=>{P.modal=modal;P.tab='comments';Comments.draftRevision++;Comments.edit=c;Comments.draft=c.body;Comments.latest=null;P.errors={};plannerRender(false);});}
      if(a==='comment-cancel'){const modal=P.modal;return navigate(()=>{P.modal=modal;P.tab='comments';Comments.draftRevision++;Comments.edit=null;Comments.draft='';Comments.latest=null;P.errors={};plannerRender(false);});}
      if(a==='comment-delete'){Comments.deleting=Comments.rows.find(c=>c.id===id);return plannerRender();}
      if(a==='comment-keep'){Comments.deleting=null;return plannerRender();}if(a==='comment-confirm-delete')return Comments.save('delete');
      if(a==='comment-reload'&&Comments.latest){Comments.draftRevision++;Comments.edit=Comments.latest.deleted_at?null:Comments.latest;Comments.draft=Comments.latest.deleted_at?'':Comments.latest.body;Comments.latest=null;P.errors={};return plannerRender();}
      if(a==='comment-apply'&&Comments.latest){Comments.edit=Comments.latest;Comments.latest=null;return Comments.save();}
      if(a==='team-disable')return navigate(()=>Team.openDisable(id));if(a==='team-enable')return Team.enable(id);
      if(a==='invite-resend'||a==='invite-cancel')return Team.invitation(a==='invite-resend'?'resend_invitation':'cancel_invitation',id);
      if(a==='auth-retry')return Team.retryAuth(id);
      if(a==='team-refresh')return Team.load();
      if(a==='member-latest'&&P.modal.latestMember){P.modal.member=P.modal.latestMember;P.modal.latestMember=null;P.errors={};return plannerRender();}
      if(a==='series-edit'||a==='series-stop'){const modal=P.modal;return navigate(()=>{P.modal=modal;return Series.open(a==='series-stop');});}
      if(a==='series-reload'&&P.modal.latestSeries){const s=P.modal.latestSeries;return s.active?Series.open(false,s):Planner.open(P.modal.task.id);}
      if(a==='series-apply'&&P.modal.latestSeries){if(!P.modal.latestSeries.active){P.errors._form='Повторение завершено. Загрузите актуальные данные.';return plannerRender();}const own=Series.payload(P.form),base=Series.payload(JSON.parse(P.modal.baseline));P.modal.series=P.modal.latestSeries;P.modal.latestSeries=null;return Series.save(undefined,Object.fromEntries(Object.entries(own).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(base[key]))));}
    }
  };
  const Comments={rows:[],cursor:null,total:0,draft:'',draftRevision:0,edit:null,latest:null,error:'',deleting:null,loading:false,
    clear(){Comments.draftRevision++;delete Work.pending.comment;Comments.rows=[];Comments.cursor=null;Comments.total=0;Comments.draft='';Comments.edit=null;Comments.latest=null;Comments.error='';Comments.deleting=null;},
    dirty(){return !!P.modal?.task&&(Comments.edit?Comments.draft!==Comments.edit.body:!!Comments.draft.trim());},
    async open(){P.tab='comments';plannerRender(false);return Comments.load();},
    async load(append=false,latest=false,render=true){
      const id=P.modal?.task?.id,generation=State.generation;if(!id)return;Comments.loading=true;
      try{const r=await Api.rpc('list_comments',{p_team_id:State.context.team.id,p_task_id:id,p_cursor:append?Comments.cursor:null,p_latest:latest});
        if(generation!==State.generation||P.modal?.task?.id!==id)return;
        Comments.rows=append?[...Comments.rows,...r.comments]:r.comments;Comments.cursor=r.next_cursor;Comments.total=r.total;P.modal.task.comment_count=r.total;
        if(Comments.edit){const current=Comments.rows.find(c=>c.id===Comments.edit.id);if(current&&current.version!==Comments.edit.version){Comments.latest=current;Comments.error='Комментарий изменился у коллеги. Ваш текст сохранён.';}}
      }catch(e){Comments.error=normalizeError(e).message;}finally{Comments.loading=false;if(State.context&&render){plannerRender();if(latest)requestAnimationFrame(()=>document.querySelector('#task-dialog .comment-entry:last-child')?.scrollIntoView({block:'end'}));}}
    },
    render(){
      const t=P.modal.task;return `<div class="comments-toolbar"><span>${Comments.total} комментариев</span><button class="button-link" data-action="work-comments-latest">К новым сообщениям</button></div><div class="comments-list">${Comments.rows.map(c=>`<article class="comment-entry" data-comment-id="${c.id}"><div class="comment-heading"><strong>${escape(c.author_name)}</strong><time>${Work.dateTime(c.created_at)}${c.edited?' · Изменён':''}</time></div><p class="comment-body">${c.deleted_at?'Комментарий удалён':Work.text(c.body)}</p>${!t.deleted_at&&(c.can_edit||c.can_delete)?`<div class="form-actions">${c.can_edit?`<button class="button-link" data-action="work-comment-edit" data-id="${c.id}">Изменить комментарий</button>`:''}${c.can_delete?`<button class="button-link" data-action="work-comment-delete" data-id="${c.id}">Удалить комментарий</button>`:''}</div>`:''}</article>`).join('')||`<p class="empty-state">${Comments.loading?'Загружаем комментарии…':'Комментариев пока нет.'}</p>`}</div>${Comments.cursor?'<button class="button button-secondary" data-action="work-comments-more">Ещё комментарии</button>':''}${Comments.deleting?`<div class="notice notice-warning" role="alert">Удалить комментарий ${escape(Comments.deleting.author_name)}? Останется отметка об удалении.<div class="form-actions"><button class="button button-primary" data-action="work-comment-confirm-delete">Подтвердить удаление</button><button class="button button-secondary" data-action="work-comment-keep">Оставить комментарий</button></div></div>`:''}${Comments.error?`<p class="field-error" role="alert">${escape(Comments.error)}</p>`:''}${Comments.latest?'<div class="form-actions"><button class="button-link" data-action="work-comment-reload">Загрузить актуальный комментарий</button><button class="button-link" data-action="work-comment-apply">Применить мой текст после проверки</button></div>':''}${t.deleted_at?'<p class="field-hint">Удалённую задачу комментировать нельзя.</p>':`<form class="task-form comment-composer" data-form="work-comment" novalidate><label class="field" for="comment-draft">${Comments.edit?'Изменение комментария':'Новый комментарий'}<textarea id="comment-draft" data-comment-draft maxlength="4000" rows="4">${escape(Comments.draft)}</textarea></label><div class="form-actions"><button class="button button-primary" type="submit" ${State.busy?'disabled':''}>${State.busy?'Сохраняем…':Comments.edit?'Сохранить комментарий':'Отправить комментарий'}</button>${Comments.edit?'<button class="button button-secondary" type="button" data-action="work-comment-cancel">Отменить редактирование</button>':''}</div></form>`}`;
    },
    async save(action=Comments.edit?'update':'create'){
      const t=P.modal?.task,c=action==='delete'?Comments.deleting:Comments.edit;if(!t)return;
      const params={p_team_id:State.context.team.id,p_action:action,p_task_id:t.id,p_comment_id:c?.id||null,p_body:action==='delete'?null:Comments.draft,p_expected_version:c?.version||null};
      return Work.run('comment',params,op=>Api.rpc('mutate_comment',{...params,p_operation_id:op}),async()=>{if(action!=='delete'||Comments.edit?.id===c?.id){Comments.draftRevision++;Comments.draft='';Comments.edit=null;Comments.latest=null;}Comments.deleting=null;Comments.error='';await Comments.load();await Planner.load();await Notifications.load(false,false);});
    }
  };
  const Daily={data:null,error:'',pending:false,claiming:false,banner:null,revision:0,loadedRevision:-1,loadedAt:0,retryAt:0,animationSince:0,celebrationUntil:0,confettiTimer:null,returnFocus:'quick-title',
    clear(){Daily.data=null;Daily.error='';Daily.pending=false;Daily.claiming=false;Daily.banner=null;Daily.revision=0;Daily.loadedRevision=-1;Daily.loadedAt=0;Daily.retryAt=0;Daily.animationSince=0;Daily.celebrationUntil=0;clearTimeout(Daily.confettiTimer);},
    invalidate(){Daily.revision++;},
    async load(force=false){
      if(!State.context||Daily.pending||!force&&Daily.loadedRevision===Daily.revision&&Date.now()-Daily.loadedAt<30000)return;
      const generation=State.generation,revision=Daily.revision;Daily.pending=true;
      try{const r=await Api.rpc('get_weekly_progress',{p_team_id:State.context.team.id});if(generation!==State.generation||!State.context)return;
        Daily.data=r;Daily.error='';Daily.loadedAt=Date.now();Daily.loadedRevision=revision;
        if(Daily.banner){Daily.banner=r.own_support?.id===Daily.banner.id?{id:Daily.banner.id,payload:r.own_support.payload}:null;}
      }catch(e){if(generation!==State.generation)return;Daily.error=normalizeError(e).message;Daily.loadedAt=Date.now();Daily.loadedRevision=revision;}
      finally{if(generation===State.generation){Daily.pending=false;if(State.context)plannerRender();if(Daily.revision!==revision)void Daily.load();}}
    },
    async maybeShow(){
      const own=Daily.data?.own_support;
      if(!State.context||State.busy||document.hidden||document.querySelector('dialog[open]')||Daily.claiming||Daily.banner||!own||own.read_at||Date.now()<Daily.retryAt)return;
      const generation=State.generation;Daily.claiming=true;
      try{const r=await Api.rpc('claim_daily_support',{p_team_id:State.context.team.id,p_notification_id:own.id});
        if(generation!==State.generation||!State.context)return;
        if(Daily.data?.own_support?.id===own.id)Daily.data.own_support.read_at=r.notification?.read_at||'claimed';
        if(r.claimed){Daily.returnFocus=document.activeElement?.id||'quick-title';Daily.animationSince=Date.now();Daily.celebrationUntil=r.notification.payload.category==='complete'?Date.now()+3000:0;Daily.banner={id:own.id,payload:r.notification.payload};await Notifications.load(false,false);}
      }catch(e){if(generation===State.generation){Daily.retryAt=Date.now()+60000;Daily.error=normalizeError(e).message;}}
      finally{if(generation===State.generation){Daily.claiming=false;if(State.context)plannerRender();}}
    },
    afterRender(){
      const dialog=document.getElementById('daily-support-dialog');if(!dialog)return;
      if(!dialog.open){dialog.showModal();document.getElementById('daily-support-close')?.focus({preventScroll:true});}
      clearTimeout(Daily.confettiTimer);if(Daily.celebrationUntil>Date.now())Daily.confettiTimer=setTimeout(()=>document.querySelector('.support-confetti')?.remove(),Daily.celebrationUntil-Date.now());
    },
    dismiss(){const target=Daily.returnFocus;document.getElementById('daily-support-dialog')?.close();Daily.banner=null;Daily.celebrationUntil=0;clearTimeout(Daily.confettiTimer);plannerRender(false);(document.getElementById(target)||document.getElementById('quick-title'))?.focus({preventScroll:true});},
    renderBanner(){const b=Daily.banner;if(!b)return '';const p=b.payload,elapsed=Math.min(3000,Math.max(0,Date.now()-Daily.animationSince));
      const confetti=p.category==='complete'&&Daily.celebrationUntil>Date.now()&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
      const pieces=confetti?'<div class="support-confetti" aria-hidden="true">'+Array.from({length:28},(_,i)=>'<i style="--x:'+((i*37)%100)+'%;--r:'+((i*47)%360)+'deg;--drift:'+((i%2?1:-1)*(10+i*3))+'px;--duration:'+(1.7+i%7*.15)+'s;--tone:'+['#126a31','#dc3377','#c66610','#7550bf'][i%4]+';animation-delay:calc('+(i%5*.08)+'s - '+elapsed+'ms)"></i>').join('')+'</div>':'';
      return `<dialog id="daily-support-dialog" class="daily-support support-${escape(p.category)}" aria-labelledby="support-title" aria-describedby="support-message" style="--support-elapsed:-${elapsed}ms">${pieces}<p class="support-eyebrow">${escape(Calendar.format(p.date))} · Итог рабочего дня</p><h2 id="support-title">${escape(p.subject_name)}</h2><div class="support-percent">${p.progress_percent===null?'✦':number(p.progress_percent)+'%'}</div><p class="support-count">${p.planned_count?`${p.plan_done_count} из ${p.planned_count} задач выполнено`:'Нет запланированных задач'}</p><p id="support-message" class="support-message">${escape(p.message)}</p>${p.early_done_count?`<p class="support-early">Сделано заранее: ${p.early_done_count}</p>`:''}<button id="daily-support-close" class="button support-close" type="button" data-action="daily-dismiss" aria-label="Закрыть сообщение поддержки">${p.category==='complete'?'Отлично!':'Продолжить'}</button></dialog>`;
    },
    render(){
      const heading='<div class="section-heading"><div><h2 id="daily-progress-title">Личная динамика</h2><p class="field-hint">Текущая неделя · Все направления · Результат по срокам / выполнено</p></div><button class="button-link" data-action="daily-refresh">Обновить динамику</button></div>';
      if(!Daily.data)return `<section class="panel daily-progress" aria-labelledby="daily-progress-title">${heading}<p class="field-hint" role="status">${Daily.error?'Динамика временно недоступна. Основной план продолжает работать.':'Загружаем личную динамику…'}</p></section>`;
      const d=Daily.data;
      return `<section class="panel daily-progress" aria-labelledby="daily-progress-title">${heading}<p class="field-hint">${Calendar.format(d.week_start)} — ${Calendar.format(d.week_end)} · Москва</p>${Daily.error?'<p class="field-hint" role="status">Не удалось обновить динамику. Показан предыдущий результат.</p>':''}<div class="daily-member-grid">${d.members.map(m=>{
        const max=Math.max(1,...m.days.map(day=>day.planned_count)),own=m.user_id===State.context.user.id;
        return `<article class="daily-member" data-progress-user="${escape(m.user_id)}"><h3>${escape(m.display_name)}${own?' <span class="field-hint">· Вы</span>':''}</h3><div class="daily-chart" role="list" aria-label="Динамика: ${escape(m.display_name)}">${m.days.map(day=>`<div class="daily-day ${day.is_weekend?'daily-weekend':''} ${day.is_future?'daily-future':''}" role="listitem" ${day.is_today?'aria-current="date"':''} aria-label="${escape(Calendar.format(day.date))}: запланировано ${day.planned_count}, выполнено ${day.plan_done_count}, ${day.progress_percent===null?'нет плана':day.progress_percent+' процентов'}"><span class="daily-counts"><span>${day.planned_count}</span><span>${day.plan_done_count}</span></span><div class="daily-bars" aria-hidden="true"><i class="daily-bar-plan" style="height:${day.planned_count/max*64}px"></i><i class="daily-bar-done" style="height:${day.plan_done_count/max*64}px"></i></div><strong>${escape(Calendar.format(day.date,{weekday:'short'}))}</strong><span class="field-hint">${escape(Calendar.format(day.date,{day:'numeric'}))}</span>${day.early_done_count?`<small class="daily-early" title="Сделано заранее">+${day.early_done_count} заранее</small>`:''}</div>`).join('')}</div><p class="daily-legend"><span><i></i>План</span><span><i></i>Выполнено</span></p>${m.support?`<div class="daily-member-support support-${escape(m.support.category)}"><strong>Итог ${Calendar.format(m.support.date)}</strong><p>${escape(m.support.message)}</p><span class="field-hint">${m.support.planned_count?`${m.support.plan_done_count} из ${m.support.planned_count} · ${m.support.progress_percent}%`:'Нет запланированных задач'}</span>${m.support.early_done_count?`<p class="early-result">Сделано заранее: ${m.support.early_done_count}</p>`:''}</div>`:'<p class="field-hint">Поддерживающий итог — по будням с 17:45 по Москве.</p>'}</article>`;
      }).join('')}</div></section>`;
    }
  };

  const Notifications={rows:[],unread:0,unreadOnly:false,cursor:null,snapshot:null,error:'',
    clear(){Notifications.rows=[];Notifications.unread=0;Notifications.cursor=null;Notifications.snapshot=null;Notifications.error='';Notifications.unreadOnly=false;},
    async load(append=false,render=true){const generation=State.generation;try{
      const r=await Api.rpc('get_notifications',{p_team_id:State.context.team.id,p_unread_only:Notifications.unreadOnly,p_cursor:append?Notifications.cursor:null});if(generation!==State.generation)return;
      Notifications.rows=append?[...Notifications.rows,...r.notifications]:r.notifications;Notifications.unread=r.unread_count;Notifications.cursor=r.next_cursor;Notifications.snapshot=r.snapshot_at;Notifications.error='';
    }catch(e){Notifications.error=normalizeError(e).message;}if(render&&State.context)plannerRender();},
    async open(){P.modal={mode:'notifications'};P.form=null;P.errors={};P.focusModal=true;plannerRender(false);await Notifications.load();},
    label(n){if(n.type==='daily_support')return `Итог дня · ${n.payload.subject_name}: ${n.payload.message}`;return ({assigned:'Вам назначена задача',comment:'Новый комментарий',completed:'Назначенная задача выполнена',due_tomorrow:'Срок задачи завтра',due_today:'Срок задачи сегодня',overdue:`Есть просроченные задачи: ${n.payload.count||0}`,bulk_assigned:`Вам переданы задачи: ${n.payload.task_count||0}; повторения: ${n.payload.series_count||0}`})[n.type]||'Изменения в команде';},
    render(){return `<div class="notifications-toolbar"><div class="notification-filters"><button class="button button-secondary" data-action="work-notifications-all" aria-pressed="${!Notifications.unreadOnly}">Все</button><button class="button button-secondary" data-action="work-notifications-unread" aria-pressed="${Notifications.unreadOnly}">Непрочитанные</button></div><button class="button-link" data-action="work-notifications-read-all" ${!Notifications.unread||State.busy?'disabled':''}>Прочитать все</button></div>${Notifications.error?`<p class="field-error" role="alert">${escape(Notifications.error)}</p>`:''}<div class="notification-list">${Notifications.rows.map(n=>`<button class="notification-item ${n.read_at?'':'unread'}" data-action="work-notification-open" data-id="${n.id}"><strong>${escape(Notifications.label(n))}</strong>${n.payload.title?`<span>${escape(n.payload.title)}</span>`:''}<time>${Work.dateTime(n.created_at)}</time></button>`).join('')||'<p class="empty-state">Здесь пока нет уведомлений.</p>'}</div>${Notifications.cursor?'<button class="button button-secondary" data-action="work-notifications-more">Ещё уведомления</button>':''}${Planner.modalErrors()}`;},
    async readAll(){const params={p_team_id:State.context.team.id,p_ids:null,p_before:Notifications.snapshot};return Work.run('notifications',params,op=>Api.rpc('read_notifications',{...params,p_operation_id:op}),()=>Notifications.load());},
    async openItem(id){const item=Notifications.rows.find(n=>n.id===id);if(!item)return;
      const params={p_team_id:State.context.team.id,p_ids:[id],p_before:null};
      return Work.run('notifications',params,op=>Api.rpc('read_notifications',{...params,p_operation_id:op}),async()=>{
        await Notifications.load(false,false);if(item.task_id){await Planner.open(item.task_id);if(item.type==='comment')await Comments.open();}
        else {P.modal=null;State.view='home';P.filters.employee_id=item.payload.team_summary?null:State.context.user.id;Planner.save();await Planner.load();if(item.type==='overdue')await Planner.collection('overdue');}
      });
    }
  };
  const Team={data:null,form:{name:'',email:''},error:'',loading:false,retryUntil:0,
    clear(){Team.data=null;Team.form={name:'',email:''};Team.error='';Team.retryUntil=0;},
    dirty(){return State.view==='team'&&!!(Team.form.name||Team.form.email);},
    async open(){if(State.context.member.role!=='manager')return;State.view='team';P.modal=null;P.form=null;State.message=null;Team.loading=true;plannerRender(false);await Team.load();},
    async load(render=true){if(Date.now()<Team.retryUntil){if(render)plannerRender();return;}const generation=State.generation;Team.loading=true;try{const r=await Api.admin('list_team_admin');if(generation!==State.generation)return;Team.data=r;Team.error='';}catch(error){const e=normalizeError(error);Team.error=e.message;if(e.code==='RATE_LIMITED'){Team.retryUntil=Date.now()+(e.retry_after_seconds||60)*1000;Team.error=`Слишком много запросов. Повторите через ${e.retry_after_seconds||60} секунд.`;}}finally{Team.loading=false;if(State.context&&render)plannerRender();}},
    render(){const states={active:'Активен',disabled:'Отключён',invited:'Приглашён',pending:'Отправляется',sent:'Отправлено',failed:'Не отправлено',expired:'Срок ссылки истёк',cancelled:'Отменено'};
      return `<h1>Команда</h1><p class="workspace-lead">${Config.emailDeliveryEnabled?'Участники, приглашения и передача задач.':'Участники и передача задач.'}</p>${Team.error?`<p class="notice notice-error" role="alert">${escape(Team.error)}</p>`:''}${Config.emailDeliveryEnabled?`<section class="panel invite-panel"><h2>Пригласить сотрудника</h2><p class="lead">Приглашённый получит ссылку для настройки доступа. Роль — сотрудник.</p><form class="invite-form" data-form="work-invite" novalidate><label class="field" for="invite-name">Имя<input id="invite-name" data-team-field="name" maxlength="80" value="${escape(Team.form.name)}" autocomplete="name" aria-invalid="${!!P.errors.invite_name}"><span class="field-error">${escape(P.errors.invite_name||'')}</span></label><label class="field" for="invite-email">Email<input id="invite-email" data-team-field="email" type="email" maxlength="254" value="${escape(Team.form.email)}" autocomplete="email" aria-invalid="${!!P.errors.invite_email}"><span class="field-error">${escape(P.errors.invite_email||'')}</span></label><button class="button button-primary" type="submit" ${State.busy||Team.loading?'disabled':''}>${State.busy?'Отправляем…':'Отправить приглашение'}</button></form></section>`:''}<section class="team-section"><div class="section-heading"><h2>Участники</h2><button class="button-link" data-action="work-team-refresh">Обновить команду</button></div>${!Team.data?`<p role="status">${Team.loading?'Загружаем команду…':'Нет подтверждённых данных.'}</p>`:`<div class="team-members">${Team.data.members.map(m=>`<article class="panel member-card"><div class="member-heading"><h3>${escape(m.display_name)}</h3><span class="status-pill">${states[m.state]}</span></div><p class="member-email">${escape(m.email)}</p><p class="field-hint">${m.role==='manager'?'Руководитель':'Сотрудник'} · Активных задач: ${m.active_task_count} · Серий: ${m.active_series_count}</p><div class="form-actions">${m.state==='active'?`<button class="button-link" data-action="work-team-disable" data-id="${m.user_id}">Отключить</button>`:m.state==='disabled'?`<button class="button-link" data-action="work-team-enable" data-id="${m.user_id}">Включить снова</button>`:''}${m.auth_retry?`<button class="button-link" data-action="work-auth-retry" data-id="${m.user_id}">Повторить настройку доступа</button>`:''}</div>${m.auth_retry?'<p class="field-hint">Изменения в команде сохранены. Дополнительная настройка входа ожидает повтора.</p>':''}</article>`).join('')}</div>`}</section>${Config.emailDeliveryEnabled?`<section class="team-section"><h2>Приглашения</h2>${(Team.data?.invitations||[]).map(i=>{const wait=Math.max(0,Math.ceil((Date.parse(i.last_attempt_at||0)+60000-Work.now())/1000));return `<article class="panel invitation-card"><div class="member-heading"><h3>${escape(i.display_name)}</h3><span class="status-pill">${states[i.state]}</span></div><p class="member-email">${escape(i.email)}</p>${i.state==='failed'?'<p class="field-error">Отправка не подтверждена. Можно повторить.</p>':''}${i.state==='sent'?'<p class="field-hint">Почтовый сервис принял письмо. Получение адресатом не подтверждается.</p>':''}${!['cancelled','accepted'].includes(i.state)?`<div class="form-actions"><button class="button-link" data-action="work-invite-resend" data-id="${i.id}" ${wait||State.busy?'disabled':''}>Отправить повторно${wait?' · '+wait+' с':''}</button><button class="button-link" data-action="work-invite-cancel" data-id="${i.id}">Отменить приглашение</button></div>`:''}</article>`;}).join('')||'<p class="field-hint">Приглашений пока нет.</p>'}</section>`:''}`;
    },
    invite(){if(!Config.emailDeliveryEnabled){setMessage('Письма отключены. Доступ настраивает владелец планировщика.');plannerRender();return;}const payload={email:Team.form.email,display_name:Team.form.name};return Work.run('team',payload,op=>Api.admin('invite_employee',payload,null,op),async r=>{Team.form={name:'',email:''};setMessage(r.entity.state==='sent'?'Приглашение отправлено.':r.entity.state==='failed'?'Отправка приглашения не подтверждена.':'Приглашение сохранено; проверьте его состояние.',r.entity.state==='failed'?'error':'success');await Team.load();});},
    invitation(action,id){const i=Team.data.invitations.find(i=>i.id===id),params={invitation_id:id};return Work.run('team',[action,params,i.version],op=>Api.admin(action,params,i.version,op),async r=>{setMessage(r.entity.state==='failed'?'Отправка не подтверждена.':'Приглашение обновлено.',r.entity.state==='failed'?'error':'success');await Team.load();});},
    openDisable(id){const m=Team.data.members.find(m=>m.user_id===id);if(!m)return;P.form={replacement_id:''};P.modal={mode:'team-disable',member:m,baseline:JSON.stringify(P.form)};P.errors={};P.focusModal=true;plannerRender(false);},
    disableForm(){const m=P.modal.member;return `<p class="modal-task-name">${escape(m.display_name)}</p><p>Активных задач: ${m.active_task_count}. Незавершённых серий: ${m.active_series_count}.</p><p class="field-hint">Доступ закроется. Завершённые задачи и история останутся у прежнего исполнителя.</p><form class="task-form" data-form="work-disable" novalidate>${m.active_task_count+m.active_series_count?Planner.formField('replacement_id','Новый исполнитель',{options:{'':'Выберите участника',...Object.fromEntries(Team.data.members.filter(x=>x.state==='active'&&x.user_id!==m.user_id).map(x=>[x.user_id,x.display_name]))}}):''}${Planner.modalErrors()}<div class="modal-actions"><button type="submit" class="button button-primary" ${State.busy?'disabled':''}>Отключить и передать</button><button type="button" class="button button-secondary" data-action="planner-close">Назад</button></div></form>`;},
    disable(){const m=P.modal.member,payload={user_id:m.user_id,replacement_id:P.form.replacement_id||null};return Work.run('team',['disable',payload,m.version],op=>Api.admin('disable_employee',payload,m.version,op),async r=>{P.modal=null;P.form=null;setMessage(r.auth_sync_pending?'Задачи переданы, доступ к данным закрыт. Настройку входа нужно повторить.':'Сотрудник отключён, задачи переданы.',r.auth_sync_pending?'warning':'success');await Team.load();});},
    enable(id){const m=Team.data.members.find(m=>m.user_id===id),payload={user_id:id};return Work.run('team',['enable',id,m.version],op=>Api.admin('enable_employee',payload,m.version,op),async r=>{setMessage(r.auth_sync_pending?'Членство восстановлено. Дополнительная настройка входа ожидает повтора.':'Сотрудник снова подключён. Задачи назад не передавались.',r.auth_sync_pending?'warning':'success');await Team.load();});},
    retryAuth(id){const retry=Team.data.members.find(m=>m.user_id===id)?.auth_retry;if(!retry)return;return Work.run('team',['auth',retry],()=>Api.admin(retry.action,retry.payload,retry.expected_version,retry.operation_id),()=>Team.load());}
  };
  const Series={labels:{none:'Не повторять',daily:'Каждый день',workdays:'По рабочим дням',weekly:'Еженедельно',monthly:'Ежемесячно'},
    latestSummary(s){return `<details class="conflict-current" open><summary>Актуальное правило повторения</summary><p><strong>${escape(s.template.title)}</strong> · ${Series.labels[s.frequency]} · ${s.active?'Действует':'Повторение завершено'}</p><p>Начало: ${Calendar.format(s.start_date)}. Конец: ${s.end_date?Calendar.format(s.end_date):'Не задан'}. Длительность: ${s.duration_days}. Смещение срока: ${s.deadline_offset_days===null?'Не задано':s.deadline_offset_days}.</p>${s.weekdays?`<p>Дни недели: ${s.weekdays.map(day=>['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'][day-1]).join(', ')}</p>`:''}<p class="comment-body">${escape(s.template.description||'Описание не добавлено.')}</p></details>`;},
    history(change){const names={frequency:'Повторение',weekdays:'Дни недели',month_day:'Число месяца',end_date:'Последний день',duration_days:'Длительность',deadline_offset_days:'Смещение срока',active:'Действует',scope_from:'Применяется с'};const value=(key,v)=>v===null||v===undefined?'Не задано':key==='frequency'?Series.labels[v]:Array.isArray(v)?v.join(', '):typeof v==='boolean'?(v?'Да':'Нет'):String(v);return '<ul>'+Object.entries(names).filter(([key])=>JSON.stringify(change.before?.[key])!==JSON.stringify(change.after?.[key])).map(([key,label])=>`<li><strong>${label}:</strong> ${escape(value(key,change.before?.[key]))} → ${escape(value(key,change.after?.[key]))}</li>`).join('')+'</ul>';},
    repeatFields(){const f=P.form;return `<fieldset class="repeat-fields"><legend>Повторение</legend>${Planner.formField('frequency','Как повторять',{options:P.modal.mode==='series-edit'?Object.fromEntries(Object.entries(Series.labels).filter(([key])=>key!=='none')):Series.labels})}${f.frequency!=='none'?`${f.frequency==='weekly'?`<div class="weekday-choices" role="group" aria-label="Дни повторения">${['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map((day,i)=>`<label><input type="checkbox" data-weekday="${i+1}" ${f.weekdays.includes(i+1)?'checked':''}>${day}</label>`).join('')}</div>`:''}${f.frequency==='monthly'?Planner.formField('month_day','Число месяца',{type:'number',hint:'Если такого числа нет, используется последний день месяца.'}):''}${Planner.formField('repeat_end','Последний день повторения',{type:'date',hint:'Можно оставить пустым. Длительность и смещение срока сохранятся для каждого экземпляра.'})}`:''}</fieldset>`;},
    summary(){const s=P.modal?.series,t=P.modal?.task;if(!s)return '';return `<div class="series-summary"><p>${Series.labels[s.frequency]} · ${s.active?'повторение действует':'повторение завершено'}${t.occurrence_date?' · дата экземпляра '+Calendar.format(t.occurrence_date):''}</p>${s.can_manage&&s.active?`<div class="form-actions"><button class="button button-secondary" data-action="work-series-edit">${t.occurrence_date<P.data.today?'Изменить будущие повторения':'Эту и будущие'}</button><button class="button-link" data-action="work-series-stop">Завершить повторение</button></div>`:''}</div>`;},
    async open(stop=false,latest=null){const s=latest||P.modal?.series,t=P.modal?.task,modal=P.modal,generation=State.generation;if(!s)return;const boundary=stop?Calendar.add(P.data.today,1):t?.occurrence_date>=P.data.today?t.occurrence_date:P.data.today;
      try{const preview=await Api.rpc('preview_series',{p_team_id:State.context.team.id,p_series_id:s.id,p_boundary:boundary});if(P.modal!==modal||generation!==State.generation)return;const rule={...preview.series,...preview.rule,version:preview.series.version},template=rule.template;
        P.form=stop?{end_date:P.data.today}:{title:template.title,description:template.description,plan_start:boundary,plan_end:Calendar.add(boundary,rule.duration_days-1),deadline:rule.deadline_offset_days===null?'':Calendar.add(boundary,rule.deadline_offset_days),assignee_id:rule.assignee_id,direction:template.direction||'none',priority:template.important===null?'unset':template.important?(template.urgent?'important_urgent':'important_not_urgent'):(template.urgent?'not_important_urgent':'not_important_not_urgent'),frequency:rule.frequency,weekdays:rule.weekdays||[],month_day:rule.month_day||Number(boundary.slice(8)),repeat_end:rule.end_date||''};
        P.modal={mode:stop?'series-stop':'series-edit',series:rule,task:t,boundary,affected:preview.affected_count,baseline:JSON.stringify(P.form)};P.errors={};P.focusModal=true;plannerRender(false);
      }catch(e){if(generation!==State.generation)return;setMessage(normalizeError(e).message);plannerRender();}
    },
    render(){const stop=P.modal.mode==='series-stop',owners=Object.fromEntries(P.data.members.filter(m=>m.state==='active').map(m=>[m.user_id,m.display_name]));
      return `<p class="notice notice-warning">${stop?'Будущие экземпляры после выбранной даты будут убраны. Текущие активные задачи останутся.':`Изменения действуют с ${Calendar.format(P.modal.boundary)}. Затронуто уже созданных экземпляров: ${P.modal.affected}. Их индивидуальные изменения будут заменены. Прошлые и выполненные задачи сохранятся.`}</p><form class="task-form" data-form="work-series" novalidate>${stop?Planner.formField('end_date','Завершить повторение после даты',{type:'date'}):`<div class="task-fields">${Planner.formField('title','Название')}${Planner.formField('description','Описание',{type:'textarea'})}${Planner.formField('plan_start','Начало расписания',{type:'date'})}${Planner.formField('plan_end','Последний день первого экземпляра',{type:'date'})}${Planner.formField('assignee_id','Исполнитель',{options:owners,readonly:State.context.member.role!=='manager'})}${Planner.formField('direction','Направление',{options:Object.fromEntries(Object.entries(Directions).filter(([key])=>key!=='all'))})}${Planner.formField('priority','Приоритет',{options:Priorities})}${Planner.formField('deadline','Срок первого экземпляра',{type:'date'})}</div>${Series.repeatFields()}`}${Planner.modalErrors()}${P.modal.latestSeries?'<div class="form-actions"><button type="button" class="button-link" data-action="work-series-reload">Загрузить актуальное правило</button><button type="button" class="button-link" data-action="work-series-apply">Применить мои изменения после проверки</button></div>':''}<div class="modal-actions"><button type="submit" class="button button-primary" ${State.busy?'disabled':''}>${stop?'Завершить повторение':'Применить'}</button><button type="button" class="button button-secondary" data-action="planner-close">Назад</button></div></form>`;
    },
    payload(f){if(P.modal.mode==='series-stop')return {end_date:f.end_date};return {title:f.title,description:f.description,direction:f.direction==='none'?null:f.direction,important:f.priority==='unset'?null:f.priority.startsWith('important_'),urgent:f.priority==='unset'?null:f.priority.endsWith('_urgent')&&!f.priority.endsWith('_not_urgent'),assignee_id:f.assignee_id,frequency:f.frequency,weekdays:f.frequency==='weekly'?f.weekdays:null,month_day:f.frequency==='monthly'?Number(f.month_day):null,start_date:f.plan_start,end_date:f.repeat_end||null,duration_days:Math.round((Date.parse(f.plan_end)-Date.parse(f.plan_start))/86400000)+1,deadline_offset_days:f.deadline?Math.round((Date.parse(f.deadline)-Date.parse(f.plan_start))/86400000):null};},
    save(action=P.modal.mode==='series-stop'?'stop':'update',patch=null){
      const s=P.modal.series,payload=patch||Series.payload(P.form);
      const params={p_team_id:State.context.team.id,p_action:action,p_series_id:action==='create'?null:s.id,p_boundary:action==='create'?null:P.modal.boundary,p_payload:payload,p_expected_version:action==='create'?null:s.version};
      return Work.run('series',params,op=>Api.rpc('mutate_series',{...params,p_operation_id:op}),async()=>{P.modal=null;P.form=null;if(action==='create')P.quick='';setMessage('Повторение сохранено.','success');await Planner.load();await Notifications.load(false,false);});
    }
  };
  const Sync={channel:null,version:0,pending:false,timer:null,interval:null,inFlight:null,live:false,retryUntil:0,
    stop(){clearTimeout(Sync.timer);clearInterval(Sync.interval);Sync.timer=null;Sync.interval=null;Sync.pending=false;Sync.version=0;Sync.live=false;Sync.inFlight=null;Sync.retryUntil=0;Work.retryUntil={};if(Sync.channel){State.client?.removeChannel(Sync.channel).catch(()=>{});Sync.channel=null;}},
    async start(){Sync.stop();const generation=State.generation;const r=await Api.rpc('sync_workspace',{p_team_id:State.context.team.id});if(generation!==State.generation||!State.context)return;Sync.version=r.state_version;await Planner.init();if(generation!==State.generation||!State.context)return;await Notifications.load(false,false);if(generation!==State.generation||!State.context)return;
      const team=State.context.team.id;Sync.channel=State.client.channel('ritm:'+team).on('postgres_changes',{event:'UPDATE',schema:'public',table:'teams',filter:'id=eq.'+team},payload=>{
        const version=Number(payload.new?.state_version||0);if(version<=Sync.version)return;Sync.version=version;Daily.invalidate();Sync.schedule();
      }).subscribe(status=>{Sync.live=status==='SUBSCRIBED';if(status==='SUBSCRIBED')Sync.schedule();if(State.context)plannerRender();});
      Sync.interval=setInterval(()=>{if(!document.hidden)Sync.refresh();},60000);
    },
    schedule(){Sync.pending=true;clearTimeout(Sync.timer);Sync.timer=setTimeout(()=>Sync.refresh(),200);},
    async refresh(){
      if(!State.context||document.hidden)return;if(State.busy){Sync.pending=true;clearTimeout(Sync.timer);Sync.timer=setTimeout(()=>Sync.refresh(),600);return;}
      if(Date.now()<Sync.retryUntil)return;if(Sync.inFlight){Sync.pending=true;return Sync.inFlight;}
      const generation=State.generation;Sync.pending=false;
      const run=async()=>{try{
        const access=await Api.access();if(generation!==State.generation||!State.context)return;State.context=access;
        const current=await Api.rpc('sync_workspace',{p_team_id:access.team.id});if(generation!==State.generation||!State.context)return;
        const oldToday=P.data?.today,selectedDate=oldToday!==current.today&&P.date===oldToday&&!P.targetDate?current.today:undefined;Sync.version=Math.max(Sync.version,current.state_version);Reports.changed(current.state_version);
        await Planner.load({render:false,selectedDate});if(generation!==State.generation||!State.context)return;await Notifications.load(false,false);
        const id=P.modal?.task?.id;if(id){const data=await Api.rpc('get_task_detail',{p_team_id:access.team.id,p_task_id:id});if(generation!==State.generation||P.modal?.task?.id!==id)return;
          if(['edit','move','cancel','delete'].includes(P.modal.mode)&&data.task.version!==P.modal.task.version){P.modal.latest=data.task;P.errors._form='Задача изменилась у коллеги. Ваши данные сохранены в форме.';}
          else if(P.modal.mode==='detail'){P.modal.task=data.task;P.modal.series=data.series;if(P.tab==='comments')await Comments.load(false,false,false);}
        }
        if(State.view==='team'&&!Team.dirty())await Team.load(false);State.connectionLost=false;plannerRender();
      }catch(error){if(generation!==State.generation)return;const e=normalizeError(error);if(e.code==='RATE_LIMITED'){Sync.retryUntil=Date.now()+(e.retry_after_seconds||60)*1000;return;}
        if(['ACCESS_DENIED','UNAUTHENTICATED'].includes(e.code)){await loadAccess({preserve:true});return;}State.connectionLost=true;Views.network();
      }finally{if(generation===State.generation){Sync.inFlight=null;if(State.context&&Sync.pending)Sync.schedule();}}};
      Sync.inFlight=run();return Sync.inFlight;
    }
  };

  // State transitions and Bootstrap.
  function setMessage(text,type='error') { State.message={text,type}; }
  // Reports keep a server snapshot until the user explicitly refreshes it.
  const MetricLabels={planned_count:'План',plan_done_count:'Выполнено из плана',progress_percent:'Выполнение плана',actual_done_count:'Выполнено фактически',early_done_count:'Сделано заранее',remaining_count:'Осталось',overdue_count:'Просрочено',cancelled_count:'Отменено',added_to_plan_count:'Добавлено по ходу периода',status_planned_count:'В плане',in_progress_count:'В работе',waiting_count:'Ожидает ответа',late_done_count:'С опозданием',moved_task_count:'Перенесено задач',manual_moved_task_count:'Перенесено вручную',auto_moved_task_count:'Перенесено автоматически',deleted_unfinished_count:'Удалённые незавершённые',created_count:'Новые задачи'};
  const ReportKpis=['planned_count','plan_done_count','actual_done_count','remaining_count','overdue_count','cancelled_count'];
  const ReportColumns=['planned_count','plan_done_count','progress_percent','actual_done_count','overdue_count'];
  const number=value=>value===null?'—':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(value);
  const reportPeriod=d=>`${Calendar.format(d.period.start,{day:'numeric',month:'long',year:'numeric'})}${d.period.end!==d.period.start?' — '+Calendar.format(d.period.end,{day:'numeric',month:'long',year:'numeric'}):''}`;
  const reportFilters=d=>`${d.filters.employee_label} · ${Directions[d.filters.direction]}`;
  const R={type:'month',date:null,data:null,loading:false,error:'',sequence:0,modal:null,stale:false,filtersChanged:false};
  const Reports={
    clear(){R.sequence++;R.type='month';R.filtersChanged=false;R.data=null;R.modal=null;R.date=null;R.loading=false;R.error='';R.stale=false;},
    async open(){State.view='reports';State.message=null;if(!R.date)R.date=P.data.today;if(!R.data||R.data.filters.employee_id!==P.filters.employee_id||R.data.filters.direction!==P.filters.direction)await Reports.load();else plannerRender();},
    async load(){const seq=++R.sequence,generation=State.generation;R.loading=true;R.error='';R.modal=null;plannerRender();
      try{const data=await Api.rpc('get_report',{p_team_id:State.context.team.id,p_period_type:R.type,p_period_start:R.date,p_employee_id:P.filters.employee_id,p_direction:P.filters.direction});if(seq!==R.sequence||generation!==State.generation||!State.context)return;R.data=data;R.date=data.period.start;R.stale=false;}
      catch(e){if(seq!==R.sequence||generation!==State.generation)return;R.error=normalizeError(e).message;}
      finally{if(seq===R.sequence&&generation===State.generation){R.loading=false;plannerRender();}}
    },
    changed(version){if(R.data&&version>R.data.state_version)R.stale=true;},
    metric(key,metrics,scope='all'){return `<button class="report-number" data-action="report-drill" data-metric="${key}" data-scope="${escape(scope)}" aria-label="${escape(MetricLabels[key])}: ${number(metrics[key])}${key==='progress_percent'&&metrics[key]!==null?'%':''}">${number(metrics[key])}${key==='progress_percent'&&metrics[key]!==null?'%':''}</button>`;},
    table(title,rows,{period=false}={}){return `<section class="panel report-table-panel"><h2>${title}</h2><div class="report-table-scroll" tabindex="0" role="region" aria-label="${title}"><table class="report-table"><thead><tr><th scope="col">${period?'Период':'Участник / направление'}</th>${ReportColumns.map(k=>`<th scope="col">${MetricLabels[k]}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr><th scope="row">${escape(row.label||`${Calendar.format(row.start)} — ${Calendar.format(row.end)}`)}${row.state==='disabled'?'<small>Отключён</small>':''}</th>${ReportColumns.map(k=>`<td>${Reports.metric(k,row.metrics,row.scope)}</td>`).join('')}</tr>`).join('')||'<tr><td colspan="6">Нет задач</td></tr>'}</tbody></table></div></section>`;},
    render(){const d=R.data,memberOptions=`<option value="" ${!P.filters.employee_id?'selected':''}>Все сотрудники</option>`+(P.data?.members||[]).filter(m=>m.state!=='invited').map(m=>`<option value="${m.user_id}" ${P.filters.employee_id===m.user_id?'selected':''}>${escape(m.display_name)}${m.state==='disabled'?' · отключён':''}</option>`).join('');
      const toolbar=`<div class="planner-greeting"><div><p class="card-kicker">Прогресс команды</p><h1>Итоги работы</h1><p class="workspace-lead">План, результаты и задачи, которым нужно внимание.</p></div><button class="button button-primary" data-action="report-export" ${!d||R.loading||R.error?'disabled':''}>Скачать отчёт</button></div><div class="report-toolbar"><div class="report-types" role="group" aria-label="Период итогов">${[['day','День'],['week','Неделя'],['month','Месяц']].map(([k,l])=>`<button class="button ${R.type===k?'button-primary':'button-secondary'}" data-action="report-type" data-type="${k}" aria-pressed="${R.type===k}">${l}</button>`).join('')}</div><div class="period-nav"><button class="icon-button" data-action="report-prev" aria-label="Предыдущий период">‹</button><label class="report-period-input"><span class="sr-only">${R.type==='month'?'Месяц и год':'Дата периода'}</span><input id="report-date" data-report-date type="${R.type==='month'?'month':'date'}" min="2000-01${R.type==='month'?'':'-01'}" max="2100-12${R.type==='month'?'':'-31'}" value="${escape(R.type==='month'?R.date?.slice(0,7):R.date)}"></label><button class="icon-button" data-action="report-next" aria-label="Следующий период">›</button><button class="button-link" data-action="report-today">Текущий период</button></div><div class="main-filters"><label><span>Исполнитель</span><select id="report-employee" data-report-filter="employee_id">${memberOptions}</select></label><label><span>Направление</span><select id="report-direction" data-report-filter="direction">${Object.entries(Directions).map(([k,l])=>`<option value="${k}" ${P.filters.direction===k?'selected':''}>${l}</option>`).join('')}</select></label></div></div>`;
      if(R.loading)return toolbar+'<div class="panel planner-loading" role="status">Рассчитываем итоги…</div>';
      if(R.error)return toolbar+`<div class="notice notice-error" role="alert">${escape(R.error)} <button class="button-link" data-action="report-refresh">Повторить</button></div>`;
      if(!d)return toolbar;
      const m=d.metrics,rows=d.period.type==='day'?['status_planned_count','in_progress_count','waiting_count','plan_done_count','deleted_unfinished_count'].map(k=>({label:MetricLabels[k],metrics:{planned_count:m[k],plan_done_count:0},metric:k})):d.by_subperiod.map(p=>({...p,label:`${Calendar.format(p.start)} — ${Calendar.format(p.end)}`}));
      const maximum=Math.max(1,...rows.map(p=>p.metrics.planned_count));
      const bars=rows.map(p=>`<div class="report-chart-row"><span>${escape(p.label)}</span><div class="report-chart-track"><i class="report-bar-plan" style="width:${100*p.metrics.planned_count/maximum}%"></i>${!p.metric?`<i class="report-bar-done" style="width:${100*p.metrics.plan_done_count/maximum}%"></i>`:''}</div><span>${p.metric?Reports.metric(p.metric,m):`${p.metrics.planned_count} / ${p.metrics.plan_done_count}`}</span></div>`).join('');
      return toolbar+`<div class="report-snapshot"><div><strong>${escape(reportPeriod(d))}</strong><p>${escape(reportFilters(d))} · Снимок ${Work.dateTime(d.snapshot_at)} · Москва${d.period.closed?' · Закрытый период':' · Период ещё не завершён'}</p></div><button class="button-link" data-action="report-refresh">Обновить итоги</button></div>${R.stale?'<p class="notice notice-warning">В команде появились изменения. Показатели и скачивание сохраняют текущий снимок. <button class="button-link" data-action="report-refresh">Получить новый снимок</button></p>':''}<div class="report-kpis">${ReportKpis.map(k=>`<section class="panel report-kpi ${k==='overdue_count'&&m[k]?'report-danger':''}"><h2>${MetricLabels[k]}</h2>${Reports.metric(k,m)}${k==='plan_done_count'?`<span class="report-percent" style="color:${progressColor(m.progress_percent)}">${Reports.metric('progress_percent',m)}</span>`:''}</section>`).join('')}</div><div class="report-progress"><div class="month-bar" style="--progress-color:${progressColor(m.progress_percent)}"><i style="width:${m.progress_percent||0}%"></i></div><p>${m.progress_percent===null?'Нет запланированных задач':`Выполнено ${number(m.progress_percent)}% плана`}</p></div><p class="progress-hint">План — задачи по сроку результата и незавершённые прошлые сроки; фактические результаты — исполнитель и направление при событии. Статус, поиск, срок и приоритет списков не влияют на отчёт.</p><section class="panel report-extra"><h2>Подробности периода</h2><div>${Object.keys(MetricLabels).filter(k=>!ReportKpis.includes(k)&&k!=='progress_percent').map(k=>`<div><span>${MetricLabels[k]}</span>${Reports.metric(k,m)}</div>`).join('')}</div></section><section class="panel report-dynamics"><h2>${d.period.type==='day'?'Состояние плана':'Динамика выполнения'}</h2><p class="field-hint">${d.period.type==='day'?'Выполнено и оставшиеся состояния, включая удалённые незавершённые.':'Оливковый — план, зелёный — выполнено из плана; числа: план / выполнено.'}</p><div class="report-chart">${bars}</div></section>${d.period.type!=='day'?Reports.table('По неделям и дням',d.by_subperiod,{period:true})+'<p class="progress-hint">Задачи уникальны внутри каждого подпериода. Сумма недель или дней не равна итогу периода для длительных и перенесённых задач.</p>':''}${Reports.table('По сотрудникам',d.by_employee)}${Reports.table('По направлениям',d.by_direction)}`;
    },
    renderModal(){const modal=R.modal;if(!modal)return '';let body;
      if(modal.kind==='rows')body=`<p>Снимок ${Work.dateTime(modal.snapshotAt)} · ${modal.total??'…'} задач</p><p class="field-hint">${modal.scope==='all'?'Выбранные фильтры отчёта':'Выбранная строка отчёта'}. Показаны сохранённые данные; подробности открывают текущее состояние задачи.</p>${modal.rows.map(t=>`<article class="report-fact"><button class="button-link" data-action="report-task" data-id="${t.id}">${escape(t.title)}</button><small>${escape(t.assignee_name)} · ${Directions[t.direction||'none']} · ${Statuses[t.status]}${t.deleted?' · Удалена':''}${t.repeated?' · Повторно завершена':''}</small><small>${escape(t.basis)}${t.event_at?' · '+Work.dateTime(t.event_at):''}${t.deadline?' · Срок '+Calendar.format(t.deadline):''}</small></article>`).join('')}${!modal.rows.length&&!modal.loading?'<p class="empty-state">Нет задач</p>':''}${modal.cursor?'<button class="button button-secondary" data-action="report-more">Показать ещё</button>':''}`;
      else body=`<p>${escape(reportPeriod(R.data))}<br>${escape(reportFilters(R.data))}<br>Снимок ${Work.dateTime(R.data.snapshot_at)} · Москва</p><p class="field-hint">PPTX: обзор, динамика, сотрудники, направления, выполненные и просроченные задачи. PNG: один обзор 1920×1080. Сводка: обычный текст.</p><div class="form-actions"><button class="button button-primary" data-action="report-format" data-format="pptx" ${modal.busy?'disabled':''}>Скачать PPTX</button><button class="button button-secondary" data-action="report-format" data-format="png" ${modal.busy?'disabled':''}>Скачать PNG</button><button class="button button-secondary" data-action="report-format" data-format="text" ${modal.busy?'disabled':''}>Скопировать сводку</button></div>${modal.text?`<label class="field">Выделите текст и скопируйте<textarea id="report-copy" readonly rows="12">${escape(modal.text)}</textarea></label>`:''}`;
      return `<dialog id="report-dialog" class="task-dialog" aria-labelledby="report-dialog-title"><div class="modal-heading"><h2 id="report-dialog-title">${modal.kind==='rows'?escape(MetricLabels[modal.metric]):'Скачать отчёт'}</h2><button class="icon-button" data-action="report-close" aria-label="Закрыть отчёт" ${modal.busy?'disabled':''}>×</button></div>${body}${modal.loading||modal.busy?`<p role="status">${escape(modal.progress||'Получаем данные…')}</p>`:''}${modal.error?`<p class="notice notice-error" role="alert">${escape(modal.error)}</p>${modal.expired?'<button class="button button-primary" data-action="report-refresh">Обновить отчёт</button>':`<button class="button-link" data-action="${modal.kind==='rows'?'report-more':'report-format'}" ${modal.format?`data-format="${modal.format}"`:''}>Повторить</button>`}`:''}${modal.success?`<p class="notice notice-success" role="status">${escape(modal.success)}</p>`:''}</dialog>`;
    },
    async rows(append=false){const modal=R.modal,generation=State.generation;if(!modal||modal.loading)return;modal.loading=true;modal.error='';plannerRender();try{const data=await Api.rpc('get_report_rows',{p_snapshot_id:modal.snapshotId,p_metric_key:modal.metric,p_cursor:append?modal.cursor:null,p_limit:50,p_scope:modal.scope});if(R.modal!==modal||generation!==State.generation)return;modal.rows=append?[...modal.rows,...data.rows]:data.rows;modal.cursor=data.next_cursor;modal.total=data.total;}catch(e){if(R.modal!==modal||generation!==State.generation)return;modal.error=normalizeError(e).message;modal.expired=e.code==='SNAPSHOT_EXPIRED';}finally{if(R.modal===modal&&generation===State.generation){modal.loading=false;plannerRender();}}},
    async click(button){const a=button.dataset.action;if(a==='report-open')return navigate(()=>Reports.open());if(a==='report-close'){R.modal=null;return plannerRender();}if(a==='report-refresh')return Reports.load();
      if(a==='report-drill'){R.modal={kind:'rows',metric:button.dataset.metric,scope:button.dataset.scope,snapshotId:R.data.snapshot_id,snapshotAt:R.data.snapshot_at,rows:[],cursor:null};return Reports.rows();}
      if(a==='report-more')return Reports.rows(!!R.modal.cursor);
      if(a==='report-task'){R.modal=null;return Planner.open(button.dataset.id);}
      if(a==='report-export'){R.modal={kind:'export'};return plannerRender();}
      if(a==='report-format')return Reports.export(button.dataset.format);
      if(R.loading)return;if(a==='report-type')R.type=button.dataset.type;else if(a==='report-today')R.date=P.data.today;else if(a==='report-prev'||a==='report-next'){const delta=a==='report-prev'?-1:1;R.date=R.type==='month'?Calendar.month(R.date,delta):Calendar.add(R.date,delta*(R.type==='week'?7:1));}else return;
      if(R.date<'2000-01-01'||R.date>'2100-12-31')R.date=P.data.today;return Reports.load();
    },
    async export(format){const modal=R.modal,generation=State.generation;if(!modal||modal.busy||!['pptx','png','text'].includes(format))return;modal.busy=true;modal.error='';modal.success='';modal.text='';modal.format=format;modal.progress='Подготавливаем снимок…';plannerRender();
      const valid=()=>R.modal===modal&&generation===State.generation&&!!State.context;
      try{const d=await Api.rpc('get_export_data',{p_snapshot_id:R.data.snapshot_id});if(!valid())return;
        if(format==='text'){const text=ReportExport.text(d);try{if(!navigator.clipboard?.writeText)throw new Error('NO_CLIPBOARD');await navigator.clipboard.writeText(text);if(valid())modal.success='Сводка скопирована.';}catch{if(valid()){modal.text=text;modal.success='Скопируйте выделенный текст вручную.';}}}
        else{let blob;if(format==='pptx'){modal.progress='Формируем редактируемые слайды…';plannerRender();blob=await ReportExport.pptx(d,message=>{if(valid()){modal.progress=message;const status=document.querySelector('#report-dialog [role="status"]');if(status)status.textContent=message;}});}else blob=await ReportExport.png(d);if(!valid())return;ReportExport.download(blob,ReportExport.filename(d,format));modal.success='Файл подготовлен для сохранения.';}
      }catch(e){if(!valid())return;modal.error=e instanceof AppError?e.message:'Не удалось сформировать файл. Повторите попытку.';modal.expired=e.code==='SNAPSHOT_EXPIRED';}
      finally{if(valid()){modal.busy=false;plannerRender();if(modal.text)requestAnimationFrame(()=>{const el=document.getElementById('report-copy');el?.focus();el?.select();});}}
    }
  };

  const ReportExport={
    colors:{background:'F5F6F2',card:'FFFFFF',text:'283027',muted:'67705F',accent:'7C865C',done:'3D744E',line:'DCE0D2',danger:'9B4B50'},
    percentColor(percent){if(percent===null)return '67705F';const r=Math.max(0,Math.min(100,Number(percent)||0))/100;return [173,79,112].map((v,i)=>Math.round(v+([61,116,78][i]-v)*r).toString(16).padStart(2,'0')).join('');},
    filename(d,format){return format==='png'?`ritm_${d.period.start}_${d.period.end}_summary.png`:`ritm_${d.period.start}_${d.period.end}_${d.filters.employee_id||'all'}_${d.filters.direction}.pptx`;},
    text(d){const m=d.metrics;return [`Ритм · ${reportPeriod(d)}`,reportFilters(d),`Снимок: ${Work.dateTime(d.snapshot_at)} (Москва)`,...ReportKpis.map(k=>`${MetricLabels[k]}: ${number(m[k])}`),`Сделано заранее: ${number(m.early_done_count||0)}`,`Выполнение плана: ${m.progress_percent===null?'Нет запланированных задач':number(m.progress_percent)+'%'}`,'По направлениям:',...d.by_direction.map(r=>`${r.label}: план ${r.metrics.planned_count}, выполнено из плана ${r.metrics.plan_done_count}, ${r.metrics.progress_percent===null?'нет плана':number(r.metrics.progress_percent)+'%'}, фактически ${r.metrics.actual_done_count}, просрочено ${r.metrics.overdue_count}`)].join('\n');},
    download(blob,filename){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}},
    measure(text,width,size=12){const ctx=ReportExport.measureContext||=(document.createElement('canvas').getContext('2d'));ctx.font=`${size}px Arial`;const limit=Math.max(1,(width*72-12)),lines=[];for(const paragraph of String(text??'').split('\n')){let line='';for(const word of paragraph.split(/(\s+)/)){if(ctx.measureText(line+word).width<=limit){line+=word;continue;}if(line.trim()){lines.push(line.trimEnd());line='';}for(const char of word){if(ctx.measureText(line+char).width>limit&&line){lines.push(line);line='';}line+=char;}}lines.push(line.trimEnd());}return lines.length?lines:[''];},
    tablePages(title,headers,widths,rows){const pages=[],measurements=new Map();const measured=(value,width)=>{const key=JSON.stringify([value,width]);if(!measurements.has(key))measurements.set(key,ReportExport.measure(value,width));return measurements.get(key);};let page;const fresh=()=>{page={kind:'table',title:title+(pages.length?' · Продолжение':''),headers,widths,rows:[],height:.38};pages.push(page);};fresh();
      for(const row of rows){const lines=row.cells.map((v,i)=>measured(v,widths[i]));let at=0;const lineCount=Math.max(...lines.map(a=>a.length));while(at<lineCount){const take=Math.min(22,lineCount-at),height=Math.max(.44,take*.2+.16);if(page.rows.length>=10||page.height+height>5.1)fresh();page.rows.push({id:row.id,cells:lines.map(a=>a.slice(at,at+take).join('\n')),height});page.height+=height;at+=take;}}
      return pages;
    },
    layout(d){const widths=[3.433,1.8,1.8,1.2,2,2.2],headers=['Участник / направление','В плане','Готово','%','Факт','Просрочено'];
      const metricRows=rows=>rows.map(r=>({id:r.id,cells:[r.label||`${Calendar.format(r.start)} — ${Calendar.format(r.end)}`,...ReportColumns.map(k=>number(r.metrics[k]))]}));
      const taskWidths=[4.9,2,1.2,1.7,2.633],taskHeaders=['Название','Исполнитель','Направл.','Дата / срок','Результат / статус'];
      const taskRows=(rows,done)=>rows.map(t=>({id:t.id,cells:[t.title,t.assignee_name,Directions[t.direction||'none'],done?Work.dateTime(t.completed_at):t.deadline?Calendar.format(t.deadline,{day:'numeric',month:'short',year:'numeric'}):'Без срока',done?`Выполнено${t.late?' · С опозданием':''}${t.repeated?' · Повторно завершена':''}${t.deleted?' · Удалена':''}`:Statuses[t.status]]}));
      const dynamic=d.period.type==='day'?['status_planned_count','in_progress_count','waiting_count','plan_done_count','deleted_unfinished_count'].map(k=>({id:k,cells:[MetricLabels[k],String(d.metrics[k])]})):metricRows(d.by_subperiod);
      return [{kind:'overview',title:'Итоги работы'},...ReportExport.tablePages('Динамика выполнения',d.period.type==='day'?['Статус плана','Задач']:['Период',...headers.slice(1)],d.period.type==='day'?[9.433,3]:widths,dynamic),...ReportExport.tablePages('Сотрудники',['Сотрудник',...headers.slice(1)],widths,metricRows(d.by_employee)),...ReportExport.tablePages('Направления',['Направление',...headers.slice(1)],widths,metricRows(d.by_direction)),...ReportExport.tablePages('Выполненные за период задачи',taskHeaders,taskWidths,taskRows(d.actual_done_tasks,true)),...ReportExport.tablePages('Незавершённые просроченные задачи плана',taskHeaders,taskWidths,taskRows(d.overdue_tasks,false))];
    },
    scheduler(){if(window.setImmediate)return;const jobs=new Map();let id=0,scheduled=false;const flush=()=>{const start=performance.now();try{while(jobs.size){const [handle,job]=jobs.entries().next().value;jobs.delete(handle);job.callback(...job.args);if(performance.now()-start>=8)break;}}finally{if(jobs.size)setTimeout(flush,0);else scheduled=false;}};window.setImmediate=(callback,...args)=>{if(typeof callback!=='function')throw new TypeError('Callback required');const handle=++id;jobs.set(handle,{callback,args});if(!scheduled){scheduled=true;queueMicrotask(flush);}return handle;};window.clearImmediate=handle=>jobs.delete(handle);},
    async library(){ReportExport.scheduler();if(window.PptxGenJS)return window.PptxGenJS;if(!ReportExport.libraryPromise)ReportExport.libraryPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/pptxgenjs@4.0.1/dist/pptxgen.bundle.js';script.referrerPolicy='no-referrer';const fail=()=>{clearTimeout(timer);script.remove();reject(new AppError('EXPORT_LIBRARY_UNAVAILABLE','Не удалось загрузить PPTX. Повторите попытку; PNG и сводка доступны.'));};const timer=setTimeout(fail,20000);script.onerror=fail;script.onload=()=>{clearTimeout(timer);window.PptxGenJS?resolve(window.PptxGenJS):fail();};document.head.append(script);}).catch(e=>{ReportExport.libraryPromise=null;throw e;});return ReportExport.libraryPromise;},
    async pptx(d,onProgress=()=>{}){const Constructor=await ReportExport.library();await document.fonts.load('12px Arial');const pptx=new Constructor();pptx.defineLayout({name:'RITM',width:13.333333,height:7.5});pptx.layout='RITM';pptx.author='Ритм';pptx.subject='Итоги работы';pptx.title=reportPeriod(d);pptx.lang='ru-RU';pptx.theme={headFontFace:'Arial',bodyFontFace:'Arial',lang:'ru-RU'};const c=ReportExport.colors,progress=ReportExport.percentColor(d.metrics.progress_percent),pages=ReportExport.layout(d);
      const text=(slide,value,x,y,w,h,size=14,extra={})=>slide.addText(String(value),{x,y,w,h,fontFace:'Arial',fontSize:size,color:c.text,margin:0,breakLine:false,paraSpaceAfterPt:0,...extra});
      for(let i=0;i<pages.length;i++){const page=pages[i],slide=pptx.addSlide();slide.background={color:c.background};text(slide,page.title,.45,.35,12.433,.5,26,{bold:true});const subtitle=ReportExport.measure(`${reportPeriod(d)} · ${reportFilters(d)}`,12.433,14).join('\n');text(slide,subtitle,.45,.9,12.433,.57,14);text(slide,`Ритм · ${d.period.start} — ${d.period.end} · снимок ${Work.dateTime(d.snapshot_at)} (Москва)`,.45,6.95,11,.25,10,{color:c.muted});text(slide,`${i+1} / ${pages.length}`,11.7,6.95,1.18,.25,10,{align:'right',color:c.muted});
        if(page.kind==='overview'){ReportKpis.forEach((k,j)=>{const x=.45+(j%3)*4.21,y=1.6+Math.floor(j/3)*1.6;slide.addShape(pptx.ShapeType.rect,{x,y,w:4.01,h:1.4,line:{color:c.line,width:.7},fill:{color:c.card}});text(slide,MetricLabels[k],x+.18,y+.16,3.65,.3,14,{color:c.muted});text(slide,number(d.metrics[k]),x+.18,y+.55,3.65,.55,30,{bold:true,color:k==='overdue_count'&&d.metrics[k]?c.danger:c.text});if(k==='plan_done_count')text(slide,`Сделано заранее: ${number(d.metrics.early_done_count||0)} · План по срокам результата`,.45,4.94,12.433,.22,10,{color:c.muted});text(slide,d.metrics.progress_percent===null?'Нет плана':number(d.metrics.progress_percent)+'%',x+2.1,y+.66,1.65,.35,20,{align:'right',color:progress});});
          text(slide,d.metrics.progress_percent===null?'Нет запланированных задач':`Выполнено ${number(d.metrics.progress_percent)}% плана`,.45,5.1,12.433,.35,16);slide.addShape(pptx.ShapeType.rect,{x:.45,y:5.56,w:12.433,h:.12,line:{color:c.line,transparency:100},fill:{color:c.line}});if(d.metrics.progress_percent)slide.addShape(pptx.ShapeType.rect,{x:.45,y:5.56,w:12.433*d.metrics.progress_percent/100,h:.12,line:{color:progress,transparency:100},fill:{color:progress}});
          const bins=ReportExport.bins(d);ReportExport.drawPptxBars(slide,pptx,bins,text);
        }else{let y=1.5;const addRow=(cells,height,header=false)=>{slide.addTable([cells],{x:.45,y,w:12.433,h:height,colW:page.widths,rowH:height,autoPage:false,fontFace:'Arial',fontSize:12,color:c.text,fill:header?'E8EBDD':c.card,bold:header,border:{type:'solid',pt:.5,color:c.line},margin:[5.76,6,5.76,6],valign:'middle',paraSpaceAfterPt:0,lineSpacingMultiple:1});y+=height;};addRow(page.headers,.38,true);if(!page.rows.length)text(slide,'Нет задач',.65,2.15,11,.5,16,{color:c.muted});for(const row of page.rows)addRow(row.cells,row.height);if(page.title.startsWith('Динамика'))text(slide,'Задачи уникальны внутри подпериода; сумму строк нельзя считать итогом периода.',.45,6.63,12.433,.28,10,{color:c.muted});}
        onProgress(`Формируем слайды: ${i+1} / ${pages.length}`);if(i%8===0)await new Promise(resolve=>setTimeout(resolve,0));
      }return ReportExport.package(await pptx.write({outputType:'blob',compression:false}));
    },
    async package(blob){const zip=await window.JSZip.loadAsync(blob),name='[Content_Types].xml',xml=new DOMParser().parseFromString(await zip.file(name).async('string'),'application/xml');
      // PptxGenJS 4.0.1 declares extra slide masters that it does not write.
      for(const node of [...xml.getElementsByTagName('Override')]){const part=node.getAttribute('PartName')?.replace(/^\//,'');if(/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(part)&&!zip.file(part))node.remove();}
      zip.file(name,new XMLSerializer().serializeToString(xml));return zip.generateAsync({type:'blob',compression:'DEFLATE'});
    },
    bins(d){return d.period.type==='day'?['status_planned_count','in_progress_count','waiting_count','plan_done_count','deleted_unfinished_count'].map(k=>({label:({status_planned_count:'В плане',in_progress_count:'В работе',waiting_count:'Ожидает',plan_done_count:'Готово',deleted_unfinished_count:'Удалены'})[k],planned:d.metrics[k],done:k==='plan_done_count'?d.metrics[k]:0})):d.by_subperiod.map(p=>({label:`${p.start.slice(8)}.${p.start.slice(5,7)}–${p.end.slice(8)}.${p.end.slice(5,7)}`,planned:p.metrics.planned_count,done:p.metrics.plan_done_count}));},
    drawPptxBars(slide,pptx,bins,text){const max=Math.max(1,...bins.map(b=>b.planned)),w=12.433/Math.max(1,bins.length);bins.forEach((b,i)=>{const x=.45+i*w;text(slide,b.label,x,5.86,w-.12,.3,14,{color:ReportExport.colors.muted});const h=.3*b.planned/max;if(h)slide.addShape(pptx.ShapeType.rect,{x,y:6.53-h,w:w-.2,h,line:{transparency:100},fill:{color:ReportExport.colors.accent}});const dh=.3*b.done/max;if(dh)slide.addShape(pptx.ShapeType.rect,{x,y:6.53-dh,w:(w-.2)*.5,h:dh,line:{transparency:100},fill:{color:ReportExport.colors.done}});text(slide,`${b.planned} / ${b.done}`,x,6.55,w-.12,.3,14);});},
    async png(d){await document.fonts.load('12px Arial');const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const ctx=canvas.getContext('2d',{alpha:false}),c=ReportExport.colors,progress=ReportExport.percentColor(d.metrics.progress_percent);ctx.scale(144,144);ctx.fillStyle='#'+c.background;ctx.fillRect(0,0,13.333333,7.5);
      const text=(value,x,y,size=14,color=c.text)=>{ctx.font=`${size/72}px Arial`;ctx.fillStyle='#'+color;ctx.textBaseline='top';ctx.fillText(String(value),x,y);};text('Итоги работы',.45,.35,26);const subtitle=ReportExport.measure(`${reportPeriod(d)} · ${reportFilters(d)}`,12.433,14);subtitle.forEach((line,i)=>text(line,.45,.9+i*.22,14));
      ReportKpis.forEach((k,j)=>{const x=.45+(j%3)*4.21,y=1.6+Math.floor(j/3)*1.6;ctx.fillStyle='#'+c.card;ctx.fillRect(x,y,4.01,1.4);text(MetricLabels[k],x+.18,y+.16,14,c.muted);text(number(d.metrics[k]),x+.18,y+.55,30,k==='overdue_count'&&d.metrics[k]?c.danger:c.text);if(k==='plan_done_count')text(d.metrics.progress_percent===null?'Нет плана':number(d.metrics.progress_percent)+'%',x+2.1,y+.66,20,progress);});
      text(`Сделано заранее: ${number(d.metrics.early_done_count||0)} · План по срокам результата`,.45,4.94,10,c.muted);text(d.metrics.progress_percent===null?'Нет запланированных задач':`Выполнено ${number(d.metrics.progress_percent)}% плана`,.45,5.1,16);ctx.fillStyle='#'+c.line;ctx.fillRect(.45,5.56,12.433,.12);ctx.fillStyle='#'+progress;ctx.fillRect(.45,5.56,12.433*(d.metrics.progress_percent||0)/100,.12);
      const bins=ReportExport.bins(d),max=Math.max(1,...bins.map(b=>b.planned)),w=12.433/Math.max(1,bins.length);bins.forEach((b,i)=>{const x=.45+i*w;text(b.label,x,5.86,14,c.muted);ctx.fillStyle='#'+c.accent;ctx.fillRect(x,6.53-.3*b.planned/max,w-.2,.3*b.planned/max);ctx.fillStyle='#'+c.done;ctx.fillRect(x,6.53-.3*b.done/max,(w-.2)*.5,.3*b.done/max);text(`${b.planned} / ${b.done}`,x,6.55,14);});text(`Ритм · ${d.period.start} — ${d.period.end} · снимок ${Work.dateTime(d.snapshot_at)} (Москва)`,.45,6.95,10,c.muted);text('1 / 1',12.2,6.95,10,c.muted);return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new AppError('EXPORT_FAILED','Не удалось создать PNG. Повторите попытку.')),'image/png'));
    }
  };

  function clearSensitiveDrafts() { for(const key of ['password','new_password','confirm_password','profile_password','profile_confirm']) State.drafts[key]=''; }
  function dirty() { return Planner.hasDirty() || Team.dirty() || State.view==='profile' && (State.drafts.display_name!==null && State.drafts.display_name!==State.context?.member.display_name || !!State.drafts.profile_password || !!State.drafts.profile_confirm); }
  function navigate(action) {
    if(State.busy) return;
    if(dirty()) { State.navigation=action; const dialog=document.getElementById('discard-dialog'); dialog.showModal(); dialog.addEventListener('cancel',()=>{State.navigation=null;},{once:true}); }
    else action();
  }
  function home() { State.drafts.display_name=null; clearSensitiveDrafts(); State.message=null; State.errors={}; State.profileConflict=null; State.view='home'; Views.render();if(R.filtersChanged){R.filtersChanged=false;Planner.load();} }
  async function loadAccess({preserve=false}={}) {
    const generation=State.generation;
    try {
      const data=await Api.access(); if(generation!==State.generation) return;
      State.context=data;
      if(!preserve) {State.view='home'; State.drafts.display_name=null; State.errors={}; State.message=null; Views.render();await Sync.start();}
      else Views.network();
    } catch(error) {
      if(generation!==State.generation) return;
      error=normalizeError(error);
      if(error.code==='NETWORK_ERROR') {Views.network(); if(!State.context) {setMessage(error.message); State.view='login'; Views.render();} return;}
      State.generation++;Sync.stop();Planner.clear();Team.clear();Comments.clear();Notifications.clear();Work.pending={};State.navigation=null;State.context=null; State.drafts.display_name=null; clearSensitiveDrafts(); clearInterval(State.watch); State.watch=null;
      if(error.code==='INVITATION_PENDING') {State.flow='invite'; flowStorage.set('invite');}
      else if(error.code==='UNAUTHENTICATED') {await Api.logout(); setMessage(error.message);}
      else {State.view='blocked'; setMessage(error.message);}
      Views.render();
    }
  }
  function subscribe() {
    State.authSubscription?.unsubscribe();
    State.authSubscription=State.client.auth.onAuthStateChange((event,session)=>{
      // SDK callbacks are synchronous; never await another Auth operation inside this callback.
      setTimeout(()=>{
        if(event==='PASSWORD_RECOVERY') {State.flow='recovery'; flowStorage.set('recovery'); State.context=null; State.message=null; Views.render();}
        else if(event==='SIGNED_OUT') {State.generation++;Sync.stop();Team.clear();Comments.clear();Notifications.clear();Work.pending={};Planner.clear(); State.context=null; clearInterval(State.watch); State.watch=null; clearSensitiveDrafts(); State.flow=null; flowStorage.set(null); State.view='login'; State.errors={}; State.busy=false; Views.render();}
        else if(event==='TOKEN_REFRESHED' && session && !State.flow && !State.busy) State.context?Sync.refresh():loadAccess();
      },0);
    }).data.subscription;
  }
  const Bootstrap = {
    async start() {
      State.errors={}; State.message=null;
      if(!configValid()) {State.view='login'; Views.render(); return;}
      const url=new URL(location.href),fragment=new URLSearchParams(url.hash.replace(/^#/,''));
      const type=url.searchParams.get('type') || fragment.get('type');
      const token=url.searchParams.get('token_hash');
      const accessToken=fragment.get('access_token'),refreshToken=fragment.get('refresh_token');
      const callbackError=url.searchParams.has('error') || fragment.has('error') || url.searchParams.has('error_code') || fragment.has('error_code');
      State.flow=['invite','recovery'].includes(type)?type:flowStorage.get();
      if(State.flow) flowStorage.set(State.flow);
      // Remove secrets before loading any remote script or processing the link.
      if(token || accessToken || callbackError || url.searchParams.has('type')) history.replaceState(null,'',url.pathname);
      State.busy=true; Views.render();
      try {
        await Api.initialize(); subscribe();
        if(callbackError) throw new AppError('INVALID_LINK','Ссылка недействительна или срок её действия истёк. Запросите новую ссылку.');
        if(token) {
          if(!['invite','recovery'].includes(type)) throw new AppError('INVALID_LINK','Ссылка недействительна.');
          const {error}=await State.client.auth.verifyOtp({token_hash:token,type}); if(error) throw normalizeError(error,'link');
        } else if(accessToken && refreshToken) {
          const {error}=await State.client.auth.setSession({access_token:accessToken,refresh_token:refreshToken}); if(error) throw normalizeError(error,'link');
        }
        const {data,error}=await State.client.auth.getSession(); if(error) throw normalizeError(error,'link');
        if(State.flow && !data.session) throw new AppError('INVALID_LINK','Ссылка недействительна или срок её действия истёк. Запросите новую ссылку.');
        if(data.session && !State.flow) await loadAccess();
      } catch(error) {
        const normalized=normalizeError(error);
        State.flow=null; flowStorage.set(null); State.context=null; State.view='login'; setMessage(normalized.message);
      } finally {State.busy=false; Views.render();}
    }
  };
  function validateEmail() {
    State.drafts.email=State.drafts.email.trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(State.drafts.email)) State.errors.email='Введите корректную электронную почту.';
  }
  function validatePassword(first,second) {
    if(State.drafts[first].length<12) State.errors[first]='Не менее 12 символов. Пробелы учитываются.';
    if(State.drafts[first]!==State.drafts[second]) State.errors[second]='Пароли не совпадают.';
  }
  async function submitForm(name) {
    if(State.busy || !configValid()) return;
    if(name==='recovery'&&!Config.emailDeliveryEnabled){State.view='login';setMessage('Для восстановления доступа обратитесь к руководителю.');Views.render();return;}
    const generation=State.generation;
    const ensureCurrent=()=>{if(generation!==State.generation) throw new AppError('UNAUTHENTICATED','Сессия завершена. Войдите снова.');};
    State.errors={}; State.message=null;
    if(['login','recovery'].includes(name)) validateEmail();
    if(name==='login' && !State.drafts.password) State.errors.password='Введите пароль.';
    if(name==='set-password') validatePassword('new_password','confirm_password');
    if(name==='profile-password') validatePassword('profile_password','profile_confirm');
    if(name==='profile' && (!State.drafts.display_name?.trim() || State.drafts.display_name.trim().length>80)) State.errors.display_name='Введите от 1 до 80 символов.';
    if(Object.keys(State.errors).length) {Views.render(); return;}
    State.busy=true; Views.render();
    try {
      if(!navigator.onLine) throw normalizeError(new TypeError('network offline'));
      await Api.initialize(); if(!State.authSubscription) subscribe();
      if(name==='login') {
        const {error}=await State.client.auth.signInWithPassword({email:State.drafts.email,password:State.drafts.password});
        if(error) throw normalizeError(error,'login'); ensureCurrent(); State.drafts.password=''; await loadAccess();
      } else if(name==='recovery') {
        const {error}=await State.client.auth.resetPasswordForEmail(State.drafts.email,{redirectTo:redirectUrl()});
        if(error && !['user_not_found','email_not_found'].includes(error.code)) throw normalizeError(error);
        ensureCurrent();
        setMessage('Если эта почта подключена к команде, на неё придёт ссылка для восстановления доступа.','success');
      } else if(name==='set-password') {
        const {error}=await State.client.auth.updateUser({password:State.drafts.new_password}); if(error) throw normalizeError(error); ensureCurrent();
        await Api.rpc('activate_invited_member');
        clearSensitiveDrafts(); State.flow=null; flowStorage.set(null); await loadAccess();
      } else if(name==='profile') {
        const member=State.context.member, displayName=State.drafts.display_name.trim();
        const version=State.profileVersion ?? member.version;
        const fingerprint=JSON.stringify([displayName,version]);
        if(State.pendingProfile?.fingerprint!==fingerprint) State.pendingProfile={id:crypto.randomUUID(),fingerprint};
        const result=await Api.rpc('update_profile',{p_team_id:State.context.team.id,p_display_name:displayName,p_expected_version:version,p_operation_id:State.pendingProfile.id}); ensureCurrent();
        State.context=result.context; State.drafts.display_name=result.context.member.display_name; State.profileVersion=result.context.member.version;
        State.pendingProfile=null; State.profileConflict=null; setMessage('Имя сохранено.','success');
      } else if(name==='profile-password') {
        const {error}=await State.client.auth.updateUser({password:State.drafts.profile_password}); if(error) throw normalizeError(error); ensureCurrent();
        State.drafts.profile_password=''; State.drafts.profile_confirm=''; setMessage('Новый пароль сохранён.','success');
      }
      State.connectionLost=false;
    } catch(error) {
      error=normalizeError(error);
      if(error.code==='VERSION_CONFLICT') State.profileConflict=error.latest_entity;
      if(error.field_errors) State.errors=error.field_errors;
      if(['ACCESS_DENIED','UNAUTHENTICATED'].includes(error.code)) {State.context=null; State.view=error.code==='ACCESS_DENIED'?'blocked':'login'; clearSensitiveDrafts();}
      setMessage(error.message);
    } finally {State.busy=false; Views.render();}
  }
  root.addEventListener('input',event=>{
    if(event.target.dataset.teamField){Team.form[event.target.dataset.teamField]=event.target.value;return;}
    if(event.target.matches('[data-comment-draft]')){Comments.draft=event.target.value;return;}
    if(event.target.matches('[data-task-field]')){P.form[event.target.dataset.taskField]=event.target.value;return;}
    if(event.target.name==='quick-title'){P.quick=event.target.value;return;}
    if(event.target.matches('[data-query]')){P.filters.query=event.target.value;clearTimeout(P.searchTimer);P.searchTimer=setTimeout(()=>Planner.load(),250);return;}
    const name=event.target.name;
    if(Object.hasOwn(State.drafts,name)) State.drafts[name]=event.target.value;
  });
  document.addEventListener('pointerdown',event=>RenderInteraction.hold(event),true);
  document.addEventListener('pointerup',event=>RenderInteraction.release(event),true);
  document.addEventListener('pointercancel',event=>RenderInteraction.release(event),true);
  root.addEventListener('focusout',event=>{captureNativeDraft(event.target);if(event.target.id==='planner-selected-date'&&RenderInteraction.pending!==null)RenderInteraction.flushSoon();});
  root.addEventListener('dragstart',()=>{RenderInteraction.dragging=true;},true);
  document.addEventListener('dragend',()=>{RenderInteraction.dragging=false;RenderInteraction.pointers.clear();RenderInteraction.flushSoon();},true);
  document.addEventListener('drop',()=>{RenderInteraction.dragging=false;RenderInteraction.pointers.clear();RenderInteraction.flushSoon();},true);
  window.addEventListener('blur',()=>{RenderInteraction.dragging=false;RenderInteraction.pointers.clear();RenderInteraction.flushSoon();});
  root.addEventListener('submit',event=>{const form=event.target.closest('[data-form]'); if(form) {captureNativeDraft();event.preventDefault();const name=form.dataset.form;if(name==='work-comment')return Comments.save();if(name==='work-invite')return Team.invite();if(name==='work-disable')return Team.disable();if(name==='work-series')return Series.save();name.startsWith('planner-')?Planner.submit(name):submitForm(name);}});
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-action]'); if(!button || button.disabled) return;
    const action=button.dataset.action;
    if(action==='daily-dismiss')return Daily.dismiss();
    if(action==='daily-refresh')return Daily.load(true);
    if(action.startsWith('report-'))return Reports.click(button);
    if(action.startsWith('work-'))return Work.click(button);
    if(action.startsWith('planner-'))return Planner.click(button);
    if(action==='toggle-password') {const input=document.getElementById(button.dataset.target); const visible=input.type==='password'; input.type=visible?'text':'password'; button.setAttribute('aria-pressed',String(visible)); button.setAttribute('aria-label',visible?'Скрыть пароль':'Показать пароль'); return;}
    if(action==='profile-view') navigate(()=>{State.view='profile'; State.drafts.display_name=State.context.member.display_name; State.profileVersion=State.context.member.version; State.message=null; State.errors={}; Views.render();});
    else if(action==='team-view')navigate(()=>Team.open());
    else if(action==='home-view') navigate(home);
    else if(action==='logout') navigate(()=>Api.logout());
    else if(action==='recovery-view' || action==='login-view') {State.view=action==='recovery-view'&&Config.emailDeliveryEnabled?'recovery':'login'; State.errors={}; State.message=null; State.drafts.password=''; if(action==='recovery-view'&&!Config.emailDeliveryEnabled)setMessage('Для восстановления доступа обратитесь к руководителю.'); Views.render();}
    else if(action==='retry') Bootstrap.start();
    else if(action==='stay') {document.getElementById('discard-dialog').close(); State.navigation=null;}
    else if(action==='confirm-discard') {const next=State.navigation; State.navigation=null; clearSensitiveDrafts(); State.drafts.display_name=null;Team.form={name:'',email:''};Comments.clear();Work.pending={};P.pending=null; document.getElementById('discard-dialog').close();P.modal=null;P.form=null;next?.();}
    else if(action==='reload-profile' && State.profileConflict) {Object.assign(State.context.member,State.profileConflict); State.profileVersion=State.profileConflict.version; State.drafts.display_name=State.profileConflict.display_name; State.profileConflict=null; State.pendingProfile=null; State.message=null; Views.render();}
    else if(action==='retry-profile' && State.profileConflict) {Object.assign(State.context.member,State.profileConflict); State.profileVersion=State.profileConflict.version; State.profileConflict=null; State.pendingProfile=null; submitForm('profile');}
  });
  root.addEventListener('change',event=>{
    const el=event.target;if(el.id==='planner-selected-date'){Planner.date(el.value,el.id);return;}if(el.hasAttribute('data-report-date')){if(el.value){R.date=R.type==='month'?el.value+'-01':el.value;Reports.load();}return;}if(el.dataset.reportFilter){P.filters[el.dataset.reportFilter]=el.dataset.reportFilter==='employee_id'?el.value||null:el.value;Planner.save();R.filtersChanged=true;Reports.load();return;}if(el.dataset.filter){P.filters[el.dataset.filter]=el.dataset.filter==='employee_id'?el.value||null:el.value;Planner.save();Planner.load();}
    if(el.dataset.filterMulti){const key=el.dataset.filterMulti;P.filters[key]=el.checked?[...new Set([...P.filters[key],el.value])]:P.filters[key].filter(v=>v!==el.value);Planner.save();Planner.load();}
    if(el.dataset.taskField&&el.getAttribute('type')==='date'){if(P.form)P.form[el.dataset.taskField]=el.value;if(!refreshTaskDateHints())plannerRender();}
    if(el.dataset.taskField&&['frequency','month_day'].includes(el.dataset.taskField))plannerRender();
    if(el.dataset.weekday&&P.form){const day=Number(el.dataset.weekday);P.form.weekdays=el.checked?[...new Set([...P.form.weekdays,day])]:P.form.weekdays.filter(d=>d!==day);}
    if(el.dataset.taskStatus&&P.modal?.task)Planner.mutate('status',P.modal.task,{status:el.value});
  });
  root.addEventListener('toggle',event=>{const key=event.target.dataset.disclosure;if(key)P.detailsOpen[key]=event.target.open;},true);
  root.addEventListener('cancel',event=>{if(event.target.id==='daily-support-dialog'){event.preventDefault();Daily.dismiss();return;}if(event.target.id==='report-dialog'){event.preventDefault();if(!R.modal?.busy){R.modal=null;plannerRender();}}if(event.target.id==='task-dialog'){event.preventDefault();Planner.close();}if(event.target.id==='discard-dialog')State.navigation=null;},true);
  root.addEventListener('dragstart',event=>{const card=event.target.closest('.task-card[draggable="true"]');if(card&&!State.busy){event.dataTransfer.setData('text/plain',card.dataset.taskId);event.dataTransfer.effectAllowed='move';}});
  root.addEventListener('dragover',event=>{const target=event.target.closest('[data-drop-date]');if(target&&target.dataset.dropDate>=P.data?.today){event.preventDefault();event.dataTransfer.dropEffect='move';}});
  root.addEventListener('drop',async event=>{const target=event.target.closest('[data-drop-date]');if(!target||State.busy)return;event.preventDefault();const id=event.dataTransfer.getData('text/plain');if(!id||target.dataset.dropDate<P.data.today)return;
    try{const {task}=await Api.rpc('get_task_detail',{p_team_id:State.context.team.id,p_task_id:id});await Planner.mutate('move',task,{plan_start:target.dataset.dropDate});}catch(e){setMessage(normalizeError(e).message);plannerRender();}});
  window.addEventListener('offline',()=>{State.connectionLost=true; Views.network();});
  window.addEventListener('online',()=>{State.connectionLost=false; Views.network(); if(State.context) Sync.refresh();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden && State.context)Sync.refresh();});
  window.addEventListener('beforeunload',event=>{if(dirty()) {event.preventDefault(); event.returnValue='';}});
  Bootstrap.start();
})();
