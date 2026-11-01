import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const publicFiles=Object.freeze(['index.html','styles.css','app.js']);
export function publicConfig(env){
 const supabaseUrl=env.RITM_SUPABASE_URL?.trim(),publishableKey=env.RITM_SUPABASE_PUBLISHABLE_KEY?.trim(),appBaseUrl=env.RITM_APP_BASE_URL?.trim();
 if(!supabaseUrl||!publishableKey||!appBaseUrl)throw new Error('Нужны публичные RITM_SUPABASE_URL, RITM_SUPABASE_PUBLISHABLE_KEY и RITM_APP_BASE_URL. Служебные ключи не используются.');
 for(const [name,value] of [['Supabase URL',supabaseUrl],['URL страницы',appBaseUrl]]){let url;try{url=new URL(value);}catch{throw new Error(`Некорректный ${name}.`);}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||['localhost','127.0.0.1'].includes(url.hostname))throw new Error(`${name}: нужен HTTPS-адрес без учётных данных и параметров.`);}
 if(new URL(supabaseUrl).pathname!=='/')throw new Error('Supabase URL должен указывать на корень проекта.');
 if(!appBaseUrl.endsWith('/'))throw new Error('URL страницы должен заканчиваться / и включать подпапку репозитория.');
 let anonymous=false;
 if(/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(publishableKey))anonymous=true;
 else if(/^[\w-]+\.[\w-]+\.[\w-]+$/.test(publishableKey)){try{anonymous=JSON.parse(Buffer.from(publishableKey.split('.')[1],'base64url')).role==='anon';}catch{}}
 if(!anonymous)throw new Error('Допустим только публичный publishable / anon ключ. Административный ключ запрещён.');
 const emailMode=env.RITM_EMAIL_DELIVERY_ENABLED?.trim()||'false';
 if(!['true','false'].includes(emailMode))throw new Error('RITM_EMAIL_DELIVERY_ENABLED должен быть true или false.');
 return {supabaseUrl:supabaseUrl.replace(/\/$/,''),publishableKey,appBaseUrl,emailDeliveryEnabled:emailMode==='true'};
}
export async function buildRelease({env=process.env,directory=resolve(root,'dist')}={}){
 const config=publicConfig(env);await mkdir(directory,{recursive:true});
 // Never recursively copy the checkout: SQL, fixtures, environment and Git stay outside Pages.
 const existing=await readdir(directory);if(existing.some(name=>!publicFiles.includes(name)))throw new Error('В папке сборки есть посторонние файлы. Выберите отдельную пустую папку; публикация остановлена.');
 const hashes={};
 for(const name of publicFiles){let content=await readFile(resolve(root,name),'utf8');
  if(name==='app.js')for(const [key,value] of Object.entries(config)){const anchor=key==='emailDeliveryEnabled'?'emailDeliveryEnabled: false':`${key}: ''`;if(content.split(anchor).length!==2)throw new Error(`Не найден единственный параметр ${key}.`);content=content.replace(anchor,`${key}: ${JSON.stringify(value)}`);}
  if(/sb_secret_|BEGIN (?:RSA |EC )?PRIVATE KEY|SUPABASE_SERVICE_ROLE_KEY\s*[:=]/.test(content))throw new Error('В публичных файлах обнаружен служебный секрет.');
  await writeFile(resolve(directory,name),content);hashes[name]=createHash('sha256').update(content).digest('hex');
 }
 return {files:publicFiles,hashes,appBaseUrl:config.appBaseUrl};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await buildRelease({directory:resolve(root,process.argv.includes('--pages')?'docs':'dist')});console.log(JSON.stringify(result,null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
