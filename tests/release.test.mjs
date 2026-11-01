import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {buildRelease,publicConfig} from '../scripts/build-release.mjs';
const env={RITM_SUPABASE_URL:'https://release-fixture.supabase.co',RITM_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_automated_release_test_only',RITM_APP_BASE_URL:'https://release-fixture.github.io/ritm/'};
await mkdir('.cache',{recursive:true});
test('release builds exactly three interface files, preserves source and embeds only public configuration',async()=>{
 const original=await readFile('app.js','utf8'),directory=await mkdtemp(resolve('.cache','release-test-'));const result=await buildRelease({env,directory});
 assert.deepEqual((await readdir(directory)).sort(),['app.js','index.html','styles.css']);assert.equal(Object.keys(result.hashes).length,3);
 const js=await readFile(resolve(directory,'app.js'),'utf8');assert.ok(js.includes(env.RITM_APP_BASE_URL));assert.ok(js.includes(env.RITM_SUPABASE_PUBLISHABLE_KEY));assert.equal(await readFile('app.js','utf8'),original);
 const html=await readFile(resolve(directory,'index.html'),'utf8');assert.match(html,/href="\.\/styles.css"/);assert.match(html,/src="\.\/app.js"/);
});
test('release rejects missing parameters, service keys, insecure URLs and an unsafe output folder',async()=>{
 assert.throws(()=>publicConfig({}),/Нужны публичные/);
 for(const patch of [{RITM_SUPABASE_PUBLISHABLE_KEY:'sb_secret_do_not_publish'},{RITM_APP_BASE_URL:'http://example.test/ritm/'},{RITM_APP_BASE_URL:'https://user:password@example.test/'},{RITM_APP_BASE_URL:'https://example.test/ritm'},{RITM_SUPABASE_URL:'https://example.test/project'},{RITM_APP_BASE_URL:'https://example.test/?token=secret'}])assert.throws(()=>publicConfig({...env,...patch}));
 const serviceJwt=['header',Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url'),'signature'].join('.');assert.throws(()=>publicConfig({...env,RITM_SUPABASE_PUBLISHABLE_KEY:serviceJwt}));
 const directory=await mkdtemp(resolve('.cache','release-guard-'));await writeFile(resolve(directory,'.env'),'DO_NOT_PUBLISH');await assert.rejects(buildRelease({env,directory}),/посторонние файлы/);assert.equal(await readFile(resolve(directory,'.env'),'utf8'),'DO_NOT_PUBLISH');
});
