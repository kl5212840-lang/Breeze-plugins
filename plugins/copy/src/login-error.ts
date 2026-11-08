/** Only a bounded public reason is allowed across the login/runtime boundary. */
export function safeCopyLoginReason(data: unknown, secrets: string[]): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const value = (data as Record<string, unknown>).message;
  if (typeof value !== "string") return "";
  const message = value.trim();
  if (!message || message.length > 160 || /[\r\n{}<>]|\[bundle:|\[stack-hook\]|\bargs\s*:/i.test(message)) return "";
  let reason = message;
  for (const secret of secrets.filter(Boolean)) reason = reason.split(secret).join("");
  if (/invalid credentials|(?:invalid|incorrect) (?:email or password|username or password)|(?:账号|帳號|賬號|用户名|用戶名).{0,15}(?:密码|密碼).{0,10}(?:错误|錯誤|不匹配|不正确)/i.test(reason)) {
    return "账号或密码不匹配";
  }
  if (/(官网|官網).{0,20}更新.{0,20}(app|客户端|客戶端)/i.test(reason)) return "站点限制当前客户端访问";
  if (reason !== message || /https?:\/\/|(?:password|token|authorization|cookie|username|account)\s*[=:]|bearer\s+|[/\\]/i.test(message)) return "";
  return message;
}
