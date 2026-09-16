const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function harness(options={}) {
    const tables = options.tables || {};
    function table(name) {
        const rows = tables[name] ? tables[name].rows : [];
        return {rows, async get(key) { return rows.find(r => r.key === key); },
            async put(row) { if(options.failSettingsPut && name==='settings' && row.key==='capture-settings') throw new Error('write failed');
                const i=rows.findIndex(r=>r.key===row.key); if(i<0) rows.push(row); else rows[i]=row; },
            async add(row) { const id=rows.length+1; rows.push({...row,id}); return id; },
            async update(id, values) { Object.assign(rows.find(r=>r.id===id)||{}, values); },
            async clear() { rows.length=0; },
            toCollection() { return {async modify(fn) { rows.forEach(fn); }}; },
            where(query) { let predicate=r=>Object.entries(query).every(([k,v])=>r[k]===v); return {
                filter(fn) { const prev=predicate; predicate=r=>prev(r)&&fn(r); return this; },
                async first() { if(options.beforeFirst) await options.beforeFirst(name); return rows.find(predicate); }
            }; }
        };
    }
    class Dexie { constructor() { for(const name of ['items','nav','settings']) this[name]=tables[name]=table(name); }
        version(){return {stores(){}};} async transaction(...args){ return args.at(-1)(); } }
    let filter, beforeRequestListener;
    const downloads=[];
    const context={Dexie, console, navigator:{userAgent:'test'}, TextDecoder, URL,
        tidalStorage:{async save(row){downloads.push(row);return {download_status:'complete',local_files:[]};}},
        browser:{tabs:{get:async()=>({url:'https://www.instagram.com/'}),onRemoved:{addListener(){}}},
            webRequest:{onBeforeRequest:{addListener(callback){beforeRequestListener=callback;}},filterResponseData(){return filter={write(){},disconnect(){this.disconnected=true;}};}},
            webNavigation:{onCommitted:{addListener(){}}}}};
    context.window=context; vm.createContext(context);
    vm.runInContext(fs.readFileSync('js/zs-background.js','utf8'),context);
    return {zs:context.zeeschuimer,tables,downloads,context,getFilter:()=>filter,
        getBeforeRequestListener:()=>beforeRequestListener};
}
test('navigation index increments and ignores subframes',async()=>{
    const {zs,tables}=harness(); await zs.ready;
    await zs.nav_handler({tabId:2,frameId:0}); await zs.nav_handler({tabId:2,frameId:0});
    await zs.nav_handler({tabId:2,frameId:3}); assert.equal(tables.nav.rows[0].index,1);
});
test('concurrent responses deduplicate IDs per platform without dropping later modules',async()=>{
    const {zs,tables,downloads}=harness();await zs.ready;
    zs.register_module('Instagram','instagram.com',()=>[{id:'123',_tt_type:'post'}]);
    zs.register_module('TikTok','tiktok.com',()=>[{id:'123',_tt_type:'video'}]);
    const parse=()=>zs.parse_request('{}','https://www.instagram.com/','https://www.instagram.com/graphql/query',2);
    await Promise.all([zs.enqueue(parse),zs.enqueue(parse)]);
    assert.equal(tables.items.rows.length,2);assert.equal(downloads.length,2);
    assert.equal(tables.items.rows[0].item_id,'123');
});
test('response is forwarded and disconnected before asynchronous parsing',async()=>{
    const {zs,getFilter,getBeforeRequestListener}=harness();await zs.ready;
    const seen=[];zs.parse_request=async response=>{assert.equal(getFilter().disconnected,true);seen.push(response);};
    getBeforeRequestListener()({requestId:'1',tabId:1,url:'https://www.tiktok.com/'});
    const filter=getFilter();const data=new TextEncoder().encode('{"text":"✓"}');
    filter.ondata({data:data.slice(0,11)});filter.ondata({data:data.slice(11)});filter.onstop();
    await zs.queue;assert.deepEqual(seen,['{"text":"✓"}']);
});
test('detail response enriches an existing row and queues another save',async()=>{
    const {zs,tables,downloads}=harness();await zs.ready;
    let item={id:'123',_tt_type:'post',caption:{text:'caption'},video_versions:[]};
    zs.register_module('Posts','instagram.com',()=>[item]);
    const parse=()=>zs.parse_request('{}','https://www.instagram.com/','https://www.instagram.com/graphql/query',2);
    await zs.enqueue(parse);
    item={id:'123',_tt_type:'post',caption:null,video_versions:[{url:'https://example.com/video.mp4'}]};
    await zs.enqueue(parse);await Promise.all(zs.download_jobs.values());
    assert.equal(tables.items.rows.length,1);assert.equal(downloads.length,2);
    assert.equal(tables.items.rows[0].data.caption.text,'caption');
    assert.equal(tables.items.rows[0].data.video_versions.length,1);
});

