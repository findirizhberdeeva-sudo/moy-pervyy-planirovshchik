export async function installClock(db) {
 await db.exec(`create or replace function private.task_now() returns timestamptz language sql stable set search_path='' as $$select coalesce(nullif(current_setting('ritm.test_now',true),'')::timestamptz,now())$$;`);
}
export async function clock(db,value='2026-11-02T09:00:00+03:00') {await db.query(`select set_config('ritm.test_now',$1,false)`,[value]);}
export async function serviceCommand(db,args) {
 return db.transaction(async tx=>{
  await tx.exec('set local role service_role');
  return (await tx.query('select public.team_admin_command($1,$2,$3,$4,$5,$6,$7,$8) as r',args)).rows[0].r;
 });
}
