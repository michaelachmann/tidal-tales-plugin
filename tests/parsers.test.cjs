const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function load(name) {
    let registration;
    const context = {
        URL,
        zeeschuimer: {
            register_module(label, platform, callback) {
                registration = { label, platform, callback };
            }
        }
    };
    const filename = path.join(__dirname, '..', 'modules', `${name}.js`);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return registration;
}

test('Instagram extracts posts and reels while preserving raw metadata', () => {
    const module = load('instagram');
    assert.equal(module.platform, 'instagram.com');
    const response = JSON.stringify({ data: { edges: [
        { node: { id: 'p1', media_type: 1, user: { username: 'a' }, caption: { text: 'raw' } } },
        { node: { media: { id: 'r1', media_type: 2, product_type: 'clips', user: { username: 'b' }, video_versions: [{ url: 'v' }] } } }
    ] } });
    const result = module.callback(response, 'https://www.instagram.com/explore/', 'https://www.instagram.com/graphql/query');
    assert.deepEqual(Array.from(result, x => [x.id, x._tt_type]), [['p1', 'post'], ['r1', 'reel']]);
    assert.equal(result[0].caption.text, 'raw');
    assert.equal(result[1].video_versions[0].url, 'v');
});

test('Instagram extracts both story response shapes and inherits the reel user', () => {
    const module = load('instagram');
    const direct = { data: { xdt_api__v1__feed__reels_media: { reels_media: [
        { user: { username: 'alice' }, items: [{ pk: '10', image_versions2: { candidates: [{ url: 'image' }] } }] }
    ] } } };
    const connection = { data: { xdt_api__v1__feed__reels_media__connection: { edges: [
        { node: { user: { username: 'bob' }, items: [{ id: '11', video_versions: [{ url: 'video' }] }] } }
    ] } } };
    const a = module.callback(JSON.stringify(direct), 'https://instagram.com/stories/alice/', 'https://instagram.com/graphql/query');
    const b = module.callback(JSON.stringify(connection), 'https://instagram.com/stories/bob/', 'https://instagram.com/graphql/query');
    assert.deepEqual([a[0].id, a[0]._tt_type, a[0].user.username], ['10', 'story', 'alice']);
    assert.deepEqual([b[0].id, b[0]._tt_type, b[0].user.username], ['11', 'story', 'bob']);
});

