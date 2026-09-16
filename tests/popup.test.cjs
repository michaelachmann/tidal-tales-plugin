const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPopup() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');
    const context = {
        console,
        document: { addEventListener() {} },
        setTimeout() {},
        URL,
        Blob
    };
    vm.createContext(context);
    vm.runInContext(`${source}\nthis.popupExports = {contentType, fileDetails, toExportRow, escapeCSV};`, context);
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
