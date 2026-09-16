const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPopup(overrides = {}) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');
    const context = {
        console,
        document: { addEventListener() {} },
        setTimeout() {},
        URL,
        Blob,
        ...overrides
    };
    vm.createContext(context);
    vm.runInContext(`${source}\nthis.popupExports = {contentType, fileDetails, toExportRow, escapeCSV, summarizeItems, renderCaptureSettings, saveCaptureSettings};`, context);
    return context.popupExports;
}

test('exports only recorded local files as actual paths', () => {
    const { toExportRow } = loadPopup();
    const row = toExportRow({
        id: 7,
        item_id: '42',
        source_platform: 'tiktok.com',
        source_platform_url: 'https://www.tiktok.com/@alice/video/42',
        timestamp_collected: 1700000000000,
        download_status: 'partial',
        local_files: [
            { filename: 'tidaltales/tiktok/alice/42.json', type: 'metadata', status: 'complete' },
            { filename: 'tidaltales/tiktok/alice/42.mp4', type: 'video', status: 'interrupted', error: 'NETWORK_FAILED' }
        ],
        data: { id: '42', _tt_type: 'video', author: { uniqueId: 'alice' }, desc: 'hello' }
    });
    assert.equal(row.Platform, 'TikTok');
    assert.equal(row['Content Type'], 'TikTok video');
    assert.equal(row['JSON Paths'], 'tidaltales/tiktok/alice/42.json');
    assert.equal(row['Video Paths'], '');
    assert.equal(row['Download Errors'], 'tidaltales/tiktok/alice/42.mp4: NETWORK_FAILED');
    assert.equal(row['Legacy Expected Video Path'], '');
});

test('keeps old story paths separate and marks them unverified', () => {
    const { toExportRow } = loadPopup();
    const row = toExportRow({
        item_id: '99',
        source_platform: 'instagram.com',
        data: {
            pk: '99', expiring_at: 1700000000, user: { username: 'alice' },
            video_versions: [{ url: 'https://cdn.test/video.mp4' }]
        }
    });
    assert.equal(row['Content Type'], 'Story');
    assert.equal(row['Video Paths'], '');
    assert.equal(row['Legacy Expected Video Path'], 'tidaltales/alice/99.mp4');
    assert.equal(row['Download Status'], 'unknown (legacy paths unverified)');
});

test('maps Graph Instagram metadata and builds a canonical post URL', () => {
    const { toExportRow } = loadPopup();
    const row = toExportRow({
        item_id: 'internal-id',
        source_platform: 'instagram.com',
        source_platform_url: 'https://www.instagram.com/alice/',
        data: {
            _tt_type: 'post', shortcode: 'ABC123', taken_at_timestamp: 1700000000,
            owner: { id: '7', username: 'alice', is_verified: true },
            edge_media_to_caption: { edges: [{ node: { text: 'Graph caption' } }] },
            edge_media_preview_like: { count: 11 }, edge_media_preview_comment: { count: 4 }
        }
    });
    assert.equal(row.Username, 'alice');
    assert.equal(row.Caption, 'Graph caption');
    assert.equal(row.Likes, 11);
    assert.equal(row.Comments, 4);
    assert.equal(row.Permalink, 'https://www.instagram.com/p/ABC123/');
    assert.equal(row['Source Page URL'], 'https://www.instagram.com/alice/');
});

test('escapes CSV formulas, quotes and newlines', () => {
    const { escapeCSV } = loadPopup();
    assert.equal(escapeCSV('=SUM(1,2)\n"x"'), '"\'=SUM(1,2)\n""x"""');
});

test('collection counts include disabled modules and separate download issues', () => {
    const {summarizeItems} = loadPopup();
    const summary = summarizeItems([
        {source_platform:'instagram.com',data:{_tt_type:'story'},download_status:'complete'},
        {source_platform:'instagram.com',data:{_tt_type:'reel'},download_status:'pending'},
        {source_platform:'tiktok.com',data:{_tt_type:'video'},download_status:'partial'},
        {source_platform:'tiktok.com',data:{_tt_type:'post'}},
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
        total:4,counts:{stories:1,posts:0,reels:1,tiktok:2},downloads:{complete:1,pending:1,issues:1,unknown:1}
    });
});

function controlHarness(setCaptureSettings) {
    const elements = new Map();
    const document = {addEventListener(){},getElementById(id){
        if (!elements.has(id)) elements.set(id,{classList:{toggle(){}},textContent:'',disabled:false,checked:false});
        return elements.get(id);
    }};
    const popup = loadPopup({document,browser:{extension:{getBackgroundPage:()=>({zeeschuimer:{setCaptureSettings}})}}});
    return {popup,elements};
}
const allModules = {stories:true,posts:true,reels:true,tiktok:true};

test('pause preserves individual switch choices and resume action', () => {
    const {popup,elements}=controlHarness();
    popup.renderCaptureSettings({paused:true,modules:{...allModules,reels:false}});
    assert.equal(elements.get('capture-state').textContent,'Capture paused');
    assert.equal(elements.get('pause-capture').textContent,'Resume capture');
    assert.equal(elements.get('capture-reels').checked,false);
    assert.equal(elements.get('capture-stories').checked,true);
    popup.renderCaptureSettings({paused:false,modules:{stories:false,posts:false,reels:false,tiktok:false}});
    assert.equal(elements.get('capture-state').textContent,'All modules off');
    assert.equal(elements.get('pause-capture').disabled,true);
});

test('failed settings save restores confirmed settings and reports failure',async()=>{
    const {popup,elements}=controlHarness(async()=>{throw new Error('Disk unavailable');});
    popup.renderCaptureSettings({paused:false,modules:{...allModules}});
    await popup.saveCaptureSettings({modules:{tiktok:false}});
    assert.equal(elements.get('capture-tiktok').checked,true);
    assert.equal(elements.get('capture-tiktok').disabled,false);
    assert.equal(elements.get('status').textContent,'Disk unavailable');
});

test('capture switches are locked until their change is persisted',async()=>{
    let resolve;
    const {popup,elements}=controlHarness(()=>new Promise(r=>{resolve=r;}));
    popup.renderCaptureSettings({paused:false,modules:{...allModules}});
    const pending=popup.saveCaptureSettings({modules:{reels:false}});
    assert.equal(elements.get('capture-reels').disabled,true);
    resolve({paused:false,modules:{...allModules,reels:false}});
    await pending;
    assert.equal(elements.get('capture-reels').checked,false);
    assert.equal(elements.get('capture-reels').disabled,false);
});