test('capture settings default on, merge partial updates, and survive restart',async()=>{
    const first=harness();await first.zs.ready;
    assert.deepEqual(JSON.parse(JSON.stringify(await first.zs.getCaptureSettings())), {
        paused:false,modules:{stories:true,posts:true,reels:true,tiktok:true}
    });
    await first.zs.setCaptureSettings({modules:{reels:false}});
    const second=harness({tables:first.tables});await second.zs.ready;
    assert.deepEqual(JSON.parse(JSON.stringify(await second.zs.getCaptureSettings())), {
        paused:false,modules:{stories:true,posts:true,reels:false,tiktok:true}
    });
});

test('Instagram item switches filter parser results before storage and downloads',async()=>{
    const {zs,tables,downloads}=harness();await zs.ready;
    await zs.setCaptureSettings({modules:{stories:false,reels:false}});
    zs.register_module('Instagram','instagram.com',()=>[
        {id:'story',_tt_type:'story'},{id:'post',_tt_type:'post'},{id:'reel',_tt_type:'reel'}
    ]);
    await zs.parse_request('{}','https://www.instagram.com/','https://www.instagram.com/graphql/query',2);
    assert.deepEqual(tables.items.rows.map(row=>row.item_id),['post']);
    assert.equal(downloads.length,1);
});

test('fully disabled platforms skip parsing and downloads',async()=>{
    const {zs,tables,downloads}=harness();await zs.ready;
    await zs.setCaptureSettings({modules:{tiktok:false}});
    let calls=0;zs.register_module('TikTok','tiktok.com',()=>{calls++;return [{id:'1',_tt_type:'video'}];});
    await zs.parse_request('{}','https://www.tiktok.com/','https://www.tiktok.com/api/item/detail',2);
    assert.equal(calls,0);assert.equal(tables.items.rows.length,0);assert.equal(downloads.length,0);
});

test('failed settings persistence does not change the active settings',async()=>{
    const {zs}=harness({failSettingsPut:true});await zs.ready;
    await assert.rejects(zs.setCaptureSettings({paused:true}),/write failed/);
    assert.equal((await zs.getCaptureSettings()).paused,false);
});

test('capture is rechecked after an asynchronous duplicate lookup',async()=>{
    let reachedLookup, releaseLookup;
    const lookupStarted=new Promise(resolve=>{reachedLookup=resolve;});
    const lookupReleased=new Promise(resolve=>{releaseLookup=resolve;});
    let blockItems=true;
    const {zs,tables,downloads}=harness({beforeFirst:async name=>{
        if(name==='items' && blockItems){blockItems=false;reachedLookup();await lookupReleased;}
    }});await zs.ready;
    zs.register_module('TikTok','tiktok.com',()=>[{id:'1',_tt_type:'video'}]);
    const capture=zs.parse_request('{}','https://www.tiktok.com/','https://www.tiktok.com/api/item/detail',2);
    await lookupStarted;
    await zs.setCaptureSettings({modules:{tiktok:false}});releaseLookup();await capture;
    assert.equal(tables.items.rows.length,0);assert.equal(downloads.length,0);
});

test('capture settings reject inherited module names',async()=>{
    const {zs}=harness();await zs.ready;
    await assert.rejects(zs.setCaptureSettings({modules:{toString:false}}),/Invalid capture module setting/);
});

test('pause and revision changes only allow future responses after resume',async()=>{
    const {zs,tables,getFilter}=harness();await zs.ready;
    zs.register_module('TikTok','tiktok.com',()=>[{id:'1',_tt_type:'video'}]);
    await zs.setCaptureSettings({paused:true});
    zs.listener({requestId:'paused',tabId:1,url:'https://www.tiktok.com/api/item/detail'});
    assert.equal(getFilter(),undefined);
    await zs.setCaptureSettings({paused:false});
    zs.listener({requestId:'in-flight',tabId:1,url:'https://www.tiktok.com/api/item/detail'});
    const staleFilter=getFilter();staleFilter.ondata({data:new TextEncoder().encode('{}')});
    await zs.setCaptureSettings({modules:{tiktok:false}});
    await zs.setCaptureSettings({modules:{tiktok:true}});
    staleFilter.onstop();await zs.queue;
    assert.equal(tables.items.rows.length,0);
    zs.listener({requestId:'fresh',tabId:1,url:'https://www.tiktok.com/api/item/detail'});
    const freshFilter=getFilter();freshFilter.ondata({data:new TextEncoder().encode('{}')});freshFilter.onstop();await zs.queue;
    assert.equal(tables.items.rows.length,1);
});
