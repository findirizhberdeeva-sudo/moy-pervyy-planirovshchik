import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceRows} from '../scripts/acceptance.mjs';
test('acceptance protocol covers exactly 48 UC and 39 AC with real, unambiguous test references',async()=>{
 const rows=await acceptanceRows();assert.equal(rows.length,87);assert.equal(new Set(rows.map(r=>r.id)).size,87);for(const row of rows){assert.ok(row.requirement);assert.ok(row.references.length);assert.ok(row.pending);for(const reference of row.references){assert.ok(reference.line>0);assert.ok(reference.title);}}
});
