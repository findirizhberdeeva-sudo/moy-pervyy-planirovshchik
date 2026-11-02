import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
export const ids = Object.freeze({manager:'10000000-0000-4000-8000-000000000001',employee1:'10000000-0000-4000-8000-000000000002',employee2:'10000000-0000-4000-8000-000000000003',outsider:'10000000-0000-4000-8000-000000000004'});
export async function createDatabase(dataDir,{beforeMigration}={}) {
  const db = new PGlite(dataDir);
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,encrypted_password text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;`);
  for (const file of (await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')&&(!beforeMigration||f<beforeMigration)).sort()) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),'utf8'));
  }
  return db;
}
export async function seedDatabase(db) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); truncate public.teams,auth.users,private.rate_limit_counters restart identity cascade;`);
  for (const [key,id] of Object.entries(ids)) await db.query(`insert into auth.users values($1,$2,now(),'test-hash-not-a-real-password')`,[id,`${key}@example.test`]);
  const {rows} = await db.query(`select private.bootstrap_team('manager@example.test','Руководитель','Наша команда') as id`);
  const team=rows[0].id;
  for (const key of ['employee1','employee2']) await db.query(`insert into public.team_members(team_id,user_id,display_name,role,state,joined_at) values($1,$2,$3,'employee','active',now())`,[team,ids[key],key==='employee1'?'Сотрудник 1':'Сотрудник 2']);
  return team;
}
export async function asUser(db,user,sql,params=[]) {
  return db.transaction(async tx=>{
    await tx.exec(`set local role ${user?'authenticated':'anon'}`);
    await tx.query(`select set_config('request.jwt.claim.sub',$1,true)`,[user||'']);
    return tx.query(sql,params);
  });
}
export async function rpc(db,user,name,args=[]) {
  return (await asUser(db,user,`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) as result`,args)).rows[0].result;
}
