/** Offline diagnostics only. Never used to rewrite or suppress product text.
 * These bounded checks supplement inspection of the complete raw reply. */
export function memorySaveReplyDiagnostics(answer: string) {
  const text = answer.replace(/\s+/gu, "");
  return {
    asksSaveConsentAgain:
      /(?:需要我|需不需要|要不要|是否|愿不愿意|愿意让我|想让我|要我帮你).{0,90}(?:记住|记下|保存|存下|提交)/u.test(
        text,
      ) ||
      /(?:记住|保存|存下|提交).{0,35}(?:吗[？?]|好不好|可以吗|行吗)/u.test(
        text,
      ),
    narratesConfirmation:
      /待确认|确认后.{0,20}(?:保存|存下)|提交确认|点(?:击)?.{0,12}(?:记住|确认)|你(?:说|回复).{0,15}(?:保存|确认)|(?:后台|程序|界面|候选).{0,45}(?:提取|确认|保存|登记|入库)|(?:提取|确认|保存|登记).{0,45}(?:后台|程序|界面|候选)/u.test(
        text,
      ),
    claimsUnconfirmedCommit:
      /(?:已经|已)(?:把[^。！？!?]{1,40})?(?:记住|保存|存下)(?!意愿|流程|请求)|保存好了|存好了|(?:我)?记住了|我会.{0,12}(?:一直|永久|牢牢)?记住/u.test(
        text,
      ),
  };
}
