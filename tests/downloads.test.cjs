const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '../js/local-storage.js'), 'utf8');

function load(downloadsApi = {}, timeoutMs) {
    const revoked = [];
    const context = {
        console,
        Blob,
        URL: class extends URL {},
        setTimeout,
        clearTimeout,
        browser: { downloads: downloadsApi }
    };
    context.URL.createObjectURL = () => 'blob:test';
    context.URL.revokeObjectURL = url => revoked.push(url);
    context.window = context;
    if (timeoutMs) context.TIDAL_DOWNLOAD_TIMEOUT_MS = timeoutMs;
    vm.runInNewContext(source, context);
    return { storage: context.tidalStorage, revoked };
}

test('plans Instagram carousel media with safe, stable paths', () => {
    const { storage } = load();
    const files = storage.plan({ source_platform: 'instagram.com', data: {
        pk: '12/../34', user: { username: '../alice/bob' }, carousel_media: [
            { image_versions2: { candidates: [{ url: 'https://cdn.test/a.jpg?x=1' }] } },
            { video_versions: [{ url: 'https://cdn.test/b.mp4?x=1' }] }
        ]
    }});
    assert.deepEqual(Array.from(files, f => f.filename), [
        'tidaltales/instagram/_alice_bob/12_.._34.json',
        'tidaltales/instagram/_alice_bob/12_.._34_1.jpg',
        'tidaltales/instagram/_alice_bob/12_.._34_2.mp4'
    ]);
});

test('preserves the legacy story directory and plans both metadata and media', () => {
    const { storage } = load();
    const files = storage.plan({ source_platform: 'instagram.com', data: {
        pk: '99', expiring_at: 1, user: { username: 'alice' }, video_versions: [{ url: 'https://cdn.test/v.mp4' }]
    }});
    assert.deepEqual(Array.from(files, f => f.filename), ['tidaltales/alice/99.json', 'tidaltales/alice/99.mp4']);
});

test('uses parser story marker for the legacy story directory', () => {
    const { storage } = load();
    const files = storage.plan({ source_platform: 'instagram.com', data: {
        pk: '100', _tt_type: 'story', user: { username: 'alice' },
        image_versions2: { candidates: [{ url: 'https://cdn.test/i.jpg' }] }
    }});
    assert.equal(files[0].filename, 'tidaltales/alice/100.json');
});

test('understands TikTok address objects and image posts', () => {
    const { storage } = load();
    const files = storage.plan({ source_platform: 'tiktok.com', data: {
        id: '42', author: { uniqueId: 'creator' },
        video: { downloadAddr: { urlList: ['https://cdn.test/video'] } },
        imagePost: { images: [{ displayImage: { urlList: ['https://cdn.test/image.webp'] } }] }
    }});
    assert.deepEqual(Array.from(files, f => f.filename), [
        'tidaltales/tiktok/creator/42.json',
        'tidaltales/tiktok/creator/42.mp4',
        'tidaltales/tiktok/creator/42_1.webp'
    ]);
});

test('supports Graph sidecars, owners, resources, and video thumbnails', () => {
    const { storage } = load();
    const files = storage.plan({ source_platform: 'instagram.com', data: {
        id: 'abc', owner: { username: 'graph-user' }, edge_sidecar_to_children: { edges: [
            { node: { display_resources: [{ src: 'https://cdn.test/s.jpg' }, { src: 'https://cdn.test/large.jpg' }] } },
            { node: { is_video: true, video_url: 'https://cdn.test/v.mp4', display_url: 'https://cdn.test/thumb.jpg' } }
        ] }
    }});
    assert.deepEqual(Array.from(files, f => f.filename), [
        'tidaltales/instagram/graph-user/abc.json',
        'tidaltales/instagram/graph-user/abc_1.jpg',
        'tidaltales/instagram/graph-user/abc_2.mp4',
        'tidaltales/instagram/graph-user/abc_2.jpg'
    ]);
});

