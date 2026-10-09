import test from "node:test";
import assert from "node:assert/strict";
import { videoUrl, variantsOf, collectMedia, selectMedia, mp4Format } from "../extension/media-core.js";
const variant = (name, bitrate) => ({ content_type: "video/mp4", bitrate, url: `https://video.twimg.com/ext_tw_video/456/pu/vid/720x1280/${name}.mp4?tag=12` });
const make = (poster, type = "video") => ({ id_str: "456", type, media_url_https: `https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/${poster}.jpg`, video_info: { variants: [variant(poster + "-low", 200000), variant(poster + "-high", 900000), { url: "https://video.twimg.com/list.m3u8" }] } });

test("只允许真正的推特 MP4 地址，拒绝凭据、端口、其他服务器和 HLS", () => {
  assert.match(videoUrl(variant("abc", 0).url), /abc\.mp4/);
  for (const url of ["https://video.twimg.com.evil.test/a.mp4", "http://video.twimg.com/a.mp4", "https://u:p@video.twimg.com/a.mp4", "https://video.twimg.com:444/a.mp4", "blob:https://x.com/id", "https://video.twimg.com/a.m3u8"]) assert.throws(() => videoUrl(url));
  assert.deepEqual(variantsOf([{ url: "https://evil.test/a.mp4" }]), []);
});
test("GraphQL 媒体解析保留所属推文，最高码率优先，动图不会变成静态封面", () => {
  const items = collectMedia({ data: { result: { rest_id: "123", legacy: { extended_entities: { media: [make("one"), make("two", "animated_gif")] } } } } });
  assert.equal(items.length, 2);
  const selected = selectMedia(items, { tweetId: "123", poster: "https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/two.jpg?name=small" });
  assert.equal(selected.tweetId, "123");
  assert.equal(selected.type, "animated_gif");
  assert.match(selected.variants[0].url, /two-high/);
  assert.equal(selected.variants.length, 2);
});
test("公开嵌入数据和引用推文按封面定位，多个视频时不会猜第一个", () => {
  const items = collectMedia({ id_str: "123", mediaDetails: [make("one"), make("two")], quoted_tweet: { id_str: "321", mediaDetails: [make("quote")] } });
  assert.equal(selectMedia(items, { tweetId: "123", srcUrl: "blob:https://x.com/id" }), null);
  assert.equal(selectMedia(items, { tweetId: "123", poster: "https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/missing.jpg" }), null);
  assert.equal(selectMedia(items, { poster: make("quote").media_url_https }).tweetId, "321");
  assert.equal(selectMedia(items, { tweetId: "321" }).tweetId, "321");
});
test("兼容 syndication 顶层 video 和 promotional card JSON", () => {
  const items = collectMedia({ id_str: "123", video: { poster: make("one").media_url_https, variants: [variant("one", 1)] }, card: { string_value: JSON.stringify({ media_entities: { one: make("card") } }) } });
  assert.equal(items.length, 2);
  assert.equal(selectMedia(items, { poster: make("one").media_url_https }).tweetId, "123");
});
test("缺少类型字段时通过动图专用封面与 MP4 地址识别", () => {
  const byPoster = make("gif"); delete byPoster.type;
  byPoster.media_url_https = "https://pbs.twimg.com/tweet_video_thumb/example.jpg";
  const byUrl = make("gif2");
  byUrl.video_info.variants = [{ url: "https://video.twimg.com/tweet_video/example.mp4" }];
  for (const item of [byPoster, byUrl, { video: { type: "animated_gif", variants: [variant("one", 1)] } }]) {
    assert.equal(collectMedia(item)[0].type, "animated_gif");
  }
});
test("MP4 文件头验证拒绝网页、AVIF 和损坏的 box，兼容品牌也可识别", () => {
  const mp4 = Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex");
  assert.equal(mp4Format(mp4), "mp4");
  const compatible = Buffer.from(mp4); compatible.write("abcd", 8);
  assert.equal(mp4Format(compatible), "mp4");
  for (const bytes of [Buffer.from("<html>error</html>"), Buffer.from("00000010667479706176696600000000", "hex"), Buffer.from("000000006674797069736f6d00000000", "hex")]) assert.throws(() => mp4Format(bytes));
});
test("解析器处理循环引用并限制缓存返回数量", () => {
  const root = { rest_id: "123", media: Array.from({ length: 200 }, (_, i) => make("p" + i)) }; root.self = root;
  assert.equal(collectMedia(root).length, 100);
});
