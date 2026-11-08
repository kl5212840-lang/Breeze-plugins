import { BIKA_PLUGIN_ID } from "./identity";

// Local help shipped by the user-selected PicACG 2.5.85 IPA:
// showQADialog VM 0x34bbf0, pool 0x22518..0x22620. Links are not
// account/API endpoints. This function does not read configuration or fetch.
export function getOfficialHelpBundle() {
  return {
    source: BIKA_PLUGIN_ID,
    data: {
      version: 1,
      sections: [
        {
          id: "official", title: "官方信息", paragraphs: [],
          links: [
            { id: "announcements", label: "官方公告", kind: "web", value: "https://t.me/PicACG" },
            { id: "website", label: "官网", kind: "web", value: "https://picacomic.com" },
            { id: "email", label: "官方邮箱", kind: "email", value: "picapicacomic@gmail.com" },
          ],
        },
        {
          id: "free", title: "哔咔是否收费？",
          paragraphs: ["哔咔免费。不要向要求付款、助力或兜售账号的人转账。"], links: [],
        },
        {
          id: "loading", title: "加载问题",
          paragraphs: ["如出现加载不流畅，部分地区用户可能需要调整网络连接。"], links: [],
        },
        {
          id: "contact", title: "如何联系官方？",
          paragraphs: [
            "如有问题，请通过官方邮箱联系。商务合作请通过邮箱联系。",
            "其他官方联系与群组方式请查看 Telegram 公告。",
          ], links: [],
        },
        {
          id: "comments", title: "交流提醒",
          paragraphs: ["请勿发布个人联系方式或广告。请友好交流，尊重创作者。"], links: [],
        },
      ],
    },
  };
}