test('waits for terminal state, serializes downloads, and revokes blob URLs', async () => {
    const listeners = new Set();
    let active = 0;
    let maxActive = 0;
    let id = 0;
    const api = {
        search: async query => query.id ? [{ id: query.id, state: 'in_progress' }] : [],
        download: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            const next = ++id;
            setTimeout(() => {
                active -= 1;
                for (const listener of listeners) listener({ id: next, state: { current: 'complete' } });
            }, 5);
            return next;
        },
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
    };
    const { storage, revoked } = load(api);
    const result = await storage.save({ source_platform: 'instagram.com', data: {
        pk: '1', user: { username: 'a' }, image_versions2: { candidates: [{ url: 'https://cdn.test/a.jpg' }] }
    }});
    assert.equal(result.download_status, 'complete');
    assert.deepEqual(Array.from(result.local_files, f => f.status), ['complete', 'complete']);
    assert.equal(maxActive, 1);
    assert.deepEqual(revoked, ['blob:test']);
});

test('only accepts an exact completed filename and reports interruption', async () => {
    const listeners = new Set();
    const api = {
        search: async query => query.id ? [{ id: query.id, state: 'in_progress' }] : [
            { filename: '/Downloads/tidaltales/instagram/a/10.json.bak', state: 'complete', exists: true }
        ],
        download: async () => {
            setTimeout(() => {
                for (const listener of listeners) listener({ id: 7, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
            }, 1);
            return 7;
        },
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
    };
    const { storage, revoked } = load(api);
    const result = await storage.save({ source_platform: 'instagram.com', data: {
        pk: '10', user: { username: 'a' }, image_versions2: { candidates: [{ url: 'https://cdn.test/a.jpg' }] }
    }});
    assert.equal(result.download_status, 'failed');
    assert.equal(result.local_files[0].status, 'interrupted');
    assert.equal(result.local_files[0].error, 'NETWORK_FAILED');
    assert.equal(result.local_files[1].status, 'interrupted');
    assert.deepEqual(revoked, ['blob:test']);
});

test('refreshes metadata while deduplicating already-saved media', async () => {
    const listeners = new Set();
    const started = [];
    let id = 0;
    const api = {
        search: async query => query.id ? [{ id: query.id, state: 'in_progress' }] : [
            { filename: `/Downloads/${query.query[0]}`, state: 'complete', exists: true }
        ],
        download: async options => {
            started.push(options.filename);
            const next = ++id;
            setTimeout(() => {
                for (const listener of listeners) listener({ id: next, state: { current: 'complete' } });
            }, 1);
            return next;
        },
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
    };
    const { storage } = load(api);
    const row = { source_platform: 'instagram.com', data: {
        pk: '10', user: { username: 'a' }, image_versions2: { candidates: [{ url: 'https://cdn.test/a.jpg' }] }
    }};
    await storage.save(row);
    await storage.save(row);
    assert.deepEqual(started, [
        'tidaltales/instagram/a/10.json',
        'tidaltales/instagram/a/10.json'
    ]);
});

test('marks partial video captures as missing instead of complete', async () => {
    const listeners = new Set();
    const api = {
        search: async query => query.id ? [{ id: query.id, state: 'in_progress' }] : [],
        download: async () => {
            setTimeout(() => { for (const fn of listeners) fn({ id: 1, state: { current: 'complete' } }); }, 1);
            return 1;
        },
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
    };
    const { storage } = load(api);
    const result = await storage.save({ source_platform: 'instagram.com', data: {
        id: 'partial', owner: { username: 'a' }, is_video: true, display_url: 'https://cdn.test/thumb.jpg'
    }});
    assert.equal(result.download_status, 'partial');
    assert.equal(result.local_files.at(-1).status, 'missing');
});

test('rejects non-http media before calling downloads.download', async () => {
    let calls = 0;
    const listeners = new Set();
    const api = {
        search: async query => query.id ? [{ id: query.id, state: 'in_progress' }] : [],
        download: async options => {
            calls += 1;
            setTimeout(() => { for (const fn of listeners) fn({ id: calls, state: { current: 'complete' } }); }, 1);
            return calls;
        },
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
    };
    const { storage } = load(api);
    const result = await storage.save({ source_platform: 'instagram.com', data: {
        id: 'bad', owner: { username: 'a' }, display_url: 'file:///etc/passwd'
    }});
    assert.equal(calls, 1); // metadata only
    assert.equal(result.local_files[1].status, 'error');
});

test('cancels a timed-out download before advancing the queue', async () => {
    const listeners = new Set();
    const calls = [];
    let next = 0;
    const api = {
        search: async query => query.id ? [{ id: query.id, state: 'in_progress' }] : [],
        download: async options => {
            const id = ++next;
            calls.push(`start:${options.filename}`);
            if (id !== 1) setTimeout(() => { for (const fn of listeners) fn({ id, state: { current: 'complete' } }); }, 1);
            return id;
        },
        cancel: async id => calls.push(`cancel:${id}`),
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
    };
    const { storage } = load(api, 5);
    const result = await storage.save({ source_platform: 'instagram.com', data: {
        id: 'timeout', owner: { username: 'a' }, display_url: 'https://cdn.test/a.jpg'
    }});
    assert.equal(result.local_files[0].status, 'timeout');
    assert.equal(calls[1], 'cancel:1');
    assert.match(calls[2], /^start:/);
});
test('missing Polaris video and image URLs are explicit missing files', () => {
    const {storage} = load();
    for (const typename of ['XIGPolarisVideoMedia', 'XIGPolarisPhotoMedia']) {
        const files = storage.plan({source_platform:'instagram.com', data:{id:'1',__typename:typename,user:{username:' .alice. '}}});
        assert.equal(files[1].missing,true);
        assert.equal(files[1].type,typename.includes('Video')?'video':'image');
        assert.ok(files[0].filename.includes('/alice/'));
    }
});

test('TikTok media includes its origin referrer; metadata and Instagram do not', async () => {
    const calls = [];
    const api = {
        search: async query => query.id ? [{state:'complete', mime:'video/mp4'}] : [],
        download: async options => { calls.push(options); return calls.length; }
    };
    const {storage} = load(api);
    const signedURL = 'https://v16-webapp-prime.tiktok.com/video/test/?signature=preserve%2Bexact&expire=123';
    await storage.save({source_platform:'tiktok.com', source_platform_url:'https://www.tiktok.com/@test?private=value', data:{
        id:'test', author:{uniqueId:'test'}, video:{playAddr:signedURL,cover:'https://cdn.test/cover.jpg'}
    }});
    assert.equal(calls[0].headers,undefined);
    assert.equal(calls[1].url,signedURL);
    for (const call of calls.slice(1)) {
        assert.deepEqual(JSON.parse(JSON.stringify(call.headers)),[{name:'Referer',value:'https://www.tiktok.com/'}]);
    }
    calls.length=0;
    await storage.save({source_platform:'instagram.com',data:{id:'ig',display_url:'https://cdn.test/ig.jpg'}});
    assert.ok(calls.every(call => call.headers === undefined));
});

test('completed HTML denial pages are errors and never reused as existing media', async () => {
    const calls=[];
    const api={
        search: async query => query.id
            ? [{state:'complete',mime:'text/html; charset=utf-8'}]
            : [{state:'complete',exists:true,filename:'/Downloads/tidaltales/tiktok/test/denied.mp4',mime:'text/html'}],
        download: async options => { calls.push(options); return calls.length; }
    };
    const {storage}=load(api);
    const result=await storage.save({source_platform:'tiktok.com',data:{id:'denied',author:'test',video:{playAddr:'https://cdn.test/v.mp4'}}});
    assert.equal(calls.length,2);
    assert.equal(result.local_files[0].status,'complete');
    assert.equal(result.local_files[1].status,'error');
    assert.match(result.local_files[1].error,/instead of media/);
    assert.equal(result.download_status,'partial');
});

test('binary MIME responses remain valid media downloads', async () => {
    const api={search:async q=>q.id?[{state:'complete',mime:'application/octet-stream'}]:[],download:async()=>1};
    const {storage}=load(api);
    const result=await storage.save({source_platform:'tiktok.com',data:{id:'binary',video:{playAddr:'https://cdn.test/v'}}});
    assert.equal(result.download_status,'complete');
});
