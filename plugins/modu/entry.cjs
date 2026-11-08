'use strict';
// source.json is the only configuration; build-video.cjs injects it.
config.detailPath = id => `/vod/${id}/`;
config.webPlayback = (_id,_sid,_nid,url) => ['https://www.modujiexi66.com/?url='+url];
module.exports = createCmsVideoPlugin(config);
