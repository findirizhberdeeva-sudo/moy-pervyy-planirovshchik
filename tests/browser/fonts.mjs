// Exact official Rubik WOFF2 files used by styles.css, delivered locally in tests.
// Production keeps its pinned Google Fonts URLs and font-display:swap fallback.
import {readFile} from 'node:fs/promises';
const fonts=[
 ['iJWKBXyIfDnIV7nFrXyi0A.woff2','rubik-cyrillic.woff2'],
 ['iJWKBXyIfDnIV7nBrXw.woff2','rubik-latin.woff2']
];
const assets=await Promise.all(fonts.map(async([name,file])=>[name,await readFile(new URL('../assets/'+file,import.meta.url))]));
export async function installFonts(target){
 for(const [name,body] of assets)await target.route('https://fonts.gstatic.com/s/rubik/v31/'+name,route=>route.fulfill({status:200,contentType:'font/woff2',body}));
}
