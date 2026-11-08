(function () {
    var imageBase = 'https://as.cfhls.top/';
    var data = window.player_aaaa || {};
    var pic = String(MacPlayer.Pic || (data.vod_data || {}).vod_pic || '').replace(/^\s+|\s+$/g, '');
    var ph = imageBase;
    if (/^mac:\/\//i.test(pic)) {
        var bare = pic.replace(/^mac:\/\//i, '').replace(/^\/+/, '');
        var upload = bare.match(/(?:^|\/)upload\/.*$/i);
        pic = upload ? upload[0].replace(/^\/+/, '') : 'https://' + bare.replace(/^([^/]+)\/+/, '$1/');
    }
    if (/^\/\//.test(pic)) pic = 'https:' + pic;
    if (/^https?:\/\//i.test(pic)) ph = '';
    else pic = pic.replace(/^\/+/, '');
    if (!pic) ph = '';
    var values = {
        url: MacPlayer.PlayUrl || '',
        dmid: (window.d4ddy || {}).dmid || (window.dataflow || {}).dmid
            || (window.maccms || {}).dmid || MacPlayer.Id || data.id || '',
        next: MacPlayer.PlayLinkNext || '',
        name: MacPlayer.PlayName || (data.vod_data || {}).vod_name || '',
        sid: MacPlayer.Sid || data.sid || '',
        nid: MacPlayer.Nid || data.nid || '',
        ph: ph,
        h: window.location.origin,
        pic: pic
    };
    var pairs = [];
    for (var key in values) {
        if (Object.prototype.hasOwnProperty.call(values, key)) pairs.push(key + '=' + encodeURIComponent(String(values[key])));
    }
    MacPlayer.Html = '<iframe width="100%" height="100%" src="https://art.v2player.top:8989/player/?'
        + pairs.join('&amp;') + '" frameborder="0" scrolling="no" allow="autoplay; fullscreen; picture-in-picture"'
        + ' allowfullscreen="allowfullscreen" sandbox="allow-same-origin allow-forms allow-scripts allow-popups allow-top-navigation"></iframe>';
    MacPlayer.Show();
}());
