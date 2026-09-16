const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function harness() {
    const tables = {};
    function table() {
        const rows = [];
        return {rows, async get(key) { return rows.find(r => r.key === key); },
            async put(row) { const i=rows.findIndex(r=>r.key===row.key); if(i<0) rows.push(row); else rows[i]=row; },
            async add(row) { const id=rows.length+1; rows.push({...row,id}); return id; },
            async update(id, values) { Object.assign(rows.find(r=>r.id===id)||{}, values); },
            async clear() { rows.length=0; },
            toCollection() { return {async modify(fn) { rows.forEach(fn); }}; },
            where(query) { let predicate=r=>Object.entries(query).every(([k,v])=>r[k]===v); return {
                filter(fn) { const prev=predicate; predicate=r=>prev(r)&&fn(r); return this; },
                async first() { return rows.find(predicate); }
            }; }
        };
    }
    class Dexie { constructor() { for(const name of ['items','nav','settings']) this[name]=tables[name]=table(); }
        version(){return {stores(){}};} async transaction(...args){ return args.at(-1)(); } }
    let filter;
    const downloads=[];
    const context={Dexie, console, navigator:{userAgent:'test'}, TextDecoder,
        tidalStorage:{async save(row){downloads.push(row);return {download_status:'complete',local_files:[]};}},
        browser:{tabs:{get:async()=>({url:'https://www.instagram.com/'}),onRemoved:{addListener(){}}},
            webRequest:{onBeforeRequest:{addListener(){}},filterResponseData(){return filter={write(){},disconnect(){this.disconnected=true;}};}},
            webNavigation:{onCommitted:{addListener(){}}}}};
    context.window=context; vm.createContext(context);
    vm.runInContext(fs.readFileSync('js/zs-background.js','utf8'),context);
    return {zs:context.zeeschuimer,tables,downloads,context,getFilter:()=>filter};
}
test('navigation index increments and ignores subframes',async()=>{
    const {zs,tables}=harness(); await zs.ready;
    await zs.nav_handler({tabId:2,frameId:0}); await zs.nav_handler({tabId:2,frameId:0});
    await zs.nav_handler({tabId:2,frameId:3}); assert.equal(tables.nav.rows[0].index,1);
});
test('concurrent responses deduplicate IDs per platform without dropping later modules',async()=>{
    const {zs,tables,downloads}=harness();await zs.ready;
    zs.register_module('Stories','instagram-stories',()=>[{pk:'123'}]);
    zs.register_module('Posts','instagram.com',()=>[{id:'123'}]);
    const parse=()=>zs.parse_request('{}','https://www.instagram.com/','https://www.instagram.com/graphql/query',2);
    await Promise.all([zs.enqueue(parse),zs.enqueue(parse)]);
    assert.equal(tables.items.rows.length,2);assert.equal(downloads.length,2);
    assert.equal(tables.items.rows[0].item_id,'123');
});
test('response is forwarded and disconnected before asynchronous parsing',async()=>{
    const {zs,getFilter}=harness();await zs.ready;
    const seen=[];zs.parse_request=async response=>{assert.equal(getFilter().disconnected,true);seen.push(response);};
    zs.listener({requestId:'1',tabId:1,url:'https://www.tiktok.com/'});
    const filter=getFilter();const data=new TextEncoder().encode('{"text":"✓"}');
    filter.ondata({data:data.slice(0,11)});filter.ondata({data:data.slice(11)});filter.onstop();
    await zs.queue;assert.deepEqual(seen,['{"text":"✓"}']);
});
test('detail response enriches an existing row and queues another save',async()=>{
    const {zs,tables,downloads}=harness();await zs.ready;
    let item={id:'123',caption:{text:'caption'},video_versions:[]};
    zs.register_module('Posts','instagram.com',()=>[item]);
    const parse=()=>zs.parse_request('{}','https://www.instagram.com/','https://www.instagram.com/graphql/query',2);
    await zs.enqueue(parse);
    item={id:'123',caption:null,video_versions:[{url:'https://example.com/video.mp4'}]};
    await zs.enqueue(parse);await Promise.all(zs.download_jobs.values());
    assert.equal(tables.items.rows.length,1);assert.equal(downloads.length,2);
    assert.equal(tables.items.rows[0].data.caption.text,'caption');
    assert.equal(tables.items.rows[0].data.video_versions.length,1);
});
