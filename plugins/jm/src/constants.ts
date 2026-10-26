export class Config {
  public static JM_VERSION = "2.0.20";
  public static JM_SECRET = "185Hcomic3PAPP7R";
  public static JM_CACHE_SCOPE = "JmComic";
  public static JM_HOSTCFG_AES_SEED = "diosfjckwpqpdfjkvnqQjsik";
  public static JM_SETTING_AES_SEEDS = [
    "185Hcomic3PAPP7R",
    "18comicAPPContent",
  ];
  public static JM_HOST_CONFIG_URLS = [
    "https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt",
    "https://rup4a04-c01.tos-ap-southeast-1.bytepluses.com/newsvr-2025.txt",
    "https://rup4a04-c03.tos-cn-beijing.bytepluses.com.cn/newsvr-2025.txt",
  ];
  public static JM_FALLBACK_API_BASE = "https://www.cdnhjk.net";
  public static JM_FALLBACK_IMAGE_BASE =
    "https://cdn-msp3.jmdanjonproxy.vip";

  /**
   * 移动端图片域名池（取自 jmcomic 官方配置 jm_config.py 的 DOMAIN_IMAGE_LIST）。
   * /setting 返回的 img_host 优先，这里作为备用线路。
   */
  public static JM_IMAGE_BASE_CANDIDATES = [
    "https://cdn-msp.jmapiproxy1.cc",
    "https://cdn-msp.jmapiproxy2.cc",
    "https://cdn-msp2.jmapiproxy2.cc",
    "https://cdn-msp3.jmapiproxy2.cc",
    "https://cdn-msp.jmapinodeudzn.net",
    "https://cdn-msp3.jmapinodeudzn.net",
  ];

  public static normalizeBaseUrl(url: unknown): string {
    const raw = String(url ?? "").trim();
    if (!raw) return "";
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return raw.replace(/\/+$/g, "");
    }
    return `https://${raw}`.replace(/\/+$/g, "");
  }

  /** img_host 优先，其后是内置备用池与兜底域名，去重后返回 */
  public static buildImageCandidates(primary?: unknown): string[] {
    const list = [
      Config.normalizeBaseUrl(primary),
      ...Config.JM_IMAGE_BASE_CANDIDATES,
      Config.JM_FALLBACK_IMAGE_BASE,
    ];
    return Array.from(new Set(list.filter(Boolean)));
  }

  public static baseUrlIndex = 0;

  public static baseUrls = [Config.JM_FALLBACK_API_BASE];

  public static get baseUrl(): string {
    return this.baseUrls[this.baseUrlIndex] ?? this.baseUrls[0] ?? "";
  }

  public static imagesUrlIndex = 0;

  public static imagesUrls = [Config.JM_FALLBACK_IMAGE_BASE];

  public static get imagesUrl(): string {
    return this.imagesUrls[this.imagesUrlIndex] ?? this.imagesUrls[0] ?? "";
  }
}
