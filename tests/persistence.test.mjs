import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mkdir,rm} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createDatabase,seedDatabase,rpc,ids} from './helpers/database.mjs';
test('actual task and history persist after closing/reopening the local PostgreSQL database',async()=>{
 const cache=resolve(fileURLToPath(new URL('../.cache/',import.meta.url))),dir=resolve(cache,'persistence-'+randomUUID());
 const child=relative(cache,dir);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));
 let db,reopened;
 try{
  await mkdir(cache,{recursive:true});db=await createDatabase(dir);const team=await seedDatabase(db);
  const created=await rpc(db,ids.employee1,'mutate_task',[team,'create',null,{title:'Сохранено на диске'},null,randomUUID()]);assert.equal(created.ok,true);
  const id=created.data.entity.id;await db.close();reopened=new PGlite(dir);
  const detail=await rpc(reopened,ids.employee1,'get_task_detail',[team,id]);assert.equal(detail.data.task.title,'Сохранено на диске');
  const history=await rpc(reopened,ids.employee1,'get_task_history',[team,id,null]);assert.equal(history.data.events.length,1);
 }finally{
  if(db&&!db.closed)await db.close();if(reopened&&!reopened.closed)await reopened.close();
  // Only this verified, randomly named child of the workspace cache is removed.
  const current=relative(cache,resolve(dir));if(!current||current.startsWith('..')||isAbsolute(current))throw new Error('Unsafe test cleanup');
  await rm(dir,{recursive:true,force:true});
 }
});