test('TikTok extracts API, SIGI and universal payloads and filters live video', () => {
    const module = load('tiktok');
    assert.equal(module.platform, 'tiktok.com');
    const api = module.callback(JSON.stringify({ itemList: [{ id: '1', desc: 'x' }, { id: 'live', liveRoomInfo: {} }] }),
        'https://www.tiktok.com/@a', 'https://www.tiktok.com/api/post/item_list/');
    assert.deepEqual(Array.from(api, x => [x.id, x._tt_type]), [['1', 'video']]);

    const item = { id: '2', author: { uniqueId: 'a' }, video: { downloadAddr: 'video' } };
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
        __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: item } } }
    })}</script>`;
    const embedded = module.callback(html, 'https://www.tiktok.com/@a/video/2', 'https://www.tiktok.com/@a/video/2');
    assert.equal(embedded[0].video.downloadAddr, 'video');
    assert.equal(embedded[0]._tt_type, 'video');
});

test('parsers reject other domains and TikTok preload responses', () => {
    const instagram = load('instagram');
    const tiktok = load('tiktok');
    assert.equal(instagram.callback('{}', 'https://example.com/', 'https://example.com/api').length, 0);
    assert.equal(instagram.callback(JSON.stringify({ items: [{ id: '1', media_type: 1 }] }),
        'https://instagram.com/', 'https://example.com/late-response').length, 0);
    assert.equal(tiktok.callback(JSON.stringify({ itemList: [{ id: '1' }] }),
        'https://tiktok.com/', 'https://tiktok.com/api/preload/item_list/').length, 0);
});

test('Instagram uses pk as the stable partial-to-full identity', () => {
    const module = load('instagram');
    const partial = { id: '123_456', pk: '123', media_type: 2, product_type: 'clips' };
    const item = module.callback(JSON.stringify({ items: [partial] }),
        'https://instagram.com/user/reels/', 'https://instagram.com/graphql/query')[0];
    assert.equal(item.id, '123');
    assert.equal(item._tt_raw_id, '123_456');
    assert.equal(item._tt_type, 'reel');
});

test('Instagram parses legacy embeds and Graph media types', () => {
    const module = load('instagram');
    const graph = { id: 'g1', shortcode: 'short', __typename: 'GraphSidecar', owner: { username: 'alice' } };
    const html = `<script>window._sharedData = ${JSON.stringify({ entry_data: { PostPage: [{ graphql: { shortcode_media: graph }, items: [graph] }] } })};</script>`;
    const result = module.callback(html, 'https://instagram.com/p/short/', 'https://instagram.com/p/short/');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'g1');
    assert.equal(result[0]._tt_type, 'post');
});

test('Instagram parses serialized Comet responses and filters explicit shortcodes', () => {
    const module = load('instagram');
    const wrapped = { response: JSON.stringify({ items: [
        { shortcode: 'wanted', __typename: 'GraphVideo' },
        { shortcode: 'prefetched', __typename: 'GraphVideo' }
    ] }) };
    const html = `<script type="application/json">${JSON.stringify(wrapped)}</script>`;
    const result = module.callback(html, 'https://instagram.com/reels/wanted/', 'https://instagram.com/api/v1/media/info/');
    assert.deepEqual(Array.from(result, x => x.id), ['wanted']);
});

test('Instagram rejects private views and GraphQL prefetches on single-item views', () => {
    const module = load('instagram');
    const body = JSON.stringify({ items: [{ id: '1', media_type: 1 }] });
    assert.equal(module.callback(body, 'https://instagram.com/direct/inbox/', 'https://instagram.com/api/v1/feed/').length, 0);
    assert.equal(module.callback(body, 'https://instagram.com/p/code/', 'https://instagram.com/graphql/query').length, 0);
});

test('Instagram keeps carousel children attached to their parent', () => {
    const module = load('instagram');
    const parent = {
        id: 'parent', media_type: 8, user: { username: 'alice' },
        edge_sidecar_to_children: { edges: [
            { node: { id: 'child', __typename: 'GraphImage', shortcode: 'child-code' } }
        ] }
    };
    const result = module.callback(JSON.stringify({ items: [parent] }),
        'https://instagram.com/alice/', 'https://instagram.com/api/v1/feed/user/');
    assert.deepEqual(Array.from(result, x => x.id), ['parent']);
    assert.equal(result[0].edge_sidecar_to_children.edges[0].node.id, 'child');
});

test('Instagram handles known single-media keys', () => {
    const module = load('instagram');
    const result = module.callback(JSON.stringify({ graphql: {
        shortcode_media: { shortcode: 'single', __typename: 'GraphImage' }
    } }), 'https://instagram.com/p/single/', 'https://instagram.com/p/single/');
    assert.deepEqual(Array.from(result, x => x.id), ['single']);
});

test('Instagram scopes timeline and explore media lists to their views', () => {
    const module = load('instagram');
    const timeline = JSON.stringify({ xdt_api__v1__feed__timeline__connection: { edges: [
        { node: { media: { id: 'background', media_type: 1 } } }
    ] } });
    assert.equal(module.callback(timeline, 'https://instagram.com/alice/', 'https://instagram.com/api/feed').length, 0);

    const medias = JSON.stringify({ medias: [{ media: { id: 'explore', media_type: 1 } }] });
    assert.equal(module.callback(medias, 'https://instagram.com/alice/', 'https://instagram.com/api/feed').length, 0);
    assert.equal(module.callback(medias, 'https://instagram.com/explore/', 'https://instagram.com/api/feed').length, 1);
});

test('Instagram reels audio pages do not apply single-reel filtering', () => {
    const module = load('instagram');
    const result = module.callback(JSON.stringify({ items: [
        { id: '1', code: 'first', media_type: 2, product_type: 'clips' },
        { id: '2', code: 'second', media_type: 2, product_type: 'clips' }
    ] }), 'https://instagram.com/reels/audio/123/', 'https://instagram.com/api/v1/clips/music/');
    assert.deepEqual(Array.from(result, x => x.id), ['1', '2']);
});
